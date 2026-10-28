import { createHash, randomBytes } from 'node:crypto';
import { getDb } from '../db/database.mjs';

// Schlüssel sehen so aus: nxk_<43 Zeichen>. In der Datenbank liegt nur der SHA 256 Hash.
const PREFIX = 'nxk_';
const KEY_PATTERN = /^nxk_[A-Za-z0-9_-]{43}$/;

export function hashKey(key) {
  return createHash('sha256').update(String(key)).digest('hex');
}

export function createKey() {
  const key = PREFIX + randomBytes(32).toString('base64url');
  return { key, hash: hashKey(key), prefix: key.slice(0, PREFIX.length + 6) };
}

export function looksLikeKey(value) {
  return KEY_PATTERN.test(String(value || ''));
}

// Liefert den Benutzer zum Schlüssel oder null
export function userForKey(key) {
  if (!looksLikeKey(key)) return null;
  const db = getDb();
  const row = db.prepare(`
    SELECT k.id AS key_id, k.name AS key_name, k.last_used_at, u.id, u.username, u.first_name, u.last_name, u.role
    FROM mcp_keys k JOIN users u ON u.id = k.user_id
    WHERE k.key_hash = ?
  `).get(hashKey(key));
  if (!row) return null;
  // "Zuletzt benutzt" höchstens einmal pro Minute schreiben
  const last = row.last_used_at ? Date.parse(row.last_used_at.replace(' ', 'T') + 'Z') : 0;
  if (!last || Date.now() - last > 60 * 1000) {
    db.prepare('UPDATE mcp_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?').run(row.key_id);
  }
  return row;
}
