// Gemeinsame Bausteine für Tresor, Dokumentation und Sprints

/* ---------- Name und Module (kommt vom Server über /config.js) ---------- */
const APP = Object.assign({ name: 'Teamhafen', modules: ['vault', 'docs', 'office', 'sprints', 'ai'], dashboard: true }, window.APP_CONFIG || {});
const hasModule = (id) => APP.modules.includes(id);
// Startseite nach der Anmeldung: Dashboard, wenn es Doku oder Sprints gibt, sonst der Tresor
const HOME_PATH = APP.dashboard ? '/dashboard' : '/';
// Kurzer Name für die KI Programme (z. B. "teamhafen")
const APP_SLUG = APP.name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'portal';
function appTitle(section) {
  return section ? `${APP.name} ${section}` : APP.name;
}
function listJoin(items) {
  return items.length > 1 ? `${items.slice(0, -1).join(', ')} und ${items[items.length - 1]}` : items.join('');
}
// Was die globale Suche (Strg+K) durchsucht, je nach Modulen
const SEARCH_SCOPE = {
  short: listJoin([hasModule('docs') && 'Dokumente', hasModule('sprints') && 'Aufgaben', hasModule('docs') && 'Ordner', hasModule('vault') && 'Tresor'].filter(Boolean)),
  long: listJoin([hasModule('docs') && 'Titel und Inhalt der Dokumentation', hasModule('sprints') && 'Jira-Aufgaben', hasModule('docs') && 'Ordner', hasModule('vault') && 'die Namen der Tresor-Einträge'].filter(Boolean)),
};

const state = {
  token: localStorage.getItem('token'),
  currentUser: readStoredUser(),
  users: [],
  passwords: [],
  folders: [],
  activeFolder: 'all',
  expandedFolders: new Set(),
  searchQuery: '',
  shown: {},
  darkMode: localStorage.getItem('darkMode') === 'true',
  pendingFolderParentId: null,
  folderModalMode: 'create',
  editingFolderId: null,
  clearTotpOnSave: false,
  editingUserId: null,
  deletingUserId: null,
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

if (state.darkMode) document.documentElement.setAttribute('data-theme', 'dark');

/* ---------- Sicherheits-Konstanten ---------- */
const CLIPBOARD_CLEAR_MS = 25000; // 25 Sekunden
const INACTIVITY_LOGOUT_MS = 15 * 60 * 1000; // 15 Minuten

let inactivityTimer = null;
let lastActivityAt = Date.now();

['mousemove', 'keydown', 'click', 'touchstart', 'scroll'].forEach(evt => {
  document.addEventListener(evt, () => { lastActivityAt = Date.now(); }, { passive: true });
});

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML;
}

function base64urlToBuffer(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/').padEnd(str.length + (4 - (str.length % 4)) % 4, '=');
  const raw = atob(padded);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}
function bufferToBase64url(buf) {
  const bytes = new Uint8Array(buf);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hostnameOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

function maskOf(password) {
  return '\u2022'.repeat(Math.min(Math.max(password.length, 6), 14));
}

function readStoredUser() {
  try {
    return JSON.parse(localStorage.getItem('currentUser') || 'null');
  } catch {
    localStorage.removeItem('currentUser');
    return null;
  }
}

function setCurrentUser(user) {
  state.currentUser = user || null;
  if (state.currentUser) localStorage.setItem('currentUser', JSON.stringify(state.currentUser));
  else localStorage.removeItem('currentUser');
}

function canManageUsers() {
  return state.currentUser?.role === 'admin' || state.currentUser?.role === 'owner';
}

async function fetchJson(url, options = {}) {
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    'Authorization': `Bearer ${state.token}`,
    ...(options.headers || {}),
  };
  const res = await fetch(url, { ...options, headers });
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401) { handleUnauthorized(); throw new Error('unauthorized'); }
  return { res, data };
}

const USER_ROLE_VALUES = new Set(['admin', 'member', 'owner']);
const SCRUM_ROLE_VALUES = new Set(['developer', 'scrum_master', 'product_owner', 'designer']);

function errorMessage(data, fallback) {
  return data?.error || data?.message || fallback;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(date);
}

function userDisplayName(user) {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ').trim();
  return name || user?.username || 'Unbenannter Nutzer';
}

function roleLabel(role) {
  return ({ admin: 'Admin', member: 'Mitglied', owner: 'Owner' })[role] || role || '—';
}

function scrumRoleLabel(role) {
  return ({ developer: 'Developer', scrum_master: 'Scrum Master', product_owner: 'Product Owner', designer: 'Designer' })[role] || role || '—';
}

/* ---------- TOTP (RFC 4226/6238) — reines Web Crypto, keine Bibliothek ---------- */
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

let totpTickerStarted = false;

function startTotpTicker() {
  if (totpTickerStarted) return;
  totpTickerStarted = true;
  setInterval(tickTotpCodes, 1000);
}

async function tickTotpCodes() {
  const list = document.getElementById('entryList');
  if (!list) return;
  if (!state.passwords.some(p => p.totp_secret)) return;

  const codeNodes = list.querySelectorAll('[data-totp-id]');
  if (!codeNodes.length) return;

  const codeCache = new Map();
  for (const node of codeNodes) {
    const pw = state.passwords.find(p => p.id === Number(node.dataset.totpId));
    if (!pw || !pw.totp_secret) continue;
    let code = codeCache.get(pw.totp_secret);
    if (code === undefined) {
      code = await totpCode(pw.totp_secret);
      codeCache.set(pw.totp_secret, code);
    }
    const formatted = code.slice(0, 3) + '\u00A0' + code.slice(3);
    if (node.textContent !== formatted) node.textContent = formatted;
  }

  const remaining = 30 - (Math.floor(Date.now() / 1000) % 30);
  const remainingText = `(${remaining}s)`;
  list.querySelectorAll('[data-totp-countdown-id]').forEach(el => {
    if (el.textContent !== remainingText) el.textContent = remainingText;
  });
}

function glyphSVG({ size = 32, animate = false } = {}) {
  const scan = animate ? '<line class="scanline" x1="12" y1="24" x2="36" y2="24"/>' : '';
  return `
    <svg class="security-mark" width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <rect class="mark-frame" x="8" y="8" width="32" height="32" rx="8" stroke-width="2"/>
      <path class="mark-path" d="M16 25.5 21.2 31 33 17" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <path class="mark-path" d="M15 14h18M15 34h18" stroke-width="1.7" stroke-linecap="round" opacity="0.55"/>
      <circle class="mark-node" cx="14" cy="14" r="2"/>
      <circle class="mark-node" cx="34" cy="34" r="2"/>
      ${scan}
    </svg>`;
}

