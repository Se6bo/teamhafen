// Tresor-Speicher auf Vaultwarden.
//
// Das Portal ist ein Bitwarden-Client mit Dienstkonten: "team" für den gemeinsamen Tresor und
// "user:<id>" für jeden privaten Tresor. Die Master-Passwörter dieser Konten erzeugt der Server selbst
// und speichert sie mit CRYPTO_KEY verschlüsselt in vault_accounts; kein Mitglied braucht eines.
//
// In SQLite liegt nur ein Index ohne Geheimnisse (vault_entries, vault_folders, vault_history_meta):
// feste Nummern für die Oberfläche, Ordnerbaum, privater Besitzer, wer was geändert hat.
// Vaultwarden ist die Quelle der Wahrheit: Einträge, die dort direkt angelegt oder gelöscht werden,
// übernimmt das Portal beim nächsten Abgleich.
import { randomBytes, randomUUID } from 'node:crypto';
import { getDb } from '../db/database.mjs';
import { encrypt, decrypt } from '../crypto/password-manager.mjs';
import { hasPrivateVault } from '../auth/private-vault.mjs';
import { BitwardenClient, decryptBytes, encryptText, decryptText } from './bitwarden.mjs';
import { APP_NAME } from '../config.mjs';

export class VaultError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const HISTORY_LIMIT = 10;

function config() {
  return {
    url: (process.env.VW_URL || '').replace(/\/+$/, ''),
    domain: process.env.VW_ACCOUNT_DOMAIN || 'teamhafen.local',
  };
}

export function vaultConfigured() {
  return Boolean(config().url);
}

/* ---------- Ein Schloss für alle Tresor-Vorgänge (6 Benutzer, Einfachheit vor Durchsatz) ---------- */
let lockChain = Promise.resolve();
function withLock(fn) {
  const run = lockChain.then(fn, fn);
  lockChain = run.catch(() => {});
  return run;
}

/* ---------- Konten ---------- */
const clients = new Map();

const accountFor = (ownerId) => (ownerId == null ? 'team' : `user:${ownerId}`);
const ownerOf = (account) => (account === 'team' ? null : Number(account.split(':')[1]));

function emailFor(account) {
  return `${account === 'team' ? 'team' : `privat-${ownerOf(account)}`}@${config().domain}`;
}

