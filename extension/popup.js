// Tresor Auto-Fill — Popup-Skript

const ext = typeof browser !== 'undefined' ? browser : chrome;

// Wird beim Start des Servers durch dessen Adresse (PUBLIC_URL) ersetzt; leer = im Popup eintragen
const DEFAULT_VAULT_URL = '__PORTAL_URL__'.startsWith('__') ? '' : '__PORTAL_URL__';

// Gleicher Strich-Icon-Stil wie im Haupt-Tresor (web/index.html, ICONS).
// Als DOM-Knoten statt innerHTML-Strings, um jede dynamische innerHTML-Zuweisung zu vermeiden.
const ICON_SVG_SOURCE = {
  totp: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.2 4 4.6v4.8c0 4.1 2.6 7.1 6 8.4 3.4-1.3 6-4.3 6-8.4V4.6L10 2.2Z"/><path d="M7.2 9.9l1.9 1.9 3.7-4"/></svg>'
};

function iconNode(name) {
  const doc = new DOMParser().parseFromString(ICON_SVG_SOURCE[name], 'image/svg+xml');
  return document.importNode(doc.documentElement, true);
}

const state = {
  entries: [],
  tabUrl: '',
  vaultUrl: DEFAULT_VAULT_URL,
  username: ''
};

let els = {};
let toastTimer = null;
let clipboardClearTimer = null;

/* ---------- Hilfsfunktionen (identisch zu background.js / web/index.html) ---------- */

function hostnameOf(urlString) {
  try {
    return new URL(urlString).hostname.replace(/^www\./, '');
  } catch {
    return urlString;
  }
}

function matchEntries(entries, tabUrl) {
  const tabHost = hostnameOf(tabUrl || '');
  if (!tabHost) return [];
  return entries.filter((entry) => entry.url && hostnameOf(entry.url) === tabHost);
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

/* ---------- UI-Helfer ---------- */

function cacheEls() {
  els = {
    logoutBtn: document.getElementById('logoutBtn'),
    loginForm: document.getElementById('loginForm'),
    username: document.getElementById('username'),
    password: document.getElementById('password'),
    loginError: document.getElementById('loginError'),
    loginSubmit: document.getElementById('loginSubmit'),
    vaultUrlInput: document.getElementById('vaultUrl'),
    saveVaultUrl: document.getElementById('saveVaultUrl'),
    vaultUrlMsg: document.getElementById('vaultUrlMsg'),
    permissionText: document.getElementById('permissionText'),
    grantPermissionBtn: document.getElementById('grantPermissionBtn'),
    errorText: document.getElementById('errorText'),
    retryBtn: document.getElementById('retryBtn'),
    siteMatches: document.getElementById('siteMatches'),
    searchInput: document.getElementById('searchInput'),
    entryList: document.getElementById('entryList'),
    emptyState: document.getElementById('emptyState'),
    toast: document.getElementById('toast')
  };
}

function showView(name) {
  document.querySelectorAll('.view').forEach((section) => section.classList.add('hidden'));
  document.getElementById(`view-${name}`).classList.remove('hidden');
}

function showToast(message, isError = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle('is-error', isError);
  els.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 3000);
}

function showLoginView(errorMsg) {
  els.logoutBtn.classList.add('hidden');
  showView('login');
  if (errorMsg) {
    els.loginError.textContent = errorMsg;
    els.loginError.classList.remove('hidden');
  } else {
    els.loginError.classList.add('hidden');
  }

  if (state.username) {
    els.username.value = state.username;
    els.password.focus();
  } else {
    els.username.focus();
  }
}

function showErrorView(message) {
  els.errorText.textContent = message;
  showView('error');
}

function showPermissionView(resp) {
  els.permissionText.textContent = resp.error;
  showView('permission');
  els.grantPermissionBtn.onclick = async () => {
    els.grantPermissionBtn.disabled = true;
    try {
      const granted = await ext.permissions.request({ origins: [resp.origin] });
      if (granted) {
        await loadEntries();
      } else {
        els.permissionText.textContent =
          'Zugriff wurde nicht erteilt. Ohne Berechtigung kann der Tresor unter dieser Adresse nicht kontaktiert werden.';
      }
    } finally {
      els.grantPermissionBtn.disabled = false;
    }
  };
}

/* ---------- Laden & Rendern ---------- */