const ICONS = {
  eye: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 10s3.2-6 9-6 9 6 9 6-3.2 6-9 6-9-6-9-6Z"/><circle cx="10" cy="10" r="2.4"/></svg>`,
  eyeOff: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 2.5l15 15M6.6 6.9C4 8.2 2 10 2 10s3.2 6 9 6c1.7 0 3.1-.5 4.3-1.2M9.1 4.2C9.4 4.1 9.7 4 10 4c5.8 0 9 6 9 6a15.6 15.6 0 0 1-2.6 3.4M11.4 11.4a2.4 2.4 0 0 1-3.3-3.3"/></svg>`,
  copy: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M4.5 13H4a1.5 1.5 0 0 1-1.5-1.5V4A1.5 1.5 0 0 1 4 2.5h7.5A1.5 1.5 0 0 1 13 4v.5"/></svg>`,
  edit: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12.9 3.5 16.5 7.1 6.6 17H3v-3.6L12.9 3.5Z"/></svg>`,
  trash: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 5.5h13M8 5.5V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5M6 5.5 6.8 16a1.5 1.5 0 0 0 1.5 1.4h3.4a1.5 1.5 0 0 0 1.5-1.4l.8-10.5"/></svg>`,
  chevron: `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4l6 6-6 6"/></svg>`,
  folderMenu: `<svg viewBox="0 0 20 20" width="14" height="14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="5" y1="10" x2="5" y2="10"/><line x1="10" y1="10" x2="10" y2="10"/><line x1="15" y1="10" x2="15" y2="10"/></svg>`,
  warning: `<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 3.6 1.8 15.5a1.4 1.4 0 0 0 1.2 2.1h14a1.4 1.4 0 0 0 1.2-2.1L11.5 3.6a1.4 1.4 0 0 0-2.5 0Z"/><line x1="10" y1="8" x2="10" y2="11.3"/><line x1="10" y1="14" x2="10" y2="14"/></svg>`,
  totp: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2.2 4 4.6v4.8c0 4.1 2.6 7.1 6 8.4 3.4-1.3 6-4.3 6-8.4V4.6L10 2.2Z"/><path d="M7.2 9.9l1.9 1.9 3.7-4"/></svg>`,
  dice: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="14" height="14" rx="3"/><circle cx="7" cy="7" r="0.9" fill="currentColor" stroke="none"/><circle cx="13" cy="7" r="0.9" fill="currentColor" stroke="none"/><circle cx="10" cy="10" r="0.9" fill="currentColor" stroke="none"/><circle cx="7" cy="13" r="0.9" fill="currentColor" stroke="none"/><circle cx="13" cy="13" r="0.9" fill="currentColor" stroke="none"/></svg>`,
  history: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10a7 7 0 1 0 2.1-5"/><path d="M2.5 3.5v3.6h3.6"/><path d="M10 6.5v3.8l2.8 1.8"/></svg>`,
  key: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="14" r="3.2"/><path d="M8.2 11.8 15.5 4.5M12.6 7.4l1.9 1.9M15 5l2 2"/></svg>`,
};

function showToast(message, isError = false) {
  const region = document.getElementById('toastRegion');
  const toast = document.createElement('div');
  toast.className = 'toast' + (isError ? ' is-error' : '');
  toast.textContent = message;
  region.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

/* ---------- Focus trap helper for modals ---------- */
let lastFocusedEl = null;
function openDialog(overlay, { keepFocus = false } = {}) {
  if (!keepFocus) lastFocusedEl = document.activeElement;
  overlay.hidden = false;
  const focusables = overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  const first = focusables[0], last = focusables[focusables.length - 1];
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); closeDialog(overlay); }
    else if (e.key === 'Tab' && focusables.length) {
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  overlay._onKey = onKey;
  overlay.addEventListener('keydown', onKey);
  (first || overlay).focus();
}
function closeDialog(overlay) {
  overlay.hidden = true;
  overlay.removeEventListener('keydown', overlay._onKey);
  if (lastFocusedEl) lastFocusedEl.focus();
}

function openExtensionModal() {
  openDialog(document.getElementById('extensionModal'));
}

function closeExtensionModal() {
  closeDialog(document.getElementById('extensionModal'));
}

function bindExtensionModal() {
  const overlay = document.getElementById('extensionModal');
  // Das Modal kommt aus ensureSharedUi(), das bindExtensionModal() danach selbst aufruft
  if (!overlay) { ensureSharedUi(); return; }
  if (overlay.dataset.bound === 'true') return;
  document.getElementById('btnCloseExtension').addEventListener('click', closeExtensionModal);
  overlay.addEventListener('click', (e) => {
    if (e.target.id === 'extensionModal') closeExtensionModal();
  });
  overlay.dataset.bound = 'true';
}

/* ---------- Logout & Inaktivitäts-Überwachung ---------- */
function stopInactivityMonitor() {
  if (inactivityTimer) {
    clearInterval(inactivityTimer);
    inactivityTimer = null;
  }
}

function startInactivityMonitor() {
  stopInactivityMonitor();
  lastActivityAt = Date.now();
  inactivityTimer = setInterval(() => {
    if (Date.now() - lastActivityAt >= INACTIVITY_LOGOUT_MS) {
      performLogout({ reason: 'inactivity' });
    }
  }, 30000);
}

function performLogout({ reason } = {}) {
  stopInactivityMonitor();
  state.token = null;
  setCurrentUser(null);
  localStorage.removeItem('token');
  if (reason === 'inactivity') {
    sessionStorage.setItem('autoLoggedOut', '1');
  }
  closeSettingsMenu();
  logoutHandler({ reason });
}

function closePwChangeModal() {
  const overlay = document.getElementById('pwChangeModal');
  closeDialog(overlay);
  document.getElementById('pwChangeForm').reset();
  document.getElementById('pwChangeError').style.display = 'none';
}

async function onPwChangeSubmit(e) {
  e.preventDefault();
  const current = document.getElementById('currentPassword').value;
  const next = document.getElementById('newPassword').value;
  const confirm = document.getElementById('confirmPassword').value;
  const errorEl = document.getElementById('pwChangeError');
  errorEl.style.display = 'none';

  if (next !== confirm) {
    errorEl.textContent = 'Die neuen Passwörter stimmen nicht überein.';
    errorEl.style.display = 'block';
    return;
  }

  try {
    const res = await fetch('/api/auth/password', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${state.token}` },
      body: JSON.stringify({ current_password: current, new_password: next })
    });
    const data = await res.json();
    if (res.ok) {
      closePwChangeModal();
      showToast('Passwort geändert.');
    } else {
      errorEl.textContent = data.error || 'Passwort konnte nicht geändert werden.';
      errorEl.style.display = 'block';
    }
  } catch {
    errorEl.textContent = 'Verbindungsfehler beim Ändern des Passworts.';
    errorEl.style.display = 'block';
  }
}

