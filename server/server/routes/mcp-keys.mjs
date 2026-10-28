import { Router } from 'express';
import { getDb } from '../db/database.mjs';
import { authMiddleware } from '../middleware/auth.mjs';
import { createKey } from '../mcp/keys.mjs';

// Verbindungsschlüssel für die eigene KI (MCP). Jeder sieht und verwaltet nur seine eigenen.
const router = Router();
router.use(authMiddleware);

const MAX_KEYS_PER_USER = 10;

router.get('/', (req, res) => {
  const keys = getDb().prepare(`
    SELECT id, name, key_prefix, created_at, last_used_at
    FROM mcp_keys WHERE user_id = ? ORDER BY created_at DESC, id DESC
  `).all(req.user.id);
  res.json(keys);
});

router.post('/', (req, res) => {
  const db = getDb();
  const name = String(req.body?.name || '').trim().slice(0, 80) || 'Meine KI';
  const count = db.prepare('SELECT COUNT(*) AS n FROM mcp_keys WHERE user_id = ?').get(req.user.id).n;
  if (count >= MAX_KEYS_PER_USER) {
    return res.status(400).json({ error: `Höchstens ${MAX_KEYS_PER_USER} Verbindungen. Bitte zuerst eine alte widerrufen.` });
  }
  const { key, hash, prefix } = createKey();
  const result = db.prepare('INSERT INTO mcp_keys (user_id, name, key_hash, key_prefix) VALUES (?, ?, ?, ?)')
    .run(req.user.id, name, hash, prefix);
  db.prepare('INSERT INTO activities (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(
    req.user.id, 'create', 'mcp_key', result.lastInsertRowid, `KI Verbindung erstellt: ${name}`
  );
  const row = db.prepare('SELECT id, name, key_prefix, created_at, last_used_at FROM mcp_keys WHERE id = ?').get(result.lastInsertRowid);
  // Der Klartext wird nur dieses eine Mal zurückgegeben
  res.status(201).json({ ...row, key });
});

router.delete('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT id, name FROM mcp_keys WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Verbindung nicht gefunden' });
  db.prepare('DELETE FROM mcp_keys WHERE id = ?').run(row.id);
  db.prepare('INSERT INTO activities (user_id, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?)').run(
    req.user.id, 'delete', 'mcp_key', row.id, `KI Verbindung widerrufen: ${row.name}`
  );
  res.json({ success: true });
});

export default router;
