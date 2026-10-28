import { Router, raw } from 'express';
import { createReadStream } from 'node:fs';
import { stat, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { getDb } from '../db/database.mjs';
import { uploadDir } from './uploads.mjs';
import { verifyWopiToken } from '../office/collabora.mjs';

// WOPI-Schnittstelle für Collabora Online. Collabora ruft sie serverseitig auf
// (intern im Docker-Netz); jede Anfrage trägt ein kurzlebiges, an die Datei gebundenes Token.
const router = Router();

function authorize(req, res) {
  const token = req.query.access_token || (req.headers.authorization || '').replace(/^Bearer /, '');
  const payload = verifyWopiToken(token, req.params.id);
  if (!payload) {
    res.status(401).end();
    return null;
  }
  const user = getDb().prepare('SELECT id, username, first_name, last_name FROM users WHERE id = ?').get(payload.uid);
  if (!user) {
    res.status(401).end();
    return null;
  }
  const file = getDb().prepare('SELECT * FROM doc_folder_files WHERE id = ?').get(req.params.id);
  if (!file) {
    res.status(404).end();
    return null;
  }
  return { user, file };
}

function displayName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username;
}

function isoDate(value) {
  const d = new Date(String(value || '').replace(' ', 'T') + (String(value || '').includes('Z') ? '' : 'Z'));
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// CheckFileInfo
router.get('/files/:id', (req, res) => {
  const ctx = authorize(req, res);
  if (!ctx) return;
  const { user, file } = ctx;
  res.json({
    BaseFileName: file.original_name,
    Size: file.size,
    OwnerId: String(file.uploaded_by ?? ''),
    UserId: String(user.id),
    UserFriendlyName: displayName(user),
    Version: `${file.size}-${isoDate(file.updated_at)}`,
    LastModifiedTime: isoDate(file.updated_at),
    UserCanWrite: true,
    UserCanNotWriteRelative: true,
    SupportsUpdate: true,
    SupportsLocks: false,
    HidePrintOption: false,
    HideSaveOption: false,
    HideExportOption: false,
    DisablePrint: false,
    EnableOwnerTermination: false,
  });
});

// GetFile
router.get('/files/:id/contents', async (req, res) => {
  const ctx = authorize(req, res);
  if (!ctx) return;
  const path = join(uploadDir, ctx.file.filename);
  try {
    const info = await stat(path);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', info.size);
    createReadStream(path).pipe(res);
  } catch {
    res.status(404).end();
  }
});

// PutFile – Collabora speichert die geänderte Datei
router.post('/files/:id/contents', raw({ type: () => true, limit: '60mb' }), async (req, res) => {
  const ctx = authorize(req, res);
  if (!ctx) return;
  const { user, file } = ctx;
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const target = join(uploadDir, file.filename);
  const tmp = `${target}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, body);
    await rename(tmp, target);
    getDb().prepare('UPDATE doc_folder_files SET size = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(body.length, user.id, file.id);
    const updated = getDb().prepare('SELECT updated_at FROM doc_folder_files WHERE id = ?').get(file.id);
    res.json({ LastModifiedTime: isoDate(updated?.updated_at) });
  } catch (error) {
    console.error('WOPI PutFile error:', error);
    res.status(500).end();
  }
});

// Sperren, "Speichern unter" usw. werden nicht unterstützt
router.post('/files/:id', (req, res) => {
  const ctx = authorize(req, res);
  if (!ctx) return;
  res.status(501).end();
});

export default router;