/* ---------- Passkeys ---------- */
function guessBrowserName() {
  const ua = navigator.userAgent || '';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Browser';
}

function openPasskeyModal() {
  const input = document.getElementById('passkeyNameInput');
  if (input) input.value = `${guessBrowserName()} ${formatDate(new Date().toISOString())}`;
  loadPasskeyList();
  openDialog(document.getElementById('passkeyModal'));
}

async function loadPasskeyList() {
  const list = document.getElementById('passkeyList');
  try {
    const { res, data } = await fetchJson('/api/webauthn/credentials');
    if (!res.ok) {
      showToast(errorMessage(data, 'Passkeys konnten nicht geladen werden.'), true);
      return;
    }
    const creds = Array.isArray(data) ? data : [];
    if (!creds.length) {
      list.innerHTML = '<li class="empty-state-inline">Noch kein Passkey hinterlegt. Füge einen hinzu, um dich ohne Passwort anzumelden.</li>';
      return;
    }
    list.innerHTML = creds.map(c => `
      <li class="passkey-row" data-passkey-id="${c.id}">
        <div class="passkey-row-main">
          <strong>${escapeHtml(c.name || 'Passkey')}</strong>
          <span class="passkey-row-meta">Erstellt am ${formatDate(c.created_at)} · Zuletzt genutzt: ${c.last_used_at ? formatDate(c.last_used_at) : 'Noch nie'}</span>
        </div>
        <button type="button" class="btn btn-danger" data-remove-passkey="${c.id}">Entfernen</button>
      </li>
    `).join('');
  } catch (err) {
    if (err.message === 'unauthorized') return;
    showToast('Verbindungsfehler beim Laden der Passkeys.', true);
  }
}

function onPasskeyListClick(e) {
  const btn = e.target.closest('[data-remove-passkey]');
  if (!btn) return;
  removePasskey(btn.dataset.removePasskey);
}

async function removePasskey(id) {
  if (!confirm('Diesen Passkey wirklich entfernen?')) return;
  try {
    const { res, data } = await fetchJson(`/api/webauthn/credentials/${id}`, { method: 'DELETE' });
    if (res.ok) {
      loadPasskeyList();
    } else {
      showToast(errorMessage(data, 'Passkey konnte nicht entfernt werden.'), true);
    }
  } catch (err) {
    if (err.message === 'unauthorized') return;
    showToast('Verbindungsfehler beim Entfernen des Passkeys.', true);
  }
}

async function onRegisterPasskeyClick() {
  const nameInput = document.getElementById('passkeyNameInput');
  const name = nameInput?.value?.trim() || 'Passkey';
  try {
    const { res, data: options } = await fetchJson('/api/webauthn/register/options', { method: 'POST' });
    if (!res.ok) {
      showToast(errorMessage(options, 'Passkey-Registrierung nicht verfügbar.'), true);
      return;
    }
    options.challenge = base64urlToBuffer(options.challenge);
    options.user.id = base64urlToBuffer(options.user.id);
    if (Array.isArray(options.excludeCredentials)) {
      options.excludeCredentials = options.excludeCredentials.map(c => ({ ...c, id: base64urlToBuffer(c.id) }));
    }
    const credential = await navigator.credentials.create({ publicKey: options });
    const payload = {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
        attestationObject: bufferToBase64url(credential.response.attestationObject),
        transports: credential.response.getTransports ? credential.response.getTransports() : undefined,
      },
      clientExtensionResults: credential.getClientExtensionResults(),
    };
    const { res: verifyRes, data: verifyData } = await fetchJson('/api/webauthn/register/verify', {
      method: 'POST',
      body: JSON.stringify({ name, response: payload }),
    });
    if (!verifyRes.ok) {
      showToast(errorMessage(verifyData, 'Passkey konnte nicht registriert werden.'), true);
      return;
    }
    showToast('Passkey hinzugefügt.');
    loadPasskeyList();
  } catch (err) {
    if (err?.message === 'unauthorized') return;
    if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') return;
    showToast(err.message || 'Passkey konnte nicht registriert werden.', true);
  }
}

/* ---------- KI verbinden (MCP) ---------- */
// SQLite liefert "2026-10-27 12:00:00" in UTC
function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value) ? value.replace(' ', 'T') + 'Z' : value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function buildAiPrompt(key, connectionName) {
  const base = `${window.location.origin}/mcp`;
  const withKey = `${base}/${key}`;
  const owner = userDisplayName(state.currentUser);
  const name = APP_SLUG;
  const what = [hasModule('docs') && 'unsere Projektdokumentation (Dokumente, Ordner und Dateien wie PDF, Word oder Bilder)', hasModule('sprints') && 'die Sprints (Jira)'].filter(Boolean).join(' und ');
  const docsNote = hasModule('docs') ? ' Dokumente schreibst du als Markdown, Dateien kannst du in andere Ordner verschieben und umbenennen.' : '';
  return `Bitte verbinde dich mit dem MCP Server unseres Portals „${APP.name}“. Darüber kannst du ${what} lesen und bearbeiten.${docsNote} Gelöscht wird über die KI nichts. Richte die Verbindung bitte selbst ein, wenn du das kannst.

ZUGANG
Name des Servers: ${name}
Adresse (Streamable HTTP): ${base}
Anmeldung als HTTP Header: Authorization: Bearer ${key}
Adresse mit eingebautem Schlüssel (für Programme ohne eigene Header): ${withKey}

EINRICHTEN JE NACH PROGRAMM
Claude Code (im Terminal ausführen):
claude mcp add --transport http --scope user ${name} ${base} --header "Authorization: Bearer ${key}"

Codex (im Terminal ausführen):
codex mcp add ${name} --url ${withKey}

OpenCode (in ~/.config/opencode/opencode.json unter "mcp" ergänzen):
"${name}": { "type": "remote", "url": "${base}", "headers": { "Authorization": "Bearer ${key}" }, "enabled": true }

Gemini CLI (in ~/.gemini/settings.json unter "mcpServers" ergänzen):
"${name}": { "httpUrl": "${base}", "headers": { "Authorization": "Bearer ${key}" } }

Cursor, VS Code, Windsurf und ähnliche: als MCP Server vom Typ http mit der Adresse und dem Header eintragen.

Claude App, claude.ai, ChatGPT und andere Chat Apps: Das kannst du nicht selbst einrichten. Sag mir dann Schritt für Schritt, wo ich einen eigenen Connector mit der Adresse mit eingebautem Schlüssel anlege, ohne OAuth. Bei Claude: Einstellungen → Connectors → Benutzerdefinierten Connector hinzufügen. Bei ChatGPT: Einstellungen → Apps und Connectors → Entwicklermodus einschalten, dann einen Connector erstellen.

DANACH
1. Starte die Sitzung neu, falls die neuen Werkzeuge erst danach erscheinen.
2. Rufe das Werkzeug portal_ueberblick auf und sag mir, als wer du angemeldet bist und was du siehst.

WICHTIG
Dieser Schlüssel gehört nur mir (${owner}, Verbindung „${connectionName}“). Gib ihn nicht weiter und schreib ihn nirgends hinein, also nicht in Dokumente, Aufgaben oder Git.
Du arbeitest mit meinen Rechten, alles was du änderst sieht das ganze Team. Frag mich vor größeren Änderungen.
${hasModule('vault') ? 'Auf den Passwort Tresor hat diese Verbindung keinen Zugriff.' : ''}`.trim();
}

