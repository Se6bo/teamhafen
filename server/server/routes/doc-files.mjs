import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { getDb } from '../db/database.mjs';
import { authMiddleware } from '../middleware/auth.mjs';
import { uploadDir } from './uploads.mjs';
import { isOfficeConfigured, loadDiscovery, officeSession, extensionOf } from '../office/collabora.mjs';

// Eigenständige Dateien (PDF, Word, Excel …) in den Doku-Ordnern – neben den Dokumenten/Seiten
const router = Router();
router.use(authMiddleware);

const MAX_SIZE = 50 * 1024 * 1024;

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: MAX_SIZE },
});

function isAdmin(user) {
  return user?.role === 'admin' || user?.role === 'owner';
}

function canDelete(file, user) {
  return isAdmin(user) || Number(file.uploaded_by) === Number(user.id);
}

// Multer liefert Dateinamen als latin1; für Umlaute in UTF-8 umwandeln
function decodeName(name) {
  try {
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    return decoded.includes('�') ? name : decoded;
  } catch {
    return name;
  }
}

function folderExists(db, id) {
  return id === null || Boolean(db.prepare('SELECT id FROM doc_folders WHERE id = ?').get(id));
}

function parseFolderId(value) {
  if (value === null || value === undefined || value === '' || value === 'null') return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : NaN;
}

const SELECT_FILE = `
  SELECT f.*, u.first_name as uploader_first_name, u.last_name as uploader_last_name, u.username as uploader_username,
         e.first_name as editor_first_name, e.last_name as editor_last_name, e.username as editor_username
  FROM doc_folder_files f
  LEFT JOIN users u ON f.uploaded_by = u.id
  LEFT JOIN users e ON f.updated_by = e.id
`;

function withRights(file, user) {
  return file ? { ...file, can_delete: canDelete(file, user), missing: !existsSync(join(uploadDir, file.filename)) } : file;
}

// GET /api/docs/files – alle Dateien (die Ordnerzuordnung erledigt der Browser)
router.get('/', async (req, res) => {
  try {
    const files = getDb().prepare(`${SELECT_FILE} ORDER BY f.original_name COLLATE NOCASE`).all();
    let editable = [];
    if (isOfficeConfigured()) {
      try {
        const actions = await loadDiscovery();
        editable = Object.keys(actions || {}).filter(ext => actions[ext].edit);
      } catch {
        editable = [];
      }
    }
    res.json({ files: files.map(f => withRights(f, req.user)), officeExtensions: editable });
  } catch (error) {
    console.error('List folder files error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/docs/files – Datei hochladen (Feld "file", optional folder_id)
router.post('/', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'Die Datei ist größer als 50 MB.' : (err.message || 'Upload fehlgeschlagen');
      return res.status(400).json({ error: message });
    }
    try {
      if (!req.file) return res.status(400).json({ error: 'Keine Datei übertragen' });
      const db = getDb();
      const folderId = parseFolderId(req.body?.folder_id);
      if (Number.isNaN(folderId) || !folderExists(db, folderId)) {
        unlink(req.file.path).catch(() => {});
        return res.status(400).json({ error: 'Ordner nicht gefunden' });
      }
      const name = decodeName(req.file.originalname).slice(0, 255);
      const result = db.prepare(`
        INSERT INTO doc_folder_files (folder_id, filename, original_name, mimetype, size, uploaded_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(folderId, req.file.filename, name, req.file.mimetype || 'application/octet-stream', req.file.size, req.user.id, req.user.id);
      db.prepare('INSERT INTO activities (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(
        req.user.id, 'upload', 'folder_file', result.lastInsertRowid, `Uploaded file: ${name}`
      );
      res.status(201).json(withRights(db.prepare(`${SELECT_FILE} WHERE f.id = ?`).get(result.lastInsertRowid), req.user));
    } catch (error) {
      console.error('Upload folder file error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });
});

// PUT /api/docs/files/:id – umbenennen und/oder verschieben
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const file = db.prepare('SELECT * FROM doc_folder_files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'Datei nicht gefunden' });

    let name = file.original_name;
    if (req.body?.original_name !== undefined) {
      name = String(req.body.original_name || '').trim().replace(/[\\/]/g, '-').slice(0, 255);
      if (!name) return res.status(400).json({ error: 'Name ist erforderlich' });
      // Endung behalten, damit der Dateityp erhalten bleibt
      const oldExt = extensionOf(file.original_name);
      if (oldExt && extensionOf(name) !== oldExt) name = `${name}.${oldExt}`;
    }
    let folderId = file.folder_id ?? null;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'folder_id')) {
      folderId = parseFolderId(req.body.folder_id);
      if (Number.isNaN(folderId) || !folderExists(db, folderId)) return res.status(400).json({ error: 'Ordner nicht gefunden' });
    }
    db.prepare('UPDATE doc_folder_files SET original_name = ?, folder_id = ? WHERE id = ?').run(name, folderId, file.id);
    res.json(withRights(db.prepare(`${SELECT_FILE} WHERE f.id = ?`).get(file.id), req.user));
  } catch (error) {
    console.error('Update folder file error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/docs/files/:id – wer hochgeladen hat oder Admin
router.delete('/:id', async (req, res) => {
  try {
    const db = getDb();
    const file = db.prepare('SELECT * FROM doc_folder_files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'Datei nicht gefunden' });
    if (!canDelete(file, req.user)) return res.status(403).json({ error: 'Nur wer die Datei hochgeladen hat oder ein Admin darf sie löschen' });
    db.prepare('DELETE FROM doc_folder_files WHERE id = ?').run(file.id);
    await unlink(join(uploadDir, file.filename)).catch(() => {});
    db.prepare('INSERT INTO activities (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(
      req.user.id, 'delete', 'folder_file', file.id, `Deleted file: ${file.original_name}`
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Delete folder file error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/docs/files/:id/office – Startdaten, um die Datei in Collabora zu öffnen
router.get('/:id/office', async (req, res) => {
  try {
    const file = getDb().prepare('SELECT * FROM doc_folder_files WHERE id = ?').get(req.params.id);
    if (!file) return res.status(404).json({ error: 'Datei nicht gefunden' });
    if (!isOfficeConfigured()) return res.json({ enabled: false, reason: 'Der Office-Editor ist nicht eingerichtet.' });
    res.json(await officeSession(file, req.user));
  } catch (error) {
    console.error('Office session error:', error.message);
    res.json({ enabled: false, reason: 'Der Office-Editor ist gerade nicht erreichbar.' });
  }
});

export default router;