async function clientFor(account, { create = true } = {}) {
  if (clients.has(account)) return clients.get(account);
  const db = getDb();
  let row = db.prepare('SELECT * FROM vault_accounts WHERE account = ?').get(account);
  if (!row) {
    if (!create) return null;
    const email = emailFor(account);
    const password = randomBytes(32).toString('base64url');
    const deviceId = randomUUID();
    const client = new BitwardenClient({ baseUrl: config().url, email, password, deviceId, deviceName: APP_NAME });
    await client.register(account === 'team' ? `${APP_NAME} (gemeinsam)` : `${APP_NAME} (privat ${ownerOf(account)})`);
    const enc = encrypt(password);
    db.prepare('INSERT INTO vault_accounts (account, email, password_encrypted, iv, auth_tag, device_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(account, email, enc.encrypted, enc.iv, enc.authTag, deviceId);
    row = db.prepare('SELECT * FROM vault_accounts WHERE account = ?').get(account);
    console.log(`[Tresor] Vaultwarden-Konto ${email} angelegt`);
  }
  const client = new BitwardenClient({
    baseUrl: config().url,
    email: row.email,
    password: decrypt(row.password_encrypted, row.iv, row.auth_tag),
    deviceId: row.device_id,
    deviceName: APP_NAME,
  });
  clients.set(account, client);
  return client;
}

/* ---------- Einträge ver- und entschlüsseln ---------- */

function keyPair(buf) {
  return { enc: buf.subarray(0, 32), mac: buf.subarray(32, 64) };
}

// Ein Eintrag kann einen eigenen Schlüssel haben (von offiziellen Bitwarden-Apps angelegt)
function cipherKey(raw, userKey) {
  return raw.key ? keyPair(decryptBytes(raw.key, userKey)) : userKey;
}

function decodeCipher(raw, userKey) {
  const key = cipherKey(raw, userKey);
  const dec = (v) => { try { return decryptText(v, key); } catch { return null; } };
  const login = raw.login || {};
  return {
    vwId: raw.id,
    vwFolderId: raw.folderId || null,
    name: dec(raw.name) || '(ohne Namen)',
    notes: dec(raw.notes),
    username: dec(login.username) || '',
    password: dec(login.password) || '',
    totp: dec(login.totp),
    url: login.uris?.length ? dec(login.uris[0].uri) : null,
    history: (raw.passwordHistory || []).map(h => ({ password: dec(h.password) || '', lastUsedDate: h.lastUsedDate })),
    revisionDate: raw.revisionDate,
    raw,
  };
}

// Baut den Request für Vaultwarden. Felder, die das Portal nicht kennt (weitere Adressen,
// eigene Felder, Favorit), werden aus dem bestehenden Eintrag übernommen.
function encodeCipher(data, userKey, { vwFolderId, existing } = {}) {
  const keepRaw = existing && existing.raw && existing.sameAccount ? existing.raw : null;
  const key = keepRaw ? cipherKey(keepRaw, userKey) : userKey;
  const enc = (v) => encryptText(v, key);
  const otherUris = keepRaw?.login?.uris?.slice(1) || [];
  return {
    type: 1,
    organizationId: null,
    folderId: vwFolderId || null,
    favorite: keepRaw?.favorite || false,
    reprompt: keepRaw?.reprompt || 0,
    key: keepRaw?.key || null,
    fields: keepRaw?.fields || null,
    name: enc(data.name),
    notes: enc(data.notes),
    login: {
      username: enc(data.username),
      password: enc(data.password),
      totp: enc(data.totp),
      uris: [...(data.url ? [{ uri: enc(data.url), match: null }] : []), ...otherUris],
      passwordRevisionDate: data.passwordRevisionDate || keepRaw?.login?.passwordRevisionDate || null,
    },
    passwordHistory: (data.history || []).map(h => ({ password: enc(h.password), lastUsedDate: h.lastUsedDate })),
  };
}

/* ---------- Abgleich mit Vaultwarden ---------- */
const snapshots = new Map(); // account -> { revision, folders: Map(vwId -> name), ciphers: Map(vwId -> decoded) }

async function snapshot(account) {
  const client = await clientFor(account, { create: false });
  if (!client) return { revision: null, folders: new Map(), ciphers: new Map() };
  const revision = await client.revisionDate();
  const cached = snapshots.get(account);
  if (cached && cached.revision === revision) return cached;
  const userKey = await client.userKey();
  const data = await client.sync();
  const snap = { revision, folders: new Map(), ciphers: new Map(), broken: new Set() };
  for (const f of data.folders || []) {
    let name = null;
    try { name = decryptText(f.name, userKey); } catch { name = null; }
    snap.folders.set(f.id, name || '(ohne Namen)');
  }
  for (const c of data.ciphers || []) {
    if (c.deletedDate || c.organizationId || Number(c.type) !== 1) continue;
    try { snap.ciphers.set(c.id, decodeCipher(c, userKey)); } catch (e) { snap.broken.add(c.id); console.error('[Tresor] Eintrag nicht lesbar:', c.id, e.message); }
  }
  reconcile(account, snap);
  snapshots.set(account, snap);
  return snap;
}

// Index an Vaultwarden angleichen: dort gelöschte Einträge/Ordner entfernen, dort neue übernehmen
function reconcile(account, snap) {
  const db = getDb();
  const owner = ownerOf(account);
  const folders = db.prepare('SELECT id, vw_id FROM vault_folders WHERE account = ?').all(account);
  for (const f of folders) {
    if (!snap.folders.has(f.vw_id)) {
      db.prepare('UPDATE vault_entries SET folder_id = NULL WHERE folder_id = ?').run(f.id);
      db.prepare('UPDATE vault_folders SET parent_id = NULL WHERE parent_id = ?').run(f.id);
      db.prepare('DELETE FROM vault_folders WHERE id = ?').run(f.id);
    }
  }
  const known = new Set(folders.map(f => f.vw_id));
  for (const vwId of snap.folders.keys()) {
    if (!known.has(vwId)) db.prepare('INSERT INTO vault_folders (account, vw_id, private_owner_id) VALUES (?, ?, ?)').run(account, vwId, owner);
  }
  const folderByVw = new Map(db.prepare('SELECT id, vw_id FROM vault_folders WHERE account = ?').all(account).map(f => [f.vw_id, f.id]));

  const entries = db.prepare('SELECT id, vw_id, folder_id FROM vault_entries WHERE account = ?').all(account);
  for (const e of entries) {
    const c = snap.ciphers.get(e.vw_id);
    if (!c && snap.broken.has(e.vw_id)) continue; // vorübergehend nicht lesbar: Index behalten
    if (!c) {
      db.prepare('DELETE FROM vault_history_meta WHERE entry_id = ?').run(e.id);
      db.prepare('DELETE FROM vault_entries WHERE id = ?').run(e.id);
      continue;
    }
    // Ordner in Vaultwarden geändert (z. B. in einer Bitwarden-App)
    const folderId = c.vwFolderId ? folderByVw.get(c.vwFolderId) ?? null : null;
    if ((e.folder_id ?? null) !== folderId) db.prepare('UPDATE vault_entries SET folder_id = ? WHERE id = ?').run(folderId, e.id);
  }
  const knownEntries = new Set(entries.map(e => e.vw_id));
  for (const [vwId, c] of snap.ciphers) {
    if (knownEntries.has(vwId)) continue;
    // Direkt in Vaultwarden angelegt: übernehmen
    const folderId = c.vwFolderId ? folderByVw.get(c.vwFolderId) ?? null : null;
    db.prepare('INSERT INTO vault_entries (account, vw_id, folder_id, private_owner_id) VALUES (?, ?, ?, ?)').run(account, vwId, folderId, owner);
  }
}

function invalidate(account) {
  snapshots.delete(account);
}

/* ---------- Sichtbarkeit ---------- */
const VISIBLE = '(private_owner_id IS NULL OR private_owner_id = ?)';

// Konten, die dieser Benutzer sehen darf und die es schon gibt
function accountsFor(user) {
  const list = ['team'];
  const own = accountFor(user.id);
  if (getDb().prepare('SELECT 1 FROM vault_accounts WHERE account = ?').get(own)) list.push(own);
  return list;
}

async function snapshotsFor(user) {
  const map = new Map();
  for (const account of accountsFor(user)) map.set(account, await snapshot(account));
  return map;
}

function visibleEntryRow(id, user) {
  return getDb().prepare(`SELECT * FROM vault_entries WHERE id = ? AND ${VISIBLE}`).get(id, user.id);
}

function visibleFolderRow(id, user) {
  return getDb().prepare(`SELECT * FROM vault_folders WHERE id = ? AND ${VISIBLE}`).get(id, user.id);
}

function folderMatches(folderId, ownerId, user) {
  if (folderId == null) return true;
  const folder = visibleFolderRow(folderId, user);
  return Boolean(folder) && (folder.private_owner_id ?? null) === (ownerId ?? null);
}

function requestedOwner(user, wantPrivate) {
  if (wantPrivate !== true) return null;
  if (!hasPrivateVault(user)) throw new VaultError(403, 'Einen privaten Tresor gibt es für dieses Konto nicht.');
  return user.id;
}

function toPortal(row, c) {
  return {
    id: row.id,
    name: c.name,
    url: c.url,
    username: c.username,
    password: c.password,
    notes: c.notes,
    folder_id: row.folder_id ?? null,
    created_at: row.created_at,
    totp_secret: c.totp || null,
    private: row.private_owner_id != null,
  };
}

function normalizeTotp(value) {
  const normalized = String(value || '').toUpperCase().replace(/\s+/g, '');
  if (normalized && (!/^[A-Z2-7]+=*$/.test(normalized) || normalized.replace(/=+$/, '').length < 16)) {
    throw new VaultError(400, 'Ungültiges TOTP-Secret (erwartet Base32, mindestens 16 Zeichen).');
  }
  return normalized;
}

function vwFolderIdOf(folderId) {
  if (folderId == null) return null;
  return getDb().prepare('SELECT vw_id FROM vault_folders WHERE id = ?').get(folderId)?.vw_id || null;
}

/* ---------- Lesen ---------- */

export function listEntries(user) {
  return withLock(async () => {
    await ensureReady();
    const snaps = await snapshotsFor(user);
    const rows = getDb().prepare(`SELECT * FROM vault_entries WHERE ${VISIBLE} ORDER BY created_at DESC, id DESC`).all(user.id);
    return rows.map(r => {
      const c = snaps.get(r.account)?.ciphers.get(r.vw_id);
      return c ? toPortal(r, c) : null;
    }).filter(Boolean);
  });
}

export function listFolders(user) {
  return withLock(async () => {
    await ensureReady();
    const snaps = await snapshotsFor(user);
    const db = getDb();
    const rows = db.prepare(`SELECT * FROM vault_folders WHERE ${VISIBLE}`).all(user.id);
    const counts = new Map(db.prepare(`SELECT folder_id, COUNT(*) n FROM vault_entries WHERE folder_id IS NOT NULL AND ${VISIBLE} GROUP BY folder_id`).all(user.id).map(r => [r.folder_id, r.n]));
    return rows.map(f => ({
      id: f.id,
      name: snaps.get(f.account)?.folders.get(f.vw_id) || '(ohne Namen)',
      created_by: f.created_by,
      created_at: f.created_at,
      parent_id: f.parent_id ?? null,
      entry_count: counts.get(f.id) || 0,
      private: f.private_owner_id != null,
    })).sort((a, b) => a.name.localeCompare(b.name, 'de'));
  });
}

export function getEntry(user, id) {
  return withLock(async () => {
    await ensureReady();
    const row = visibleEntryRow(id, user);
    if (!row) throw new VaultError(404, 'Password not found');
    const c = (await snapshot(row.account)).ciphers.get(row.vw_id);
    if (!c) throw new VaultError(404, 'Password not found');
    return toPortal(row, c);
  });
}

export function entryHistory(user, id) {
  return withLock(async () => {
    await ensureReady();
    const row = visibleEntryRow(id, user);
    if (!row) throw new VaultError(404, 'Eintrag nicht gefunden.');
    const c = (await snapshot(row.account)).ciphers.get(row.vw_id);
    if (!c) throw new VaultError(404, 'Eintrag nicht gefunden.');
    const db = getDb();
    const username = (uid) => (uid ? db.prepare('SELECT username FROM users WHERE id = ?').get(uid)?.username || null : null);
    const iso = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? String(v) : d.toISOString(); };
    const meta = db.prepare('SELECT changed_at, changed_by FROM vault_history_meta WHERE entry_id = ?').all(row.id);
    const metaBy = new Map(meta.map(m => [iso(m.changed_at), m.changed_by]));
    return [
      { id: 'current', password: c.password, changed_by: row.updated_by, changed_by_username: username(row.updated_by), changed_at: row.updated_at, is_current: true },
      ...c.history.map((h, i) => {
        const by = metaBy.get(iso(h.lastUsedDate)) ?? null;
        return { id: `h${i}`, password: h.password, changed_by: by, changed_by_username: username(by), changed_at: h.lastUsedDate, is_current: false };
      }),
    ];
  });
}