function resetAiConnect() {
  const create = document.getElementById('aiConnectCreate');
  if (!create) return;
  create.hidden = false;
  document.getElementById('aiConnectResult').hidden = true;
  document.getElementById('aiPromptText').value = '';
  document.getElementById('aiConnectName').value = '';
}

function openAiConnectModal() {
  resetAiConnect();
  loadAiKeys();
  openDialog(document.getElementById('aiConnectModal'));
}

function closeAiConnectModal() {
  closeDialog(document.getElementById('aiConnectModal'));
  // Den Schlüssel nicht im Fenster stehen lassen
  resetAiConnect();
}

async function loadAiKeys() {
  const list = document.getElementById('aiKeyList');
  try {
    const { res, data } = await fetchJson('/api/mcp-keys');
    if (!res.ok) {
      list.innerHTML = `<li class="empty-state-inline">${escapeHtml(errorMessage(data, 'Verbindungen konnten nicht geladen werden.'))}</li>`;
      return;
    }
    const keys = Array.isArray(data) ? data : [];
    if (!keys.length) {
      list.innerHTML = '<li class="empty-state-inline">Noch keine KI verbunden.</li>';
      return;
    }
    list.innerHTML = keys.map(k => `
      <li class="passkey-row">
        <div class="passkey-row-main">
          <strong>${escapeHtml(k.name)}</strong>
          <span class="passkey-row-meta">Erstellt ${formatDateTime(k.created_at)} · ${k.last_used_at ? `Zuletzt benutzt ${formatDateTime(k.last_used_at)}` : 'Noch nicht benutzt'} · <span class="mono">${escapeHtml(k.key_prefix)}…</span></span>
        </div>
        <button type="button" class="btn btn-danger" data-revoke-ai-key="${k.id}" data-name="${escapeHtml(k.name)}">Widerrufen</button>
      </li>
    `).join('');
  } catch (err) {
    if (err.message === 'unauthorized') return;
    list.innerHTML = '<li class="empty-state-inline">Verbindungsfehler beim Laden.</li>';
  }
}

async function onCreateAiPrompt() {
  const btn = document.getElementById('btnCreateAiPrompt');
  const name = document.getElementById('aiConnectName').value.trim() || 'Meine KI';
  btn.disabled = true;
  try {
    const { res, data } = await fetchJson('/api/mcp-keys', { method: 'POST', body: JSON.stringify({ name }) });
    if (!res.ok || !data?.key) {
      showToast(errorMessage(data, 'Prompt konnte nicht erstellt werden.'), true);
      return;
    }
    document.getElementById('aiPromptText').value = buildAiPrompt(data.key, data.name);
    document.getElementById('aiConnectCreate').hidden = true;
    document.getElementById('aiConnectResult').hidden = false;
    document.getElementById('btnCopyAiPrompt').focus();
    loadAiKeys();
  } catch (err) {
    if (err.message !== 'unauthorized') showToast('Verbindungsfehler beim Erstellen.', true);
  } finally {
    btn.disabled = false;
  }
}

async function onCopyAiPrompt() {
  const area = document.getElementById('aiPromptText');
  try {
    await navigator.clipboard.writeText(area.value);
  } catch {
    area.select();
    document.execCommand('copy');
  }
  showToast('Prompt kopiert. Jetzt einfach in deine KI einfügen.');
}

async function onAiKeyListClick(e) {
  const btn = e.target.closest('[data-revoke-ai-key]');
  if (!btn) return;
  if (!confirm(`Verbindung „${btn.dataset.name}“ widerrufen? Die KI kommt danach nicht mehr ins Portal.`)) return;
  try {
    const { res, data } = await fetchJson(`/api/mcp-keys/${encodeURIComponent(btn.dataset.revokeAiKey)}`, { method: 'DELETE' });
    if (!res.ok) {
      showToast(errorMessage(data, 'Widerrufen fehlgeschlagen.'), true);
      return;
    }
    showToast('Verbindung widerrufen.');
    loadAiKeys();
  } catch (err) {
    if (err.message !== 'unauthorized') showToast('Verbindungsfehler beim Widerrufen.', true);
  }
}

