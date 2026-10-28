import { Router } from 'express';
import { getDb } from '../db/database.mjs';
import { authMiddleware } from '../middleware/auth.mjs';
import { isConfigured } from '../jira/core.mjs';
import { allCachedIssues } from '../jira/sync.mjs';
import { searchEntries } from '../vault/store.mjs';
import { moduleEnabled } from '../config.mjs';

// Globale Suche (Strg+K) über Dokumente, Ordner, Jira-Aufgaben (aus dem Spiegel) und den Tresor.
// Vom Tresor werden nur Name, Benutzername und Adresse durchsucht und zurückgegeben – nie Passwörter.
const router = Router();
router.use(authMiddleware);

const LIMIT = 8;

function plainText(html) {
  return String(html || '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6])[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function snippet(text, q) {
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return text.slice(0, 120);
  const start = Math.max(0, idx - 50);
  return (start > 0 ? '… ' : '') + text.slice(start, idx + q.length + 70) + (idx + q.length + 70 < text.length ? ' …' : '');
}

function folderPaths(db) {
  const folders = db.prepare('SELECT id, name, parent_id FROM doc_folders').all();
  const byId = new Map(folders.map(f => [f.id, f]));
  const pathOf = (id) => {
    const parts = [];
    const seen = new Set();
    let current = byId.get(id);
    while (current && !seen.has(current.id)) {
      parts.unshift(current.name);
      seen.add(current.id);
      current = byId.get(current.parent_id);
    }
    return parts.join(' › ');
  };
  return { folders, pathOf };
}

// GET /api/search?q=...
router.get('/', async (req, res) => {
  try {
    const raw = String(req.query.q || '').trim();
    if (raw.length < 2) return res.json({ docs: [], files: [], folders: [], issues: [], vault: [] });
    const q = raw.toLowerCase();
    const db = getDb();
    const { folders, pathOf } = folderPaths(db);

    // Dokumente: Titel-Treffer zuerst, dann Inhalts-Treffer
    const withDocs = moduleEnabled('docs');
    const docs = !withDocs ? [] : db.prepare('SELECT id, title, content, folder_id, updated_at FROM documentation').all()
      .map(d => {
        const text = plainText(d.content);
        const inTitle = d.title.toLowerCase().includes(q);
        const inText = text.toLowerCase().includes(q);
        if (!inTitle && !inText) return null;
        return {
          id: d.id,
          title: d.title,
          path: pathOf(d.folder_id) || 'Dokumentation',
          snippet: inText ? snippet(text, q) : '',
          updated_at: d.updated_at,
          score: (inTitle ? 2 : 0) + (d.title.toLowerCase().startsWith(q) ? 1 : 0),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || String(b.updated_at).localeCompare(String(a.updated_at)))
      .slice(0, LIMIT)
      .map(({ score, ...d }) => d);

    const files = !withDocs ? [] : db.prepare('SELECT id, original_name, folder_id, size, updated_at FROM doc_folder_files').all()
      .filter(f => f.original_name.toLowerCase().includes(q))
      .sort((a, b) => a.original_name.localeCompare(b.original_name, 'de'))
      .slice(0, LIMIT)
      .map(f => ({ id: f.id, name: f.original_name, path: pathOf(f.folder_id) || 'Dokumentation' }));

    const folderHits = !withDocs ? [] : folders
      .filter(f => f.name.toLowerCase().includes(q))
      .slice(0, LIMIT)
      .map(f => ({ id: f.id, name: f.name, path: pathOf(f.parent_id) || 'Dokumentation' }));

    // Jira-Aufgaben aus dem synchronisierten Spiegel (keine Anfrage an Jira)
    let issues = [];
    if (moduleEnabled('sprints') && isConfigured()) {
      issues = allCachedIssues()
        .map(i => {
          const key = i.key.toLowerCase();
          const hay = `${i.summary} ${(i.labels || []).join(' ')} ${i.assignee?.displayName || ''}`.toLowerCase();
          if (key !== q && !key.startsWith(q) && !hay.includes(q)) return null;
          return {
            key: i.key,
            summary: i.summary,
            status: i.status,
            type: i.type?.name || '',
            assignee: i.assignee?.displayName || null,
            score: key === q ? 3 : key.startsWith(q) ? 2 : i.summary.toLowerCase().includes(q) ? 1 : 0,
          };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key, 'de', { numeric: true }))
        .slice(0, LIMIT)
        .map(({ score, ...i }) => i);
    }

    // Tresor (aus Vaultwarden, entschlüsselt im Server); private Einträge findet nur ihr Besitzer
    const vault = !moduleEnabled('vault') ? [] : await searchEntries(req.user, raw, LIMIT).catch(() => []);

    res.json({ docs, files, folders: folderHits, issues, vault });
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