async function loadEntries() {
  showView('loading');

  const resp = await ext.runtime.sendMessage({ type: 'GET_ENTRIES' });

  if (resp.needsLogin) {
    showLoginView(resp.error);
    return;
  }
  if (resp.needsPermission) {
    showPermissionView(resp);
    return;
  }
  if (!resp.ok) {
    showErrorView(resp.error || 'Einträge konnten nicht geladen werden.');
    return;
  }

  state.entries = resp.entries.slice().sort((a, b) => a.name.localeCompare(b.name, 'de'));
  els.logoutBtn.classList.remove('hidden');

  const tabs = await ext.tabs.query({ active: true, currentWindow: true });
  state.tabUrl = (tabs[0] && tabs[0].url) || '';

  renderResults('');
  showView('results');
}

function renderResults(filterText) {
  const filter = filterText.trim().toLowerCase();

  els.siteMatches.innerHTML = '';
  const matches = matchEntries(state.entries, state.tabUrl);
  if (matches.length > 0) {
    const title = document.createElement('div');
    title.className = 'site-matches-title';
    title.textContent = 'Für diese Seite';
    els.siteMatches.appendChild(title);

    const ul = document.createElement('ul');
    ul.className = 'entry-list';
    matches.forEach((entry) => ul.appendChild(renderEntryRow(entry)));
    els.siteMatches.appendChild(ul);
  } else if (state.tabUrl) {
    const hint = document.createElement('p');
    hint.className = 'hint-text';
    hint.textContent = 'Kein Eintrag für diese Seite. Unten durchsuchen.';
    els.siteMatches.appendChild(hint);
  }

  const filtered = state.entries.filter((entry) => {
    if (!filter) return true;
    return (
      entry.name.toLowerCase().includes(filter) ||
      (entry.username || '').toLowerCase().includes(filter) ||
      (entry.url || '').toLowerCase().includes(filter)
    );
  });

  els.entryList.innerHTML = '';
  if (filtered.length === 0) {
    els.emptyState.textContent =
      state.entries.length === 0 ? 'Keine Einträge im Tresor.' : 'Keine Treffer für diese Suche.';
    els.emptyState.classList.remove('hidden');
  } else {
    els.emptyState.classList.add('hidden');
    filtered.forEach((entry) => els.entryList.appendChild(renderEntryRow(entry)));
  }
}

function renderEntryRow(entry) {
  const li = document.createElement('li');
  li.className = 'entry-row';

  const info = document.createElement('div');
  info.className = 'entry-info';
  const name = document.createElement('div');
  name.className = 'entry-name';
  name.textContent = entry.name;
  const username = document.createElement('div');
  username.className = 'entry-username';
  username.textContent = entry.username || '(kein Benutzername)';
  info.appendChild(name);
  info.appendChild(username);

  const actions = document.createElement('div');
  actions.className = 'entry-actions';

  if (entry.totp_secret) {
    const totpBtn = document.createElement('button');
    totpBtn.type = 'button';
    totpBtn.className = 'totp-badge';
    totpBtn.title = 'TOTP-Code kopieren';
    totpBtn.setAttribute('aria-label', 'TOTP-Code kopieren');
    totpBtn.appendChild(iconNode('totp'));
    totpBtn.addEventListener('click', () => handleCopyTotp(entry, totpBtn));
    actions.appendChild(totpBtn);
  }

  const fillBtn = document.createElement('button');
  fillBtn.type = 'button';
  fillBtn.className = 'fill-btn';
  fillBtn.textContent = 'Ausfüllen';
  fillBtn.addEventListener('click', () => handleFill(entry, fillBtn));
  actions.appendChild(fillBtn);

  li.appendChild(info);
  li.appendChild(actions);
  return li;
}

/* ---------- Aktionen ---------- */

async function handleFill(entry, btn) {
  btn.disabled = true;
  try {
    const tabs = await ext.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab || !tab.id) {
      showToast('Kein aktiver Tab gefunden.', true);
      return;
    }

    const resp = await ext.runtime.sendMessage({ type: 'FILL', tabId: tab.id, entryId: entry.id });
    if (!resp.ok) {
      showToast(resp.error || 'Ausfüllen fehlgeschlagen.', true);
      return;
    }

    if (resp.result && resp.result.filledPassword) {
      showToast('Ausgefüllt.');
      setTimeout(() => window.close(), 450);
    } else {
      showToast('Kein Passwortfeld auf dieser Seite gefunden.', true);
    }
  } finally {
    btn.disabled = false;
  }
}

