// Notfall: Zugang zu den Tresor-Daten in Vaultwarden, auch wenn das Portal nicht läuft.
// Nur auf dem Server ausführen.
//
//   Zugangsdaten der Dienstkonten anzeigen:
//     docker compose exec app node scripts/vaultwarden-zugang.mjs
//   Alle Einträge als Bitwarden-JSON exportieren (unverschlüsselt! danach sicher löschen):
//     docker compose exec -T app node scripts/vaultwarden-zugang.mjs --export > tresor-export.json
import 'dotenv/config';
import { initDatabase } from '../server/db/database.mjs';
import { serviceAccounts } from '../server/vault/store.mjs';
import { BitwardenClient, decryptBytes, decryptText } from '../server/vault/bitwarden.mjs';

// Startmeldung der Datenbank unterdrücken, damit der Export gültiges JSON bleibt
const log = console.log;
console.log = () => {};
initDatabase();
console.log = log;
const accounts = serviceAccounts();

if (process.argv.includes('--export')) {
  const out = { encrypted: false, folders: [], items: [] };
  for (const a of accounts) {
    const client = new BitwardenClient({ baseUrl: process.env.VW_URL, email: a.email, password: a.password });
    const userKey = await client.userKey();
    const data = await client.sync();
    const label = a.account === 'team' ? 'Gemeinsam' : `Privat ${a.account.split(':')[1]}`;
    for (const f of data.folders || []) out.folders.push({ id: f.id, name: `${label}/${decryptText(f.name, userKey)}` });
    for (const c of data.ciphers || []) {
      if (c.deletedDate || Number(c.type) !== 1) continue;
      const key = c.key ? (() => { const k = decryptBytes(c.key, userKey); return { enc: k.subarray(0, 32), mac: k.subarray(32) }; })() : userKey;
      const d = (v) => decryptText(v, key);
      out.items.push({
        id: c.id, folderId: c.folderId || null, type: 1, name: d(c.name), notes: d(c.notes), favorite: false,
        login: { username: d(c.login?.username), password: d(c.login?.password), totp: d(c.login?.totp), uris: (c.login?.uris || []).map(u => ({ uri: d(u.uri), match: null })) },
      });
    }
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(0);
}

if (!accounts.length) {
  console.log('Noch keine Dienstkonten angelegt.');
} else {
  console.log('Vaultwarden-Dienstkonten des Portals (geheim halten):\n');
  for (const a of accounts) console.log(`${a.account === 'team' ? 'Gemeinsamer Tresor' : `Privater Tresor (Benutzer ${a.account.split(':')[1]})`}\n  E-Mail:   ${a.email}\n  Passwort: ${a.password}\n`);
  console.log('Vaultwarden läuft nur intern. Für einen Export aller Einträge: --export (siehe Kopf dieser Datei).');
}
process.exit(0);
