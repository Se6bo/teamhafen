import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import { APP_NAME, enabledModules, hasDashboard, moduleEnabled, publicConfig } from './config.mjs';
import { initDatabase } from './db/database.mjs';
import { ensureFirstAdmin } from './db/first-admin.mjs';
import authRoutes from './routes/auth.mjs';
import userRoutes from './routes/users.mjs';
import passwordRoutes from './routes/passwords.mjs';
import webauthnRoutes from './routes/webauthn.mjs';
import { authMiddleware } from './middleware/auth.mjs';
import { rateLimit } from './middleware/rate-limit.mjs';
import docsRoutes from './routes/docs.mjs';
import uploadsRoutes, { uploadDir } from './routes/uploads.mjs';
import botDocsRoutes from './routes/bot-docs.mjs';
import jiraRoutes from './routes/jira.mjs';
import searchRoutes from './routes/search.mjs';
import docFilesRoutes from './routes/doc-files.mjs';
import wopiRoutes from './routes/wopi.mjs';
import mcpKeyRoutes from './routes/mcp-keys.mjs';
import { mcpRouter } from './mcp/server.mjs';
import { startJiraSync } from './jira/sync.mjs';
import { prepareVault } from './vault/store.mjs';

// Ohne eigene Schlüssel wäre jede Anmeldung fälschbar: dann lieber gar nicht starten
for (const name of ['JWT_SECRET', 'CRYPTO_KEY']) {
  if (!process.env[name] || process.env[name].length < 32) {
    console.error(`[Start] ${name} fehlt oder ist kürzer als 32 Zeichen. Erzeugen zum Beispiel mit: openssl rand -hex 32`);
    process.exit(1);
  }
}

const app = express();
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);
const PORT = process.env.PORT || 80;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendPath = path.join(__dirname, '../../web');
const homePage = hasDashboard() ? '/dashboard' : '/';

// Alte Adresse der Startseite weiterleiten
app.get('/start', (req, res) => res.redirect(301, homePage));

// Name und Module für die Oberfläche (keine Geheimnisse)
app.get('/config.js', (req, res) => {
  res.type('application/javascript').set('Cache-Control', 'no-cache');
  res.send(`window.APP_CONFIG = ${JSON.stringify(publicConfig())};`);
});

// Seiten abgeschalteter Module gibt es nicht; wer dort landet, kommt zur Startseite
const PAGE_MODULES = [
  [/^\/dokumentation(\.html)?$/, () => moduleEnabled('docs')],
  [/^\/sprints(\.html)?$/, () => moduleEnabled('sprints')],
  [/^\/dashboard(\.html)?$/, () => hasDashboard()],
  [/^\/downloads\//, () => moduleEnabled('vault')],
];
app.use((req, res, next) => {
  const blocked = PAGE_MODULES.find(([pattern, enabled]) => pattern.test(req.path) && !enabled());
  if (!blocked) return next();
  if (req.path.startsWith('/downloads/')) return res.status(404).type('text/plain').send('Nicht gefunden');
  res.redirect(302, '/');
});

// Statische Oberfläche (/dokumentation -> dokumentation.html, /sprints -> sprints.html)
app.use(express.static(frontendPath, { extensions: ['html'] }));

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || true,
  credentials: true
}));

// MCP Server für die KI der Benutzer. Vor dem allgemeinen Protokoll eingehängt,
// weil der Schlüssel auch in der Adresse stehen kann (/mcp/<schlüssel>) und nicht im Log landen soll.
if (moduleEnabled('ai')) app.use('/mcp', mcpRouter());
// OAuth gibt es nicht; klare 404 statt der Startseite, damit KI Programme nicht stolpern
app.use('/.well-known', (req, res) => res.status(404).json({ error: 'Not found' }));

// Body parsing (große Dokumente, auch wenn sie über die KI kommen)
app.use(express.json({ limit: '10mb' }));

// Logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Initialize database
app.locals.db = initDatabase();
await ensureFirstAdmin(app.locals.db);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', modules: enabledModules(), timestamp: new Date().toISOString() });
});

// Routen, die es immer gibt
app.use('/api/auth', rateLimit(300, 20 * 1000), authRoutes);
app.use('/api/users', authMiddleware, userRoutes);
app.use('/api/webauthn', rateLimit(300, 20 * 1000), webauthnRoutes);
app.use('/api/search', searchRoutes);

// Routen der Module
if (moduleEnabled('vault')) {
  app.use('/api/passwords', authMiddleware, passwordRoutes);
}
if (moduleEnabled('docs')) {
  app.use('/api/docs/files', docFilesRoutes);
  app.use('/api/docs', docsRoutes);
  app.use('/api/uploads', uploadsRoutes);
  app.use('/api/bot/docs', botDocsRoutes);
  app.use('/uploads', express.static(uploadDir));
  // Fehlende Dateien klar als 404 melden statt die Startseite auszuliefern
  app.use('/uploads', (req, res) => res.status(404).type('text/plain').send('Datei nicht gefunden'));
}
if (moduleEnabled('office')) {
  app.use('/wopi', wopiRoutes);
}
if (moduleEnabled('sprints')) {
  app.use('/api/jira', jiraRoutes);
}
if (moduleEnabled('ai')) {
  app.use('/api/mcp-keys', mcpKeyRoutes);
}

// Unbekannte API Adressen (auch von abgeschalteten Modulen) klar als 404 melden
app.use(['/api', '/mcp', '/wopi'], (req, res) => {
  res.status(404).json({ error: 'Nicht gefunden oder Modul nicht aktiv' });
});

// Alles andere: Startseite mit Anmeldung (und Tresor, falls aktiv)
app.use((req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// Hintergrundaufgaben der Module
if (moduleEnabled('sprints')) startJiraSync();
// Tresor-Speicher (Vaultwarden): Dienstkonto prüfen und alte Einträge einmalig kopieren
if (moduleEnabled('vault')) prepareVault();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`${APP_NAME} läuft auf Port ${PORT} mit den Modulen: ${enabledModules().join(', ')}`);
});