async function handleCopyTotp(entry, btn) {
  btn.disabled = true;
  try {
    const code = await totpCode(entry.totp_secret);
    await navigator.clipboard.writeText(code);
    showToast('Code kopiert.');
    scheduleClipboardClear(code);
  } catch (err) {
    showToast(`Code konnte nicht kopiert werden: ${err.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

// Best-effort-Löschung der Zwischenablage nach 60s. Funktioniert nur, solange
// dieses Popup-Dokument in dieser Zeit geöffnet bleibt (siehe README: Popups
// werden vom Browser beim Schließen/Fokusverlust beendet, ein zuverlässiger
// Hintergrund-Timer bräuchte die "alarms"-Berechtigung, die hier bewusst
// nicht deklariert ist). Kein Blocker, aber ausdrücklich kein Garant.
function scheduleClipboardClear(expectedCode) {
  if (clipboardClearTimer) clearTimeout(clipboardClearTimer);
  clipboardClearTimer = setTimeout(async () => {
    try {
      const current = await navigator.clipboard.readText();
      if (current === expectedCode) {
        await navigator.clipboard.writeText('');
      }
    } catch {
      // Lesezugriff verweigert oder Popup bereits geschlossen — kein Blocker.
    }
  }, 60000);
}

/* ---------- Statische Event-Handler ---------- */

function bindStaticHandlers() {
  els.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    els.loginError.classList.add('hidden');
    els.loginSubmit.disabled = true;
    els.loginSubmit.textContent = 'Anmelden …';

    const username = els.username.value.trim();
    const password = els.password.value;

    try {
      const resp = await ext.runtime.sendMessage({ type: 'LOGIN', username, password });
      if (resp.ok) {
        els.password.value = '';
        await loadEntries();
      } else {
        els.loginError.textContent = resp.error || 'Anmeldung fehlgeschlagen.';
        els.loginError.classList.remove('hidden');
      }
    } finally {
      els.loginSubmit.disabled = false;
      els.loginSubmit.textContent = 'Anmelden';
    }
  });

  els.saveVaultUrl.addEventListener('click', async () => {
    const value = els.vaultUrlInput.value.trim().replace(/\/+$/, '');
    els.vaultUrlMsg.classList.remove('hidden');

    let origin;
    try {
      origin = `${new URL(value).origin}/*`;
    } catch {
      els.vaultUrlMsg.textContent = 'Ungültige Adresse.';
      return;
    }

    els.saveVaultUrl.disabled = true;
    try {
      const has = await ext.permissions.contains({ origins: [origin] });
      if (!has) {
        const granted = await ext.permissions.request({ origins: [origin] });
        if (!granted) {
          els.vaultUrlMsg.textContent = 'Berechtigung für diese Adresse wurde nicht erteilt.';
          return;
        }
      }

      const resp = await ext.runtime.sendMessage({ type: 'SET_VAULT_URL', url: value });
      if (!resp.ok) {
        els.vaultUrlMsg.textContent = resp.error || 'Speichern fehlgeschlagen.';
        return;
      }

      state.vaultUrl = value;
      els.vaultUrlMsg.textContent = 'Gespeichert. Bitte ggf. erneut anmelden.';
    } finally {
      els.saveVaultUrl.disabled = false;
    }
  });

  els.logoutBtn.addEventListener('click', async () => {
    await ext.runtime.sendMessage({ type: 'LOGOUT' });
    state.entries = [];
    showLoginView();
  });

  els.retryBtn.addEventListener('click', () => loadEntries());

  els.searchInput.addEventListener('input', () => renderResults(els.searchInput.value));
}

/* ---------- Start ---------- */

async function init() {
  cacheEls();
  bindStaticHandlers();

  const settings = await ext.storage.local.get({ vaultUrl: DEFAULT_VAULT_URL, token: null, username: '' });
  state.vaultUrl = settings.vaultUrl;
  state.username = settings.username || '';
  els.vaultUrlInput.value = settings.vaultUrl;

  if (!settings.token) {
    showLoginView();
    return;
  }

  await loadEntries();
}

init();