export function searchEntries(user, query, limit) {
  return listEntries(user).then(list => {
    const q = String(query || '').toLowerCase();
    return list
      .filter(e => [e.name, e.username, e.url].some(v => String(v || '').toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name, 'de', { sensitivity: 'base' }))
      .slice(0, limit)
      .map(e => ({ id: e.id, name: e.name, username: e.username, url: e.url, private: e.private }));
  });
}

/* ---------- Schreiben ---------- */

async function createCipher(account, data, folderId) {
  const client = await clientFor(account);
  const userKey = await client.userKey();
  const created = await client.api('POST', '/api/ciphers', encodeCipher(data, userKey, { vwFolderId: vwFolderIdOf(folderId) }));
  invalidate(account);
  return created.id;
}

export function createEntry(user, body) {
  return withLock(async () => {
    await ensureReady();
    const ownerId = requestedOwner(user, body.private);
    const { name, url, username, password, notes } = body;
    const folderId = body.folder_id || null;
    if (!name || !username || !password) throw new VaultError(400, 'Name, username and password are required');
    if (!folderMatches(folderId, ownerId, user)) throw new VaultError(400, 'Der Ordner gehört nicht zu diesem Tresor.');
    const totp = normalizeTotp(body.totp_secret);
    const account = accountFor(ownerId);
    const vwId = await createCipher(account, { name, url: url || null, username, password, notes: notes || null, totp: totp || null, history: [] }, folderId);
    const result = getDb().prepare('INSERT INTO vault_entries (account, vw_id, folder_id, private_owner_id, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(account, vwId, folderId, ownerId, user.id, user.id);
    return { id: result.lastInsertRowid, name, url, username, notes, folder_id: folderId, totp_secret: totp || null, private: ownerId != null };
  });
}

export function updateEntry(user, id, body) {
  return withLock(async () => {
    await ensureReady();
    const { name, url, username, password, notes } = body;
    if (!name || !username) throw new VaultError(400, 'Name and username are required');
    const row = visibleEntryRow(id, user);
    if (!row) throw new VaultError(404, 'Password not found');
    const current = (await snapshot(row.account)).ciphers.get(row.vw_id);
    if (!current) throw new VaultError(404, 'Password not found');

    const currentOwner = row.private_owner_id ?? null;
    const ownerId = 'private' in body ? requestedOwner(user, body.private) : currentOwner;
    let folderId = 'folder_id' in body ? (body.folder_id || null) : (row.folder_id ?? null);
    if (!folderMatches(folderId, ownerId, user)) {
      if (ownerId !== currentOwner) folderId = null;
      else throw new VaultError(400, 'Der Ordner gehört nicht zu diesem Tresor.');
    }

    // TOTP: Schlüssel fehlt = unverändert, null = entfernen, Text = neu setzen
    let totp = current.totp;
    if ('totp_secret' in body) {
      if (body.totp_secret === null) totp = null;
      else if (typeof body.totp_secret === 'string' && body.totp_secret !== '') totp = normalizeTotp(body.totp_secret);
    }

    let history = current.history;
    let newPassword = current.password;
    const now = new Date().toISOString();
    const db = getDb();
    if (password != null && password !== current.password) {
      history = [{ password: current.password, lastUsedDate: now }, ...current.history].slice(0, HISTORY_LIMIT);
      newPassword = password;
      db.prepare('INSERT INTO vault_history_meta (entry_id, changed_at, changed_by) VALUES (?, ?, ?)').run(row.id, now, user.id);
    }
    const data = { name, url: url || null, username, password: newPassword, notes: notes || null, totp: totp || null, history, passwordRevisionDate: newPassword !== current.password ? now : undefined };

    const newAccount = accountFor(ownerId);
    let vwId = row.vw_id;
    if (newAccount === row.account) {
      const client = await clientFor(row.account);
      const userKey = await client.userKey();
      await client.api('PUT', `/api/ciphers/${row.vw_id}`, encodeCipher(data, userKey, { vwFolderId: vwFolderIdOf(folderId), existing: { ...current, sameAccount: true } }));
      invalidate(row.account);
    } else {
      // In den anderen Tresor: dort neu anlegen, hier endgültig entfernen
      vwId = await createCipher(newAccount, data, folderId);
      const oldClient = await clientFor(row.account);
      await oldClient.api('DELETE', `/api/ciphers/${row.vw_id}`);
      invalidate(row.account);
    }
    db.prepare('UPDATE vault_entries SET account = ?, vw_id = ?, folder_id = ?, private_owner_id = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(newAccount, vwId, folderId, ownerId, user.id, row.id);
    // Abgleich soll den Eintrag nicht für fremd halten
    return { message: 'Password updated successfully', private: ownerId != null, folder_id: folderId };
  });
}

export function deleteEntry(user, id) {
  return withLock(async () => {
    await ensureReady();
    const row = visibleEntryRow(id, user);
    if (!row) throw new VaultError(404, 'Password not found');
    const client = await clientFor(row.account);
    // In den Papierkorb von Vaultwarden (dort wiederherstellbar)
    await client.api('PUT', `/api/ciphers/${row.vw_id}/delete`);
    invalidate(row.account);
    const db = getDb();
    db.prepare('DELETE FROM vault_history_meta WHERE entry_id = ?').run(row.id);
    db.prepare('DELETE FROM vault_entries WHERE id = ?').run(row.id);
    return { message: 'Password deleted successfully' };
  });
}

/* ---------- Ordner ---------- */

export function createFolder(user, body) {
  return withLock(async () => {
    await ensureReady();
    const name = String(body.name || '').trim();
    const parentId = body.parent_id != null ? Number(body.parent_id) : null;
    const ownerId = requestedOwner(user, body.private);
    if (!name) throw new VaultError(400, 'Name is required');
    if (parentId != null && !folderMatches(parentId, ownerId, user)) throw new VaultError(400, 'Übergeordneter Ordner nicht gefunden');
    const account = accountFor(ownerId);
    const client = await clientFor(account);
    const created = await client.api('POST', '/api/folders', { name: encryptText(name, await client.userKey()) });
    invalidate(account);
    const result = getDb().prepare('INSERT INTO vault_folders (account, vw_id, parent_id, private_owner_id, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(account, created.id, parentId, ownerId, user.id);
    return { id: result.lastInsertRowid, name, created_by: user.id, parent_id: parentId, entry_count: 0, private: ownerId != null };
  });
}

export function renameFolder(user, id, body) {
  return withLock(async () => {
    await ensureReady();
    const name = String(body.name || '').trim();
    if (!name) throw new VaultError(400, 'Name is required');
    const row = visibleFolderRow(id, user);
    if (!row) throw new VaultError(404, 'Folder not found');
    const client = await clientFor(row.account);
    await client.api('PUT', `/api/folders/${row.vw_id}`, { name: encryptText(name, await client.userKey()) });
    invalidate(row.account);
    return { id: row.id, name, created_by: row.created_by, created_at: row.created_at, parent_id: row.parent_id ?? null, private: row.private_owner_id != null };
  });
}

function folderWithDescendants(row) {
  const same = getDb().prepare('SELECT id, parent_id FROM vault_folders WHERE account = ?').all(row.account);
  const ids = [row.id];
  let frontier = [row.id];
  while (frontier.length) {
    const children = same.filter(f => frontier.includes(f.parent_id)).map(f => f.id);
    ids.push(...children);
    frontier = children;
  }
  return ids;
}

export function deleteFolder(user, id) {
  return withLock(async () => {
    await ensureReady();
    const row = visibleFolderRow(id, user);
    if (!row) throw new VaultError(404, 'Folder not found');
    const ids = folderWithDescendants(row);
    const db = getDb();
    const client = await clientFor(row.account);
    for (const fid of ids) {
      const vwId = db.prepare('SELECT vw_id FROM vault_folders WHERE id = ?').get(fid)?.vw_id;
      // Vaultwarden legt die Einträge darin automatisch auf "kein Ordner"
      if (vwId) await client.api('DELETE', `/api/folders/${vwId}`);
      db.prepare('UPDATE vault_entries SET folder_id = NULL WHERE folder_id = ?').run(fid);
      db.prepare('DELETE FROM vault_folders WHERE id = ?').run(fid);
    }
    invalidate(row.account);
    return { message: 'Folder deleted successfully' };
  });
}

export function moveFolderVault(user, id, wantPrivate) {
  return withLock(async () => {
    await ensureReady();
    const row = visibleFolderRow(id, user);
    if (!row) throw new VaultError(404, 'Folder not found');
    if (typeof wantPrivate !== 'boolean') throw new VaultError(400, '"private" (true oder false) fehlt');
    const currentOwner = row.private_owner_id ?? null;
    const newOwner = requestedOwner(user, wantPrivate);
    if (newOwner === currentOwner) throw new VaultError(400, newOwner ? 'Der Ordner ist schon im privaten Tresor.' : 'Der Ordner ist schon im gemeinsamen Tresor.');

    const db = getDb();
    const from = row.account;
    const to = accountFor(newOwner);
    const snap = await snapshot(from);
    const source = await clientFor(from);
    const target = await clientFor(to);
    const targetKey = await target.userKey();
    const ids = folderWithDescendants(row);

    // Ordner im Ziel anlegen
    const oldVwIds = [];
    for (const fid of ids) {
      const f = db.prepare('SELECT * FROM vault_folders WHERE id = ?').get(fid);
      const created = await target.api('POST', '/api/folders', { name: encryptText(snap.folders.get(f.vw_id) || '(ohne Namen)', targetKey) });
      oldVwIds.push(f.vw_id);
      db.prepare('UPDATE vault_folders SET account = ?, vw_id = ?, private_owner_id = ? WHERE id = ?').run(to, created.id, newOwner, fid);
    }
    db.prepare('UPDATE vault_folders SET parent_id = NULL WHERE id = ?').run(row.id);

    // Einträge umziehen
    const placeholders = ids.map(() => '?').join(', ');
    const entries = db.prepare(`SELECT * FROM vault_entries WHERE account = ? AND folder_id IN (${placeholders})`).all(from, ...ids);
    for (const e of entries) {
      const c = snap.ciphers.get(e.vw_id);
      if (!c) continue;
      const created = await target.api('POST', '/api/ciphers', encodeCipher(
        { name: c.name, url: c.url, username: c.username, password: c.password, notes: c.notes, totp: c.totp, history: c.history },
        targetKey, { vwFolderId: vwFolderIdOf(e.folder_id) },
      ));
      await source.api('DELETE', `/api/ciphers/${e.vw_id}`);
      db.prepare('UPDATE vault_entries SET account = ?, vw_id = ?, private_owner_id = ? WHERE id = ?').run(to, created.id, newOwner, e.id);
    }
    for (const vwId of oldVwIds) await source.api('DELETE', `/api/folders/${vwId}`);
    invalidate(from);
    invalidate(to);
    return { private: newOwner != null, folders: ids.length, entries: entries.length };
  });
}

/* ---------- Start: Konto anlegen und alte Einträge einmalig kopieren ---------- */
let readyPromise = null;

function ensureReady() {
  if (!vaultConfigured()) return Promise.reject(new VaultError(503, 'Der Tresor-Speicher (Vaultwarden) ist nicht eingerichtet.'));
  if (!readyPromise) {
    readyPromise = (async () => {
      await clientFor('team');
      await migrateLegacy();
    })().catch(error => {
      readyPromise = null;
      throw error;
    });
  }
  return readyPromise;
}

export function prepareVault() {
  if (!vaultConfigured()) {
    console.log('[Tresor] VW_URL fehlt – Tresor nicht verfügbar');
    return Promise.resolve(false);
  }
  return withLock(() => ensureReady()).then(() => {
    console.log(`[Tresor] Vaultwarden bereit (${config().url})`);
    return true;
  }).catch(error => {
    console.error('[Tresor] Vaultwarden nicht bereit:', error.message);
    return false;
  });
}

function getState(name) {
  return getDb().prepare('SELECT value FROM vault_state WHERE name = ?').get(name)?.value ?? null;
}

function setState(name, value) {
  getDb().prepare('INSERT INTO vault_state (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, value);
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

// Kopiert die bisherigen SQLite-Einträge nach Vaultwarden (gleiche Nummern, gleicher Tresor).
// Die alten Tabellen bleiben unverändert als Sicherung. Läuft nur einmal; bricht es ab,
// macht der nächste Start mit den noch fehlenden Einträgen weiter.
async function migrateLegacy() {
  if (getState('legacy_migrated')) return;
  const db = getDb();
  if (!tableExists(db, 'password_entries')) { setState('legacy_migrated', new Date().toISOString()); return; }
  const hasPrivate = db.prepare('PRAGMA table_info(password_entries)').all().some(c => c.name === 'private_owner_id');
  const folderPrivate = tableExists(db, 'password_folders') && db.prepare('PRAGMA table_info(password_folders)').all().some(c => c.name === 'private_owner_id');

  let folders = 0;
  let entries = 0;
  if (tableExists(db, 'password_folders')) {
    const rows = db.prepare(`SELECT id, name, parent_id, created_by, created_at${folderPrivate ? ', private_owner_id' : ''} FROM password_folders ORDER BY id`).all();
    for (const f of rows) {
      if (db.prepare('SELECT 1 FROM vault_folders WHERE id = ?').get(f.id)) continue;
      const owner = f.private_owner_id ?? null;
      const account = accountFor(owner);
      const client = await clientFor(account);
      const created = await client.api('POST', '/api/folders', { name: encryptText(f.name, await client.userKey()) });
      db.prepare('INSERT INTO vault_folders (id, account, vw_id, parent_id, private_owner_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(f.id, account, created.id, f.parent_id ?? null, owner, f.created_by ?? null, f.created_at);
      folders++;
    }
  }

  const rows = db.prepare(`SELECT *${hasPrivate ? '' : ', NULL AS private_owner_id'} FROM password_entries ORDER BY id`).all();
  const hasHistory = tableExists(db, 'password_history');
  for (const r of rows) {
    if (db.prepare('SELECT 1 FROM vault_entries WHERE id = ?').get(r.id)) continue;
    const owner = r.private_owner_id ?? null;
    const account = accountFor(owner);
    const password = r.password_encrypted != null ? decrypt(r.password_encrypted, r.iv, r.auth_tag) : '';
    const totp = r.totp_secret_encrypted != null ? decrypt(r.totp_secret_encrypted, r.totp_iv, r.totp_auth_tag) : null;
    const historyRows = hasHistory
      ? db.prepare('SELECT * FROM password_history WHERE entry_id = ? ORDER BY changed_at DESC, id DESC LIMIT ?').all(r.id, HISTORY_LIMIT)
      : [];
    const history = historyRows.map(h => ({
      password: decrypt(h.password_encrypted, h.iv, h.auth_tag),
      lastUsedDate: new Date(String(h.changed_at).replace(' ', 'T') + 'Z').toISOString(),
      changedBy: h.changed_by ?? null,
    }));
    const folderId = r.folder_id && db.prepare('SELECT 1 FROM vault_folders WHERE id = ? AND account = ?').get(r.folder_id, account) ? r.folder_id : null;
    const vwId = await createCipher(account, { name: r.name, url: r.url, username: r.username, password, notes: r.notes, totp, history }, folderId);
    db.prepare('INSERT INTO vault_entries (id, account, vw_id, folder_id, private_owner_id, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, account, vwId, folderId, owner, r.created_by ?? null, r.updated_by ?? null, r.created_at, r.updated_at ?? r.created_at);
    for (const h of history) db.prepare('INSERT INTO vault_history_meta (entry_id, changed_at, changed_by) VALUES (?, ?, ?)').run(r.id, h.lastUsedDate, h.changedBy);
    entries++;
  }
  setState('legacy_migrated', new Date().toISOString());
  console.log(`[Tresor] Nach Vaultwarden kopiert: ${folders} Ordner, ${entries} Einträge (alte Tabellen bleiben als Sicherung)`);
}

/* ---------- Für Notfälle: Zugangsdaten der Dienstkonten ---------- */
export function serviceAccounts() {
  return getDb().prepare('SELECT account, email, password_encrypted, iv, auth_tag FROM vault_accounts ORDER BY account').all()
    .map(r => ({ account: r.account, email: r.email, password: decrypt(r.password_encrypted, r.iv, r.auth_tag) }));
}