const SHARED_MODALS_HTML = `
<div id="extensionModal" class="modal-overlay" hidden>
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="extensionModalTitle">
    <h2 id="extensionModalTitle">Browser-Erweiterung</h2>
    <p class="extension-copy">Füllt Zugangsdaten aus dem Tresor direkt in Login Formulare ein. Die Erweiterung ist schon auf <strong>${escapeHtml(window.location.origin)}</strong> eingestellt. Es gibt getrennte Downloads für Chrome/Edge und Firefox.</p>

    <div class="extension-section">
      <h3>Chrome &amp; Edge</h3>
      <a class="btn btn-primary btn-block" href="/downloads/tresor-chrome.zip" download>Chrome / Edge herunterladen</a>
      <ol>
        <li>ZIP-Datei vollständig entpacken.</li>
        <li><code>chrome://extensions</code> oder <code>edge://extensions</code> öffnen.</li>
        <li><strong>Entwicklermodus</strong> aktivieren.</li>
        <li><strong>„Entpackte Erweiterung laden“</strong> auswählen.</li>
        <li>Den entpackten Ordner auswählen.</li>
        <li>Erweiterung bei Bedarf anpinnen.</li>
      </ol>
    </div>

    <div class="extension-section">
      <h3>Firefox</h3>
      <a class="btn btn-primary btn-block" href="/downloads/tresor-firefox.zip" download>Firefox herunterladen</a>
      <ol>
        <li>ZIP-Datei vollständig entpacken.</li>
        <li><code>about:debugging#/runtime/this-firefox</code> öffnen.</li>
        <li><strong>„Temporäres Add-on laden…“</strong> auswählen.</li>
        <li>Die enthaltene <code>manifest.json</code> auswählen.</li>
      </ol>
      <p class="extension-copy">Hinweis: Ein temporäres Firefox-Add-on wird beim Browser-Neustart entfernt. Für eine dauerhafte Installation ist eine Mozilla-Signatur erforderlich.</p>
    </div>
    <p class="extension-copy extension-section">Nach Installation und Anmeldung im Tresor füllt <span class="mono">Strg+Umschalt+L</span> passende Logins automatisch aus.</p>
    <div class="modal-actions">
      <button type="button" class="btn" id="btnCloseExtension">Schließen</button>
    </div>
  </div>
</div>
    <div id="pwChangeModal" class="modal-overlay" hidden>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="pwChangeTitle">
        <h2 id="pwChangeTitle">Passwort ändern</h2>
        <form id="pwChangeForm" novalidate>
          <div class="field">
            <label for="currentPassword">Aktuelles Passwort</label>
            <input type="password" id="currentPassword" autocomplete="current-password" required>
          </div>
          <div class="field">
            <label for="newPassword">Neues Passwort</label>
            <input type="password" id="newPassword" autocomplete="new-password" minlength="6" required>
          </div>
          <div class="field">
            <label for="confirmPassword">Neues Passwort bestätigen</label>
            <input type="password" id="confirmPassword" autocomplete="new-password" required>
          </div>
          <div class="error-msg" id="pwChangeError" role="alert" style="display:none;"></div>
          <div class="modal-actions">
            <button type="button" class="btn" id="btnCancelPwChange">Abbrechen</button>
            <button type="submit" class="btn btn-primary">Ändern</button>
          </div>
        </form>
      </div>
    </div>

    <div id="passkeyModal" class="modal-overlay" hidden>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="passkeyModalTitle">
        <h2 id="passkeyModalTitle">Passkeys verwalten</h2>
        <ul id="passkeyList" class="passkey-list"></ul>
        <div class="field">
          <label for="passkeyNameInput">Passkey hinzufügen</label>
          <input type="text" id="passkeyNameInput" placeholder="Name des Geräts">
        </div>
        <div class="modal-actions">
          <button type="button" class="btn" id="btnClosePasskeys">Schließen</button>
          <button type="button" class="btn btn-primary" id="btnRegisterPasskey">Registrieren</button>
        </div>
      </div>
    </div>

    <div id="aiConnectModal" class="modal-overlay" hidden>
      <div class="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby="aiConnectTitle">
        <h2 id="aiConnectTitle">KI verbinden</h2>
        <p class="extension-copy">Verbinde deine eigene KI (Claude, ChatGPT, Codex, OpenCode, Gemini …) mit dem Portal. Sie kann dann ${[hasModule('docs') && 'die <strong>Dokumentation</strong> (auch Dateien verschieben und umbenennen)', hasModule('sprints') && 'die <strong>Sprints</strong>'].filter(Boolean).join(' und ')} lesen und bearbeiten, mit deinen Rechten. Löschen kann sie nichts${hasModule('vault') ? ', auf den Tresor hat sie keinen Zugriff' : ''}.</p>
        <div id="aiConnectCreate">
          <div class="field">
            <label for="aiConnectName">Name der Verbindung</label>
            <input type="text" id="aiConnectName" maxlength="80" placeholder="z. B. Claude auf meinem Laptop" autocomplete="off">
          </div>
          <button type="button" class="btn btn-primary btn-block" id="btnCreateAiPrompt">Prompt erstellen</button>
        </div>
        <div id="aiConnectResult" hidden>
          <p class="ai-prompt-hint">Kopiere diesen Text und gib ihn deiner KI. Sie richtet die Verbindung dann selbst ein. <strong>Der Schlüssel darin wird nur jetzt angezeigt</strong>, gib ihn niemandem weiter.</p>
          <textarea id="aiPromptText" class="ai-prompt-text" readonly spellcheck="false" aria-label="Prompt für deine KI"></textarea>
          <div class="ai-prompt-actions">
            <button type="button" class="btn btn-primary" id="btnCopyAiPrompt">Prompt kopieren</button>
            <button type="button" class="btn" id="btnNewAiPrompt">Weitere Verbindung</button>
          </div>
        </div>
        <div class="extension-section">
          <h3>Deine Verbindungen</h3>
          <ul id="aiKeyList" class="ai-key-list"></ul>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn" id="btnCloseAiConnect">Schließen</button>
        </div>
      </div>
    </div>

`;

/* ---------- Gemeinsamer Header, Einstellungen & Seitenwechsel ---------- */
const NAV_ITEMS = [
  { id: 'dashboard', href: '/dashboard', label: 'Dashboard', enabled: APP.dashboard },
  { id: 'vault', href: '/', label: 'Tresor', enabled: hasModule('vault') },
  { id: 'docs', href: '/dokumentation', label: 'Dokumentation', enabled: hasModule('docs') },
  { id: 'sprints', href: '/sprints', label: 'Sprints', enabled: hasModule('sprints') },
].filter(item => item.enabled);
const ALLOWED_NEXT = new Set(NAV_ITEMS.map(item => item.href).filter(href => href !== '/'));

// Standard: zurück zur Anmeldung auf der Startseite, bei abgelaufener Sitzung mit Rücksprung
let logoutHandler = ({ reason } = {}) => {
  const keepPage = (reason === 'expired' || reason === 'inactivity') && ALLOWED_NEXT.has(window.location.pathname);
  window.location.href = keepPage ? `/?next=${encodeURIComponent(window.location.pathname)}` : '/';
};

function setLogoutHandler(fn) {
  logoutHandler = fn;
}

function handleUnauthorized() {
  performLogout({ reason: 'expired' });
}

function nextTarget() {
  const next = new URLSearchParams(window.location.search).get('next');
  return ALLOWED_NEXT.has(next) ? next : null;
}

async function requireSession() {
  if (!state.token) { logoutHandler({ reason: 'expired' }); return false; }
  try {
    const res = await fetch('/api/auth/me', { headers: { 'Authorization': `Bearer ${state.token}` } });
    if (res.ok) {
      setCurrentUser(await res.json());
      startInactivityMonitor();
      return true;
    }
    if (res.status === 401) { handleUnauthorized(); return false; }
    throw new Error(`HTTP ${res.status}`);
  } catch {
    document.getElementById('app').innerHTML = `
      <div class="jira-loading" style="padding:80px 20px;text-align:center;color:var(--text-soft)">
        Keine Verbindung zum Server möglich. <a href="${escapeHtml(window.location.pathname)}">Erneut versuchen</a>
      </div>`;
    return false;
  }
}

