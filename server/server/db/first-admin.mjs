// Erster Start: Gibt es noch keinen Benutzer, wird ein Konto mit allen Rechten (Rolle owner) angelegt.
// Zugang aus ADMIN_USERNAME und ADMIN_PASSWORD; ohne Passwort wird eins erzeugt und einmal ins Log geschrieben.
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../auth/passwords.mjs';

export async function ensureFirstAdmin(db) {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM users').get();
  if (count > 0) return;

  const username = (process.env.ADMIN_USERNAME || 'admin').trim();
  const given = process.env.ADMIN_PASSWORD || '';
  const password = given || randomBytes(12).toString('base64url');
  const email = (process.env.ADMIN_EMAIL || `${username}@localhost`).trim();

  db.prepare(
    'INSERT INTO users (username, email, password_hash, first_name, last_name, role, scrum_role) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(username, email, await hashPassword(password), 'Admin', '', 'owner', 'developer');

  console.log('============================================================');
  console.log(`[Erster Start] Konto „${username}“ angelegt.`);
  if (given) console.log('[Erster Start] Passwort: wie in ADMIN_PASSWORD gesetzt.');
  else console.log(`[Erster Start] Passwort: ${password}  (bitte nach der Anmeldung ändern)`);
  console.log('============================================================');
}
