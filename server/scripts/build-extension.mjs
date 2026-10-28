// Baut die Browser Erweiterung für diese Installation: Name und Adresse (PUBLIC_URL) werden eingesetzt
// und je ein ZIP für Chrome/Edge und Firefox nach web/downloads geschrieben. Läuft beim Containerstart.
import 'dotenv/config';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APP_NAME, moduleEnabled } from '../server/config.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const source = process.env.EXTENSION_SOURCE || join(root, 'extension');
const target = join(root, 'web', 'downloads');

if (!moduleEnabled('vault')) process.exit(0);

let origin = '';
let url = '';
try {
  if (process.env.PUBLIC_URL) {
    const parsed = new URL(process.env.PUBLIC_URL);
    origin = parsed.origin;
    url = process.env.PUBLIC_URL.replace(/\/+$/, '');
  }
} catch {
  console.warn('[Erweiterung] PUBLIC_URL ist keine gültige Adresse, die Adresse muss im Popup eingetragen werden.');
}

const replaceAll = (text) => text
  .replaceAll('__PORTAL_URL__', url || '__PORTAL_URL__')
  .replaceAll('__PORTAL_NAME__', APP_NAME);

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(js|html|json|md)$/.test(name)) writeFileSync(path, replaceAll(readFileSync(path, 'utf8')));
  }
}

mkdirSync(target, { recursive: true });
for (const browser of ['chrome', 'firefox']) {
  const work = mkdtempSync(join(tmpdir(), `ext-${browser}-`));
  cpSync(source, work, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(work, `manifest.${browser}.json`), 'utf8'));
  manifest.host_permissions = origin ? [`${origin}/*`] : [];
  writeFileSync(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  rmSync(join(work, 'manifest.chrome.json'));
  rmSync(join(work, 'manifest.firefox.json'));
  walk(work);
  const out = join(target, `tresor-${browser}.zip`);
  rmSync(out, { force: true });
  execFileSync('zip', ['-qr', out, '.'], { cwd: work });
  rmSync(work, { recursive: true, force: true });
}
console.log(`[Erweiterung] Downloads gebaut${url ? ` für ${url}` : ' (Adresse wird im Popup eingetragen)'}`);
