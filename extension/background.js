// Tresor Auto-Fill — Hintergrundskript
// Gemeinsam für Chrome (service_worker) und Firefox (background.scripts) genutzt.
// Klassisches Skript, kein ES-Modul — keine import/export-Anweisungen.

const ext = typeof browser !== 'undefined' ? browser : chrome;

// Wird beim Start des Servers durch dessen Adresse (PUBLIC_URL) ersetzt; leer = im Popup eintragen
const DEFAULT_VAULT_URL = '__PORTAL_URL__'.startsWith('__') ? '' : '__PORTAL_URL__';

// Gleicher Wert wie INACTIVITY_LOGOUT_MS in web/index.html.
const SESSION_TTL_MS = 15 * 60 * 1000;

// Zwischenspeicher der zuletzt geladenen Einträge. Kann nach einem Neustart
// des Service Workers leer sein — findEntry() lädt in dem Fall frisch nach.
let lastEntries = null;

/* ---------- Storage-Helfer ---------- */

async function getSettings() {
  const settings = await ext.storage.local.get({
    vaultUrl: DEFAULT_VAULT_URL,
    token: null,
    username: null,
    lastActivity: null
  });
  return settings;
}

async function setSettings(partial) {
  return ext.storage.local.set(partial);
}

/* ---------- Hilfsfunktionen ---------- */

// Identische Logik wie im Haupt-Tresor (web/index.html, hostnameOf).
function hostnameOf(urlString) {
  try {
    return new URL(urlString).hostname.replace(/^www\./, '');
  } catch {
    return urlString;
  }
}

// Exakte Hostname-Übereinstimmung, keine Subdomain-Toleranz.
function matchEntries(entries, tabUrl) {
  const tabHost = hostnameOf(tabUrl || '');
  if (!tabHost) return [];
  return entries.filter((entry) => entry.url && hostnameOf(entry.url) === tabHost);
}

function originPatternOf(urlString) {
  try {
    return `${new URL(urlString).origin}/*`;
  } catch {
    return null;
  }
}

/* ---------- TOTP (RFC 4226/6238) — 1:1 identisch zu web/index.html ---------- */

function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input || '').toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const char of clean) {
    const idx = alphabet.indexOf(char);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return new Uint8Array(bytes);
}

async function totpCode(secretBase32, stepSeconds = 30, digits = 6) {
  const counter = Math.floor(Date.now() / 1000 / stepSeconds);
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter % (2 ** 32));

  const key = await crypto.subtle.importKey(
    'raw',
    base32Decode(secretBase32),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buffer));
  const offset = sig[sig.length - 1] & 0xf;
  const code = (
    ((sig[offset] & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) << 8) |
    (sig[offset + 3] & 0xff)
  ) % (10 ** digits);
  return String(code).padStart(digits, '0');
}

/* ---------- Backend-Zugriff ---------- */

