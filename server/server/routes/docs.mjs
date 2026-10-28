import { Router } from 'express';
import multer from 'multer';
import { getDb } from '../db/database.mjs';
import { authMiddleware } from '../middleware/auth.mjs';
import { uploadDir } from './uploads.mjs';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { normalizeContent } from '../docs/content.mjs';

const router = Router();
router.use(authMiddleware);

// Neue Version (= Stand vor der Änderung) nur, wenn die letzte älter als 10 Minuten ist oder von
// jemand anderem stammt. So entsteht beim automatischen Speichern nicht bei jeder Tipp-Pause eine.
// Änderungen über die KI (MCP) werden immer versioniert.
export function shouldCreateVersion(db, docId, user) {
  if (user?.via === 'mcp') return true;
  const last = db.prepare(`
    SELECT created_by, created_at < datetime('now', '-10 minutes') AS old
    FROM doc_versions WHERE doc_id = ? ORDER BY version_number DESC LIMIT 1
  `).get(docId);
  if (!last) return true;
  return Number(last.created_by) !== Number(user?.id) || Boolean(last.old);
}

export function addVersion(db, docId, content, userId) {
  const max = db.prepare('SELECT MAX(version_number) as max_version FROM doc_versions WHERE doc_id = ?').get(docId);
  db.prepare('INSERT INTO doc_versions (doc_id, content, version_number, created_by) VALUES (?, ?, ?, ?)').run(
    docId, content || '', (max?.max_version || 0) + 1, userId
  );
}