function headerHTML({ title, current, controls = '' }) {
  // Mit nur einem Bereich braucht es keine Navigation
  const nav = NAV_ITEMS.length < 2 ? '' : NAV_ITEMS.map(item => {
    const active = item.id === current;
    return `<a class="btn nav-link${active ? ' is-current' : ''}" href="${item.href}"${active ? ' aria-current="page"' : ''}>${item.label}</a>`;
  }).join('');
  return `
    <header class="app-header">
      <div class="brand-group">
        ${glyphSVG({ size: 30 })}
        <h1 class="brandmark">${escapeHtml(title)}</h1>
      </div>
      <div class="header-controls">
        ${controls}
        ${nav ? `<nav class="app-nav" aria-label="Bereiche">${nav}</nav>` : ''}
        <button type="button" class="btn search-trigger" id="btnGlobalSearch" title="Alles durchsuchen (Strg+K)" aria-haspopup="dialog">${SEARCH_ICON}<span>Suchen</span><kbd>Strg K</kbd></button>
        <button type="button" class="btn" id="btnSettings" aria-haspopup="menu" aria-expanded="false" aria-controls="settingsMenu">${SETTINGS_ICONS.gear} Einstellungen</button>
      </div>
    </header>`;
}

const SETTINGS_ICONS = {
  gear: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  sun: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="3.4"/><path d="M10 2v1.6M10 16.4V18M18 10h-1.6M3.6 10H2M15.7 4.3l-1.1 1.1M5.4 14.6l-1.1 1.1M15.7 15.7l-1.1-1.1M5.4 5.4 4.3 4.3"/></svg>`,
  moon: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 12.3A7 7 0 0 1 7.7 3.5a7 7 0 1 0 8.8 8.8Z"/></svg>`,
  puzzle: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3.5a1.8 1.8 0 0 1 3.6 0V5H15v3.4h-1.5a1.8 1.8 0 0 0 0 3.6H15v3.5h-3.4V14a1.8 1.8 0 0 0-3.6 0v1.5H4.5v-3.5H6a1.8 1.8 0 0 0 0-3.6H4.5V5H8V3.5Z"/></svg>`,
  spark: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2.5 10.5 7 15 8.5 10.5 10 9 14.5 7.5 10 3 8.5 7.5 7Z"/><path d="M15.5 12.5v4M13.5 14.5h4"/></svg>`,
  users: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="6.5" r="3"/><path d="M2 17a5.5 5.5 0 0 1 11 0"/><path d="M13 3.6a3 3 0 0 1 0 5.8M15.5 12.2A5.5 5.5 0 0 1 18 17"/></svg>`,
  logout: `<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 14.5v1.8a1.2 1.2 0 0 1-1.2 1.2H4.2A1.2 1.2 0 0 1 3 16.3V3.7a1.2 1.2 0 0 1 1.2-1.2h7.1a1.2 1.2 0 0 1 1.2 1.2v1.8M8.5 10H17M14.5 7l3 3-3 3"/></svg>`,
};

function settingsItem(action, icon, label, desc, danger = false) {
  return `
    <button type="button" class="context-menu-item${danger ? ' context-menu-item-danger' : ''}" role="menuitem" data-setting="${action}">
      <span class="context-menu-icon">${icon}</span>
      <span class="context-menu-text">
        <span class="context-menu-label" data-setting-label="${action}">${label}</span>
        <span class="context-menu-desc">${desc}</span>
      </span>
    </button>`;
}

function settingsMenuHTML() {
  return `
    <div id="settingsMenu" class="context-menu settings-menu" role="menu" aria-label="Einstellungen" hidden>
      ${settingsItem('theme', SETTINGS_ICONS.sun, 'Helles Design', 'Zwischen hellem und dunklem Design wechseln')}
      ${hasModule('vault') ? settingsItem('extension', SETTINGS_ICONS.puzzle, 'Browser-Erweiterung', 'Tresor-Erweiterung für Chrome, Edge und Firefox') : ''}
      ${hasModule('ai') ? settingsItem('ai', SETTINGS_ICONS.spark, 'KI verbinden', `Eigene KI mit ${[hasModule('docs') && 'Doku', hasModule('sprints') && 'Sprints'].filter(Boolean).join(' und ')} verbinden`) : ''}
      ${settingsItem('users', SETTINGS_ICONS.users, 'Benutzer verwalten', 'Konten anlegen, Rollen und Passwörter ändern')}
      ${settingsItem('password', ICONS.key, 'Passwort ändern', 'Eigenes Anmelde-Passwort ändern')}
      ${settingsItem('passkeys', ICONS.totp, 'Passkeys', 'Anmeldung ohne Passwort verwalten')}
      <div class="settings-menu-sep" role="separator"></div>
      ${settingsItem('logout', SETTINGS_ICONS.logout, 'Abmelden', 'Sitzung auf diesem Gerät beenden', true)}
    </div>`;
}

function applyTheme() {
  if (state.darkMode) document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
}

function toggleTheme() {
  state.darkMode = !state.darkMode;
  localStorage.setItem('darkMode', state.darkMode);
  applyTheme();
}

function updateThemeMenuItem() {
  const label = document.querySelector('[data-setting-label="theme"]');
  const icon = document.querySelector('[data-setting="theme"] .context-menu-icon');
  if (label) label.textContent = state.darkMode ? 'Helles Design' : 'Dunkles Design';
  if (icon) icon.innerHTML = state.darkMode ? SETTINGS_ICONS.sun : SETTINGS_ICONS.moon;
}

function closeSettingsMenu({ restoreFocus = false } = {}) {
  const menu = document.getElementById('settingsMenu');
  const btn = document.getElementById('btnSettings');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  btn?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) btn?.focus();
}

function openSettingsMenu() {
  const menu = document.getElementById('settingsMenu');
  const btn = document.getElementById('btnSettings');
  updateThemeMenuItem();
  // Das Menü entsteht evtl. schon vor der Anmeldung; Benutzerverwaltung nur für Admins zeigen
  const usersItem = menu.querySelector('[data-setting="users"]');
  if (usersItem) usersItem.hidden = !canManageUsers();
  menu.hidden = false;
  const rect = btn.getBoundingClientRect();
  const width = menu.offsetWidth;
  menu.style.top = `${Math.round(rect.bottom + 8)}px`;
  menu.style.left = `${Math.round(Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)))}px`;
  btn.setAttribute('aria-expanded', 'true');
  menu.querySelector('.context-menu-item')?.focus();
}

function onSettingsAction(action) {
  closeSettingsMenu();
  if (action === 'theme') toggleTheme();
  else if (action === 'extension') openExtensionModal();
  else if (action === 'ai') openAiConnectModal();
  else if (action === 'users') window.location.href = '/?admin=1';
  else if (action === 'password') openDialog(document.getElementById('pwChangeModal'));
  else if (action === 'passkeys') openPasskeyModal();
  else if (action === 'logout') performLogout();
}

