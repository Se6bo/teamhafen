// Anbindung an Collabora Online (LibreOffice im Browser) über das WOPI-Protokoll.
// Der Browser lädt den Editor über die öffentliche Adresse (z. B. https://portal.example.org/browser/…),
// Collabora selbst holt und speichert die Datei intern direkt beim Portal-Container (WOPI_BASE_URL).
import jwt from 'jsonwebtoken';
import { moduleEnabled } from '../config.mjs';

const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const TOKEN_TTL_SECONDS = 10 * 60 * 60;

let discoveryCache = null;
let discoveryAt = 0;

function settings() {
  return {
    internalUrl: (process.env.COLLABORA_INTERNAL_URL || '').replace(/\/+$/, ''),
    wopiBase: (process.env.WOPI_BASE_URL || '').replace(/\/+$/, ''),
    secret: process.env.JWT_SECRET,
  };
}

export function isOfficeConfigured() {
  const s = settings();
  return moduleEnabled('office') && Boolean(s.internalUrl && s.wopiBase);
}

function parseAttributes(tag) {
  const attrs = {};
  for (const m of tag.matchAll(/([a-zA-Z_:-]+)="([^"]*)"/g)) attrs[m[1]] = m[2].replace(/&amp;/g, '&');
  return attrs;
}

// Welche Dateiendungen Collabora ansehen/bearbeiten kann (aus /hosting/discovery)
export async function loadDiscovery(force = false) {
  if (!isOfficeConfigured()) return null;
  if (!force && discoveryCache && Date.now() - discoveryAt < DISCOVERY_TTL_MS) return discoveryCache;
  const res = await fetch(`${settings().internalUrl}/hosting/discovery`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Collabora antwortet mit HTTP ${res.status}`);
  const xml = await res.text();
  const actions = {};
  for (const m of xml.matchAll(/<action\b[^>]*>/g)) {
    const a = parseAttributes(m[0]);
    if (!a.ext || !a.urlsrc) continue;
    const ext = a.ext.toLowerCase();
    actions[ext] = actions[ext] || {};
    actions[ext][a.name] = a.urlsrc;
  }
  discoveryCache = actions;
  discoveryAt = Date.now();
  return actions;
}

export function extensionOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

export function signWopiToken(fileId, user) {
  return jwt.sign({ typ: 'wopi', fid: Number(fileId), uid: user.id, role: user.role }, settings().secret, { expiresIn: TOKEN_TTL_SECONDS });
}

export function verifyWopiToken(token, fileId) {
  try {
    const payload = jwt.verify(String(token || ''), settings().secret);
    if (payload.typ !== 'wopi' || Number(payload.fid) !== Number(fileId)) return null;
    return payload;
  } catch {
    return null;
  }
}

// Startdaten für den Editor im Browser
export async function officeSession(file, user) {
  const actions = await loadDiscovery();
  const ext = extensionOf(file.original_name);
  const action = actions?.[ext];
  const urlsrc = action?.edit || action?.view;
  if (!urlsrc) return { enabled: false, reason: 'Dieser Dateityp kann nicht im Browser geöffnet werden.' };
  const wopiSrc = `${settings().wopiBase}/wopi/files/${file.id}`;
  const sep = urlsrc.includes('?') ? (urlsrc.endsWith('?') || urlsrc.endsWith('&') ? '' : '&') : '?';
  return {
    enabled: true,
    mode: action.edit ? 'edit' : 'view',
    actionUrl: `${urlsrc}${sep}WOPISrc=${encodeURIComponent(wopiSrc)}&lang=de`,
    accessToken: signWopiToken(file.id, user),
    accessTokenTtl: Date.now() + TOKEN_TTL_SECONDS * 1000,
  };
}