// GET /api/docs/folders - List all folders with document counts
router.get('/folders', (req, res) => {
  try {
    const db = getDb();
    const folders = db.prepare(`
      SELECT f.*, COUNT(d.id) as doc_count
      FROM doc_folders f
      LEFT JOIN documentation d ON d.folder_id = f.id
      GROUP BY f.id
      ORDER BY f.name ASC
    `).all();
    res.json(folders);
  } catch (error) {
    console.error('Get folders error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Prüft, ob ein Ordner existiert (null = oberste Ebene)
function folderExists(db, id) {
  return id === null || Boolean(db.prepare('SELECT id FROM doc_folders WHERE id = ?').get(id));
}

// true, wenn candidateId gleich folderId ist oder darunter liegt (verhindert Ordner-Schleifen)
function isSameOrDescendant(db, candidateId, folderId) {
  let current = candidateId;
  const seen = new Set();
  while (current !== null && current !== undefined && !seen.has(current)) {
    if (Number(current) === Number(folderId)) return true;
    seen.add(current);
    current = db.prepare('SELECT parent_id FROM doc_folders WHERE id = ?').get(current)?.parent_id ?? null;
  }
  return false;
}

function parseParentId(value) {
  if (value === null || value === undefined || value === '') return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : NaN;
}

// POST /api/docs/folders - Create a folder (optional inside parent_id)
router.post('/folders', (req, res) => {
  try {
    const db = getDb();
    const { name } = req.body;
    const parentId = parseParentId(req.body.parent_id);

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    if (Number.isNaN(parentId) || !folderExists(db, parentId)) {
      return res.status(400).json({ error: 'Übergeordneter Ordner nicht gefunden' });
    }

    const result = db.prepare('INSERT INTO doc_folders (name, created_by, parent_id) VALUES (?, ?, ?)').run(name.trim(), req.user.id, parentId);
    const folder = db.prepare('SELECT *, 0 as doc_count FROM doc_folders WHERE id = ?').get(result.lastInsertRowid);

    db.prepare('INSERT INTO activities (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(
      req.user.id, 'create', 'doc_folder', result.lastInsertRowid, `Created folder: ${folder.name}`
    );

    res.status(201).json(folder);
  } catch (error) {
    console.error('Create folder error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/docs/folders/:id - Rename and/or move a folder
router.put('/folders/:id', (req, res) => {
  try {
    const db = getDb();
    const folder = db.prepare('SELECT * FROM doc_folders WHERE id = ?').get(req.params.id);
    if (!folder) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    let name = folder.name;
    if (req.body.name !== undefined) {
      name = String(req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Name is required' });
    }

    let parentId = folder.parent_id ?? null;
    if (Object.prototype.hasOwnProperty.call(req.body, 'parent_id')) {
      parentId = parseParentId(req.body.parent_id);
      if (Number.isNaN(parentId) || !folderExists(db, parentId)) {
        return res.status(400).json({ error: 'Zielordner nicht gefunden' });
      }
      if (parentId !== null && isSameOrDescendant(db, parentId, folder.id)) {
        return res.status(400).json({ error: 'Ein Ordner kann nicht in sich selbst oder einen seiner Unterordner verschoben werden' });
      }
    }

    db.prepare('UPDATE doc_folders SET name = ?, parent_id = ? WHERE id = ?').run(name, parentId, folder.id);
    db.prepare('INSERT INTO activities (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(
      req.user.id, 'update', 'doc_folder', folder.id, `Updated folder: ${name}`
    );
    res.json(db.prepare('SELECT * FROM doc_folders WHERE id = ?').get(folder.id));
  } catch (error) {
    console.error('Update folder error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/docs/folders/:id - Delete a folder (contents move to the parent folder)
router.delete('/folders/:id', (req, res) => {
  try {
    const db = getDb();
    const folder = db.prepare('SELECT * FROM doc_folders WHERE id = ?').get(req.params.id);

    if (!folder) {
      return res.status(404).json({ error: 'Folder not found' });
    }

    // Inhalt (Dokumente und Unterordner) wandert eine Ebene nach oben, statt verloren zu gehen
    const parentId = folder.parent_id ?? null;
    db.prepare('UPDATE documentation SET folder_id = ? WHERE folder_id = ?').run(parentId, folder.id);
    db.prepare('UPDATE doc_folder_files SET folder_id = ? WHERE folder_id = ?').run(parentId, folder.id);
    db.prepare('UPDATE doc_folders SET parent_id = ? WHERE parent_id = ?').run(parentId, folder.id);
    db.prepare('DELETE FROM doc_folders WHERE id = ?').run(folder.id);

    db.prepare('INSERT INTO activities (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(
      req.user.id, 'delete', 'doc_folder', req.params.id, `Deleted folder: ${folder.name}`
    );

    res.json({ message: 'Folder deleted successfully' });
  } catch (error) {
    console.error('Delete folder error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/docs - List all documentation
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const { category, folder_id } = req.query;

    const columns = req.query.light === '1'
      ? 'd.id, d.title, d.folder_id, d.author_id, d.created_at, d.updated_at'
      : 'd.*';
    let sql = `
      SELECT ${columns}, u.username as author_username, f.name as folder_name
      FROM documentation d
      LEFT JOIN users u ON d.author_id = u.id
      LEFT JOIN doc_folders f ON d.folder_id = f.id
    `;
    const params = [];
    const conditions = [];

    if (category) {
      conditions.push('d.category = ?');
      params.push(category);
    }
    if (folder_id) {
      conditions.push('d.folder_id = ?');
      params.push(folder_id);
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }

    sql += ' ORDER BY d.created_at DESC';

    const docs = db.prepare(sql).all(...params);
    res.json(docs);
  } catch (error) {
    console.error('Get docs error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/docs/mentions/:key - Dokumente, in denen eine Jira-Aufgabe (z. B. PROJ-45) vorkommt
router.get('/mentions/:key', (req, res) => {
  try {
    const key = String(req.params.key || '').toUpperCase();
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) return res.status(400).json({ error: 'Ungültiger Aufgabenschlüssel' });
    const pattern = new RegExp(`(^|[^A-Z0-9-])${key}(?![0-9])`, 'i');
    const docs = getDb().prepare(`
      SELECT d.id, d.title, d.content, d.folder_id, d.updated_at, f.name as folder_name
      FROM documentation d
      LEFT JOIN doc_folders f ON d.folder_id = f.id
      WHERE d.content LIKE ?
      ORDER BY d.updated_at DESC
    `).all(`%${key}%`);
    res.json(docs
      .filter(d => pattern.test(String(d.content || '').replace(/<[^>]+>/g, ' ')))
      .map(({ content, ...d }) => d));
  } catch (error) {
    console.error('Get mentions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/docs/:id
router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const doc = db.prepare(`
      SELECT d.*, u.username as author_username
      FROM documentation d
      LEFT JOIN users u ON d.author_id = u.id
      WHERE d.id = ?
    `).get(req.params.id);
    
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }
    
    res.json(doc);
  } catch (error) {
    console.error('Get doc error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/docs
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const { title, category, parent_id, folder_id } = req.body;
    // HTML säubern, reinen Text als Markdown umwandeln (API und MCP gehen am Browser vorbei)
    const content = req.body.content == null ? null : normalizeContent(req.body.content);

    if (!title) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const result = db.prepare(`
      INSERT INTO documentation (title, content, category, author_id, parent_id, folder_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(title, content ?? null, category || 'project', req.user.id, parent_id ?? null, folder_id || null);
    
    const doc = db.prepare('SELECT * FROM documentation WHERE id = ?').get(result.lastInsertRowid);
    
    // Create initial version
    if (content) {
      db.prepare(`
        INSERT INTO doc_versions (doc_id, content, version_number, created_by)
        VALUES (?, ?, 1, ?)
      `).run(result.lastInsertRowid, content, req.user.id);
    }
    
    db.prepare('INSERT INTO activities (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(
      req.user.id, 'create', 'doc', result.lastInsertRowid, `Created document: ${title}`
    );
    
    res.status(201).json(doc);
  } catch (error) {
    console.error('Create doc error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/docs/:id
router.put('/:id', (req, res) => {
  try {
    const db = getDb();
    const { title, category, folder_id } = req.body;
    const content = req.body.content == null ? null : normalizeContent(req.body.content);

    const doc = db.prepare('SELECT * FROM documentation WHERE id = ?').get(req.params.id);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // folder_id: null verschiebt das Dokument auf die oberste Ebene
    let folderId = doc.folder_id ?? null;
    if (Object.prototype.hasOwnProperty.call(req.body, 'folder_id')) {
      folderId = parseParentId(folder_id);
      if (Number.isNaN(folderId) || !folderExists(db, folderId)) {
        return res.status(400).json({ error: 'Ordner nicht gefunden' });
      }
    }

    // Den Stand vor der Bearbeitung als Version sichern (Regel siehe shouldCreateVersion)
    if (content !== null && content !== (doc.content || '') && shouldCreateVersion(db, doc.id, req.user)) {
      addVersion(db, doc.id, doc.content, req.user.id);
    }

    db.prepare(`
      UPDATE documentation
      SET title = COALESCE(?, title), content = COALESCE(?, content),
          category = COALESCE(?, category), folder_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(title ?? null, content ?? null, category ?? null, folderId, req.params.id);
    
    const updated = db.prepare('SELECT * FROM documentation WHERE id = ?').get(req.params.id);
    
    db.prepare('INSERT INTO activities (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(
      req.user.id, 'update', 'doc', req.params.id, `Updated document: ${updated.title}`
    );
    
    res.json(updated);
  } catch (error) {
    console.error('Update doc error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/docs/:id
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const doc = db.prepare('SELECT title FROM documentation WHERE id = ?').get(req.params.id);
    
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }
    
    const attachments = db.prepare('SELECT filename FROM doc_files WHERE doc_id = ?').all(req.params.id);
    db.prepare('DELETE FROM doc_versions WHERE doc_id = ?').run(req.params.id);
    db.prepare('DELETE FROM doc_files WHERE doc_id = ?').run(req.params.id);
    db.prepare('DELETE FROM documentation WHERE id = ?').run(req.params.id);
    for (const f of attachments) unlink(join(uploadDir, f.filename)).catch(() => {});
    
    db.prepare('INSERT INTO activities (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(
      req.user.id, 'delete', 'doc', req.params.id, `Deleted document: ${doc.title}`
    );
    
    res.json({ message: 'Document deleted successfully' });
  } catch (error) {
    console.error('Delete doc error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/docs/:id/versions
router.get('/:id/versions', (req, res) => {
  try {
    const db = getDb();
    const versions = db.prepare(`
      SELECT dv.*, u.username as author_username, u.first_name as author_first_name, u.last_name as author_last_name
      FROM doc_versions dv
      LEFT JOIN users u ON dv.created_by = u.id
      WHERE dv.doc_id = ?
      ORDER BY dv.version_number DESC
    `).all(req.params.id);
    
    res.json(versions);
  } catch (error) {
    console.error('Get versions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/docs/:id/restore/:version
router.post('/:id/restore/:version', (req, res) => {
  try {
    const db = getDb();
    const version = db.prepare('SELECT * FROM doc_versions WHERE doc_id = ? AND version_number = ?').get(req.params.id, parseInt(req.params.version));
    
    if (!version) {
      return res.status(404).json({ error: 'Version not found' });
    }
    
    const current = db.prepare('SELECT content FROM documentation WHERE id = ?').get(req.params.id);
    if (!current) {
      return res.status(404).json({ error: 'Document not found' });
    }
    // Alte Stände können reiner Text oder ungesäubertes HTML sein
    const restored = normalizeContent(version.content);
    // Aktuellen Stand vorher als Version sichern, damit das Wiederherstellen rückgängig gemacht werden kann
    if ((current.content || '') !== restored) {
      addVersion(db, req.params.id, current.content, req.user.id);
    }

    db.prepare('UPDATE documentation SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(restored, req.params.id);
    
    const doc = db.prepare('SELECT * FROM documentation WHERE id = ?').get(req.params.id);
    
    db.prepare('INSERT INTO activities (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(
      req.user.id, 'restore', 'doc', req.params.id, `Restored version ${req.params.version} of ${doc.title}`
    );
    
    res.json(doc);
  } catch (error) {
    console.error('Restore version error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Multer instance for doc uploads (allows all file types, up to 10MB)
const docUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const ext = extname(file.originalname).toLowerCase();
      cb(null, `${randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// POST /api/docs/:id/upload - Upload a file to a document
router.post('/:id/upload', docUpload.single('file'), (req, res) => {
  try {
    const db = getDb();

    // Check if document exists
    const doc = db.prepare('SELECT id FROM documentation WHERE id = ?').get(req.params.id);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file provided or invalid file type' });
    }

    const result = db.prepare(`
      INSERT INTO doc_files (doc_id, filename, original_name, mimetype, size, uploaded_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.params.id,
      req.file.filename,
      req.file.originalname,
      req.file.mimetype,
      req.file.size,
      req.user.id
    );

    const file = db.prepare('SELECT * FROM doc_files WHERE id = ?').get(result.lastInsertRowid);

    db.prepare('INSERT INTO activities (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(
      req.user.id, 'upload', 'doc_file', result.lastInsertRowid, `Uploaded file: ${file.original_name}`
    );

    res.status(201).json(file);
  } catch (error) {
    console.error('Upload file error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/docs/:id/files - List all files for a document
router.get('/:id/files', (req, res) => {
  try {
    const db = getDb();

    // Check if document exists
    const doc = db.prepare('SELECT id FROM documentation WHERE id = ?').get(req.params.id);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const files = db.prepare(`
      SELECT f.*, u.first_name as uploader_first_name, u.last_name as uploader_last_name, u.username as uploader_username
      FROM doc_files f
      LEFT JOIN users u ON f.uploaded_by = u.id
      WHERE f.doc_id = ?
      ORDER BY f.uploaded_at DESC
    `).all(req.params.id);

    // Dateien, die auf der Platte fehlen (z. B. vor dem Umzug ins dauerhafte Volume hochgeladen), markieren
    res.json(files.map(f => ({ ...f, missing: !existsSync(join(uploadDir, f.filename)) })));
  } catch (error) {
    console.error('Get files error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/docs/attachments/:fileId - Anhang löschen (wer ihn hochgeladen hat oder Admin)
router.delete('/attachments/:fileId', async (req, res) => {
  try {
    const db = getDb();
    const file = db.prepare('SELECT * FROM doc_files WHERE id = ?').get(req.params.fileId);
    if (!file) return res.status(404).json({ error: 'Anhang nicht gefunden' });
    const isAdmin = req.user.role === 'admin' || req.user.role === 'owner';
    if (!isAdmin && Number(file.uploaded_by) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'Nur wer den Anhang hochgeladen hat oder ein Admin darf ihn löschen' });
    }
    db.prepare('DELETE FROM doc_files WHERE id = ?').run(file.id);
    await unlink(join(uploadDir, file.filename)).catch(() => {});
    db.prepare('INSERT INTO activities (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(
      req.user.id, 'delete', 'doc_file', file.id, `Deleted file: ${file.original_name}`
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Delete attachment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