// Modals und Menü, die auf jeder Seite gleich sind, einmalig an den Body hängen
function ensureSharedUi() {
  if (document.getElementById('settingsMenu')) return;
  if (!document.getElementById('toastRegion')) {
    document.body.insertAdjacentHTML('beforeend', '<div id="toastRegion" class="toast-region" aria-live="polite"></div>');
  }
  document.body.insertAdjacentHTML('beforeend', SHARED_MODALS_HTML + settingsMenuHTML());

  bindExtensionModal();

  document.getElementById('btnCancelPwChange').addEventListener('click', () => closePwChangeModal());
  document.getElementById('pwChangeModal').addEventListener('click', (e) => {
    if (e.target.id === 'pwChangeModal') closePwChangeModal();
  });
  document.getElementById('pwChangeForm').addEventListener('submit', onPwChangeSubmit);

  document.getElementById('btnClosePasskeys').addEventListener('click', () => closeDialog(document.getElementById('passkeyModal')));
  document.getElementById('passkeyModal').addEventListener('click', (e) => {
    if (e.target.id === 'passkeyModal') closeDialog(document.getElementById('passkeyModal'));
  });
  document.getElementById('passkeyList').addEventListener('click', onPasskeyListClick);
  document.getElementById('btnRegisterPasskey').addEventListener('click', onRegisterPasskeyClick);

  document.getElementById('btnCreateAiPrompt').addEventListener('click', onCreateAiPrompt);
  document.getElementById('aiConnectName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onCreateAiPrompt(); }
  });
  document.getElementById('btnCopyAiPrompt').addEventListener('click', onCopyAiPrompt);
  document.getElementById('btnNewAiPrompt').addEventListener('click', () => { resetAiConnect(); document.getElementById('aiConnectName').focus(); });
  document.getElementById('btnCloseAiConnect').addEventListener('click', closeAiConnectModal);
  document.getElementById('aiConnectModal').addEventListener('click', (e) => {
    if (e.target.id === 'aiConnectModal') closeAiConnectModal();
  });
  document.getElementById('aiKeyList').addEventListener('click', onAiKeyListClick);
  document.getElementById('aiConnectModal').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') resetAiConnect();
  });

  const menu = document.getElementById('settingsMenu');
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('[data-setting]');
    if (item) onSettingsAction(item.dataset.setting);
  });
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('.context-menu-item:not([hidden])')];
    const idx = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); closeSettingsMenu({ restoreFocus: true }); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Tab') closeSettingsMenu();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#settingsMenu') && !e.target.closest('#btnSettings')) closeSettingsMenu();
  });
  window.addEventListener('resize', () => closeSettingsMenu());
  window.addEventListener('scroll', () => closeSettingsMenu(), { passive: true });

  document.body.insertAdjacentHTML('beforeend', SEARCH_HTML);
  bindGlobalSearch();
}

// Muss nach jedem Neuaufbau des Headers aufgerufen werden
function bindHeader() {
  ensureSharedUi();
  closeSettingsMenu();
  document.getElementById('btnGlobalSearch')?.addEventListener('click', () => openGlobalSearch());
  const btn = document.getElementById('btnSettings');
  btn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = document.getElementById('settingsMenu');
    if (menu.hidden) openSettingsMenu();
    else closeSettingsMenu();
  });
}

/* ---------- Globale Suche (Strg+K) ---------- */
const SEARCH_ICON = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="8.8" cy="8.8" r="5.6"/><path d="m13 13 4.2 4.2"/></svg>';

const SEARCH_HTML = `
  <div id="globalSearch" class="modal-overlay search-overlay" hidden>
    <div class="search-dialog" role="dialog" aria-modal="true" aria-label="Alles durchsuchen">
      <div class="search-input-row">
        ${SEARCH_ICON}
        <input type="search" id="globalSearchInput" placeholder="${escapeHtml(SEARCH_SCOPE.short)} durchsuchen …" autocomplete="off" aria-label="Suchbegriff" aria-controls="globalSearchResults">
        <kbd>Esc</kbd>
      </div>
      <div id="globalSearchResults" class="search-results" role="listbox"></div>
      <div class="search-foot"><span><kbd>↑</kbd><kbd>↓</kbd> auswählen</span><span><kbd>Enter</kbd> öffnen</span><span><kbd>Strg</kbd><kbd>K</kbd> Suche öffnen</span></div>
    </div>
  </div>`;

// Seiten können Treffer selbst öffnen (ohne Neuladen); sonst wird zur passenden Seite gewechselt
let searchNavigator = null;
function onSearchNavigate(fn) {
  searchNavigator = fn;
}

function searchTargetUrl(hit) {
  if (hit.type === 'doc') return `/dokumentation?doc=${hit.id}`;
  if (hit.type === 'folder') return `/dokumentation?folder=${hit.id}`;
  if (hit.type === 'file') return `/dokumentation?file=${hit.id}`;
  if (hit.type === 'issue') return `/sprints?issue=${encodeURIComponent(hit.key)}`;
  if (hit.type === 'vault') return `/?entry=${hit.id}`;
  return '/';
}

let searchSeq = 0;
let searchTimer = null;
let searchHits = [];
let searchActive = 0;

function highlight(text, q) {
  const safe = escapeHtml(text || '');
  if (!q) return safe;
  const idx = safe.toLowerCase().indexOf(escapeHtml(q).toLowerCase());
  if (idx < 0) return safe;
  const len = escapeHtml(q).length;
  return safe.slice(0, idx) + '<mark>' + safe.slice(idx, idx + len) + '</mark>' + safe.slice(idx + len);
}