async function login(username, password) {
  const { vaultUrl } = await getSettings();

  let response;
  try {
    response = await fetch(`${vaultUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
  } catch (err) {
    return { ok: false, error: `Tresor unter ${vaultUrl} nicht erreichbar: ${err.message}` };
  }

  let data = {};
  try {
    data = await response.json();
  } catch {
    // Kein/kein gültiger JSON-Body — data bleibt {}
  }

  if (!response.ok) {
    return { ok: false, error: data.error || `Anmeldung fehlgeschlagen (Status ${response.status}).` };
  }

  await setSettings({ token: data.token, username, lastActivity: Date.now() });
  return { ok: true, user: data.user };
}

async function fetchEntries() {
  const { vaultUrl, token, lastActivity } = await getSettings();

  if (!token) {
    return { ok: false, needsLogin: true, error: 'Nicht angemeldet.' };
  }

  if (!lastActivity || Date.now() - lastActivity > SESSION_TTL_MS) {
    await setSettings({ token: null, lastActivity: null });
    lastEntries = null;
    return {
      ok: false,
      needsLogin: true,
      sessionExpired: true,
      error: 'Sitzung nach 15 Minuten Inaktivität abgelaufen. Bitte Passwort erneut eingeben.'
    };
  }

  // Gleitendes Zeitfenster: jede erfolgreiche Nutzung verlängert die Sitzung erneut um 15 Minuten.
  await setSettings({ lastActivity: Date.now() });

  const originPattern = originPatternOf(vaultUrl);
  if (!originPattern) {
    return { ok: false, error: `Tresor-Adresse ist ungültig: "${vaultUrl}".` };
  }

  const hasPermission = await ext.permissions.contains({ origins: [originPattern] });
  if (!hasPermission) {
    return {
      ok: false,
      needsPermission: true,
      origin: originPattern,
      error: `Zugriff auf ${vaultUrl} wurde noch nicht erlaubt.`
    };
  }

  let response;
  try {
    response = await fetch(`${vaultUrl}/api/passwords`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (err) {
    return { ok: false, error: `Tresor unter ${vaultUrl} nicht erreichbar: ${err.message}` };
  }

  if (response.status === 401) {
    await setSettings({ token: null });
    lastEntries = null;
    return { ok: false, needsLogin: true, error: 'Sitzung abgelaufen. Bitte erneut anmelden.' };
  }

  if (!response.ok) {
    return { ok: false, error: `Einträge konnten nicht geladen werden (Status ${response.status}).` };
  }

  let entries;
  try {
    entries = await response.json();
  } catch (err) {
    return { ok: false, error: `Antwort des Tresors war ungültig: ${err.message}` };
  }

  lastEntries = entries;
  return { ok: true, entries };
}

async function findEntry(entryId) {
  if (lastEntries) {
    const cached = lastEntries.find((entry) => entry.id === entryId);
    if (cached) return cached;
  }
  const result = await fetchEntries();
  if (!result.ok) return null;
  return result.entries.find((entry) => entry.id === entryId) || null;
}

/* ---------- Ausfüll-Funktion (läuft im Kontext der Zielseite) ----------
   Wird 1:1 als `func` an ext.scripting.executeScript übergeben — daher
   komplett eigenständig, ohne Zugriff auf äußere Closures/Variablen. */
function fillCredentialsInPage(username, password, totp) {
  function isVisible(el) {
    return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  }
  function setValue(el, value) {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.style.outline = '2px solid #6A46F5';
    setTimeout(() => { el.style.outline = ''; }, 600);
  }

  const result = { filledUsername: false, filledPassword: false, filledTotp: false };

  const passwordField = Array.from(
    document.querySelectorAll('input[type="password"]:not([disabled])')
  ).find(isVisible);
  if (!passwordField) return result;

  setValue(passwordField, password);
  result.filledPassword = true;

  const scope = passwordField.form || document;
  const scopedInputs = Array.from(scope.querySelectorAll('input'));
  const passwordIndex = scopedInputs.indexOf(passwordField);
  const candidates = passwordIndex >= 0 ? scopedInputs.slice(0, passwordIndex) : [];

  const usernameField = candidates.find((input) => {
    const type = (input.type || '').toLowerCase();
    if (type === 'text' || type === 'email') return true;
    const autocomplete = (input.getAttribute('autocomplete') || '').toLowerCase();
    if (autocomplete.includes('username') || autocomplete.includes('email')) return true;
    const nameId = `${input.name || ''} ${input.id || ''}`;
    return /user|email|login/i.test(nameId);
  });

  if (usernameField) {
    setValue(usernameField, username);
    result.filledUsername = true;
  }

  if (totp) {
    const totpField = scope.querySelector('input[autocomplete="one-time-code"]');
    if (totpField) {
      setValue(totpField, totp);
      result.filledTotp = true;
    }
  }

  const submitButtons = scope.querySelectorAll('button[type="submit"], input[type="submit"]');
  if (submitButtons.length === 1 && typeof submitButtons[0].focus === 'function') {
    submitButtons[0].focus();
  }

  return result;
}

async function runFill(tabId, entry) {
  let totp = '';
  if (entry.totp_secret) {
    try {
      totp = await totpCode(entry.totp_secret);
    } catch {
      totp = '';
    }
  }

  try {
    const injectionResults = await ext.scripting.executeScript({
      target: { tabId },
      func: fillCredentialsInPage,
      args: [entry.username || '', entry.password || '', totp]
    });
    const result = injectionResults && injectionResults[0] && injectionResults[0].result;
    return { ok: true, result: result || { filledUsername: false, filledPassword: false, filledTotp: false } };
  } catch (err) {
    return { ok: false, error: `Ausfüllen auf dieser Seite fehlgeschlagen: ${err.message}` };
  }
}

/* ---------- Tastenkombination (Strg/Cmd+Umschalt+L) ---------- */

async function tryOpenPopupOrNotify(message) {
  try {
    if (ext.action && typeof ext.action.openPopup === 'function') {
      await ext.action.openPopup();
      return;
    }
  } catch {
    // openPopup() nicht verfügbar/erlaubt (z.B. ältere Chrome-Version) — Fallback unten.
  }

  try {
    const hasNotifications = await ext.permissions.contains({ permissions: ['notifications'] });
    if (hasNotifications && ext.notifications) {
      await ext.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: '__PORTAL_NAME__ Tresor',
        message
      });
    }
  } catch {
    // Best effort, kein Blocker.
  }
}

if (ext.commands && ext.commands.onCommand) {
  ext.commands.onCommand.addListener(async (command) => {
    if (command !== 'fill-login') return;

    const tabs = await ext.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !tab.id || !tab.url) return;

    const result = await fetchEntries();
    if (!result.ok) {
      await tryOpenPopupOrNotify('Bitte Popup öffnen: Anmeldung oder Zugriffsfreigabe nötig.');
      return;
    }

    const matches = matchEntries(result.entries, tab.url);
    if (matches.length === 0) {
      await tryOpenPopupOrNotify('Kein passender Eintrag für diese Seite gefunden.');
      return;
    }
    if (matches.length === 1) {
      await runFill(tab.id, matches[0]);
      return;
    }
    await tryOpenPopupOrNotify(`${matches.length} passende Einträge gefunden. Bitte im Popup auswählen.`);
  });
}

/* ---------- Nachrichten vom Popup ---------- */

async function handleMessage(message) {
  switch (message && message.type) {
    case 'LOGIN':
      return login(message.username, message.password);

    case 'GET_ENTRIES':
      return fetchEntries();

    case 'FILL': {
      const entry = await findEntry(message.entryId);
      if (!entry) return { ok: false, error: 'Eintrag wurde nicht gefunden.' };
      return runFill(message.tabId, entry);
    }

    case 'LOGOUT':
      await setSettings({ token: null, lastActivity: null });
      lastEntries = null;
      return { ok: true };

    case 'SET_VAULT_URL': {
      try {
        // eslint-disable-next-line no-new
        new URL(message.url);
      } catch {
        return { ok: false, error: 'Ungültige Tresor-Adresse.' };
      }
      // Token/Benutzername gehören zum alten Backend und werden beim Wechsel der Adresse verworfen.
      await setSettings({ vaultUrl: message.url, token: null, username: null, lastActivity: null });
      lastEntries = null;
      return { ok: true };
    }

    default:
      return { ok: false, error: `Unbekannter Nachrichtentyp: ${message && message.type}` };
  }
}

ext.runtime.onMessage.addListener((message) => handleMessage(message));