function renderSearchResults(data, q) {
  const box = document.getElementById('globalSearchResults');
  if (!data) {
    box.innerHTML = `<div class="search-empty">Tippe mindestens zwei Zeichen.<br><small>Durchsucht ${escapeHtml(SEARCH_SCOPE.long)}.</small></div>`;
    searchHits = [];
    return;
  }
  const groups = [
    ['Aufgaben', (data.issues || []).map(i => ({ type: 'issue', key: i.key, title: `${i.key} · ${i.summary}`, sub: [i.status?.name, i.assignee].filter(Boolean).join(' · '), status: i.status?.category }))],
    ['Dokumente', (data.docs || []).map(d => ({ type: 'doc', id: d.id, title: d.title, sub: d.path, snippet: d.snippet }))],
    ['Dateien', (data.files || []).map(f => ({ type: 'file', id: f.id, title: f.name, sub: f.path }))],
    ['Ordner', (data.folders || []).map(f => ({ type: 'folder', id: f.id, title: f.name, sub: f.path }))],
    ['Tresor', (data.vault || []).map(v => ({ type: 'vault', id: v.id, title: v.name, sub: [v.private ? '🔒 Privat' : '', v.username, v.url && hostnameOf(v.url)].filter(Boolean).join(' · ') }))],
  ].filter(([, hits]) => hits.length);
  searchHits = groups.flatMap(([, hits]) => hits);
  searchActive = 0;
  if (!searchHits.length) {
    box.innerHTML = `<div class="search-empty">Keine Treffer für „${escapeHtml(q)}“.</div>`;
    return;
  }
  const icons = { issue: '◆', doc: '📄', file: '📎', folder: '📁', vault: '🔑' };
  let index = 0;
  box.innerHTML = groups.map(([label, hits]) => `
    <div class="search-group">${label}</div>
    ${hits.map(hit => {
      const i = index++;
      return `<button type="button" class="search-hit${i === 0 ? ' is-active' : ''}" role="option" data-hit="${i}" aria-selected="${i === 0}">
        <span class="search-hit-icon${hit.status ? ` c-${escapeHtml(hit.status)}` : ''}">${icons[hit.type]}</span>
        <span class="search-hit-main">
          <strong>${highlight(hit.title, q)}</strong>
          ${hit.sub ? `<small>${escapeHtml(hit.sub)}</small>` : ''}
          ${hit.snippet ? `<em>${highlight(hit.snippet, q)}</em>` : ''}
        </span>
      </button>`;
    }).join('')}`).join('');
}

function setSearchActive(i) {
  const items = [...document.querySelectorAll('#globalSearchResults .search-hit')];
  if (!items.length) return;
  searchActive = (i + items.length) % items.length;
  items.forEach((el, idx) => { el.classList.toggle('is-active', idx === searchActive); el.setAttribute('aria-selected', String(idx === searchActive)); });
  items[searchActive].scrollIntoView({ block: 'nearest' });
}

async function runGlobalSearch(q) {
  const seq = ++searchSeq;
  if (q.trim().length < 2) { renderSearchResults(null, q); return; }
  try {
    const { res, data } = await fetchJson(`/api/search?q=${encodeURIComponent(q.trim())}`);
    if (seq !== searchSeq) return;
    if (!res.ok) throw new Error(errorMessage(data, 'Suche fehlgeschlagen'));
    renderSearchResults(data, q.trim());
  } catch (e) {
    if (e.message === 'unauthorized' || seq !== searchSeq) return;
    document.getElementById('globalSearchResults').innerHTML = `<div class="search-empty">${escapeHtml(e.message)}</div>`;
  }
}

function openSearchHit(hit) {
  if (!hit) return;
  closeDialog(document.getElementById('globalSearch'));
  if (searchNavigator && searchNavigator(hit) === true) return;
  window.location.href = searchTargetUrl(hit);
}

function openGlobalSearch() {
  const overlay = document.getElementById('globalSearch');
  if (!overlay || !state.token) return;
  closeSettingsMenu();
  if (overlay.hidden) openDialog(overlay);
  const input = document.getElementById('globalSearchInput');
  input.focus();
  input.select();
  if (!input.value) renderSearchResults(null, '');
}

function bindGlobalSearch() {
  const overlay = document.getElementById('globalSearch');
  const input = document.getElementById('globalSearchInput');
  overlay.addEventListener('click', (e) => { if (e.target.id === 'globalSearch') closeDialog(overlay); });
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runGlobalSearch(input.value), 150);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSearchActive(searchActive + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSearchActive(searchActive - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); openSearchHit(searchHits[searchActive]); }
  });
  document.getElementById('globalSearchResults').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-hit]');
    if (btn) openSearchHit(searchHits[Number(btn.dataset.hit)]);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openGlobalSearch();
    }
  });
}

/* ---------- Jira-Spiegel für Dashboard und Doku (nur lesend) ---------- */
// Liefert null, wenn Jira nicht verbunden oder gerade nicht erreichbar ist
async function loadJiraMirror() {
  if (!hasModule('sprints')) return null;
  try {
    const [metaRes, changesRes] = await Promise.all([fetchJson('/api/jira/meta'), fetchJson('/api/jira/changes?since=0')]);
    if (!metaRes.res.ok || !changesRes.res.ok) return null;
    const sprints = changesRes.data.sprints || [];
    const sprintById = new Map(sprints.map(sp => [sp.id, sp]));
    const issues = new Map();
    for (const issue of changesRes.data.issues || []) {
      const own = (issue.sprintIds || []).map(id => sprintById.get(id)).filter(Boolean);
      const sprint = own.find(sp => sp.state === 'active') || own.find(sp => sp.state === 'future') || null;
      issues.set(issue.key, { ...issue, sprint: sprint ? { id: sprint.id, name: sprint.name, state: sprint.state } : null });
    }
    return { meta: metaRes.data, sprints, issues, sync: changesRes.data.sync };
  } catch (e) {
    return null;
  }
}

export {
  APP,
  APP_SLUG,
  HOME_PATH,
  appTitle,
  hasModule,
  loadJiraMirror,
  onSearchNavigate,
  openGlobalSearch,
  ALLOWED_NEXT,
  CLIPBOARD_CLEAR_MS,
  ICONS,
  INACTIVITY_LOGOUT_MS,
  NAV_ITEMS,
  SCRUM_ROLE_VALUES,
  SETTINGS_ICONS,
  SHARED_MODALS_HTML,
  USER_ROLE_VALUES,
  applyTheme,
  base32Decode,
  base64urlToBuffer,
  bindExtensionModal,
  bindHeader,
  bufferToBase64url,
  canManageUsers,
  closeDialog,
  closeExtensionModal,
  closePwChangeModal,
  closeSettingsMenu,
  ensureSharedUi,
  errorMessage,
  escapeHtml,
  fetchJson,
  formatDate,
  glyphSVG,
  guessBrowserName,
  handleUnauthorized,
  headerHTML,
  hostnameOf,
  loadPasskeyList,
  maskOf,
  nextTarget,
  onPasskeyListClick,
  onPwChangeSubmit,
  onRegisterPasskeyClick,
  onSettingsAction,
  openDialog,
  openAiConnectModal,
  openExtensionModal,
  openPasskeyModal,
  openSettingsMenu,
  performLogout,
  readStoredUser,
  reducedMotion,
  removePasskey,
  requireSession,
  roleLabel,
  scrumRoleLabel,
  setCurrentUser,
  setLogoutHandler,
  settingsItem,
  settingsMenuHTML,
  showToast,
  startInactivityMonitor,
  startTotpTicker,
  state,
  stopInactivityMonitor,
  tickTotpCodes,
  toggleTheme,
  totpCode,
  updateThemeMenuItem,
  userDisplayName,
};
