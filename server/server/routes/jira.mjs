import { Router } from 'express';
import { getDb } from '../db/database.mjs';
import { APP_NAME } from '../config.mjs';
import { authMiddleware } from '../middleware/auth.mjs';
import {
  config, isConfigured, canManage, JiraError, jira, adfToPlain, textToAdf, loadMeta,
  ensureMappingTable, resolveMapping, accountIdFor, portalUserName, issueFields, simplifyUser,
  simplifyIssue, searchIssues, buildFields, moveIssues, simplifySprint,
} from '../jira/core.mjs';
import {
  runSync, syncIssueKeys, syncSprintsNow, forgetIssues, childKeys, cachedIssue,
  upsertIssue, touchActivity, changesSince, syncStatus,
} from '../jira/sync.mjs';

// Jira-Cloud-Anbindung: Das Portal ist nur eine Oberfläche, alle Sprints und
// Aufgaben liegen in Jira. Lesen geschieht aus dem synchronisierten Spiegel
// (jira/sync.mjs), Schreiben direkt in Jira mit anschließendem Abgleich.
const router = Router();
router.use(authMiddleware);

// Kommentare und Zeitbuchungen, die die KI eines Benutzers über MCP schreibt, sind gekennzeichnet
function viaLabel(req) {
  return req.user?.via === 'mcp' ? ', per KI' : '';
}

// Den Spiegel nach einer Änderung auffrischen; ein Fehler dabei soll die eigentliche Aktion nicht scheitern lassen
async function refreshMirror(task) {
  try { await task(); } catch (e) { console.error('[Jira-Sync] Nachladen fehlgeschlagen:', e.message); }
}

/* ---------- Routen ---------- */

// Nicht konfiguriert -> verständliche Meldung statt Fehler
router.use((req, res, next) => {
  if (req.path === '/status' || isConfigured()) return next();
  res.status(503).json({ error: 'Jira ist noch nicht verbunden. JIRA_BASE_URL, JIRA_EMAIL und JIRA_API_TOKEN in server/.env eintragen.' });
});

router.get('/status', (req, res) => {
  const c = config();
  res.json({ configured: isConfigured(), baseUrl: c.baseUrl || null, projectKey: c.projectKey, sync: isConfigured() ? syncStatus() : null });
});

router.get('/meta', async (req, res) => {
  const meta = await loadMeta(req.query.refresh === '1');
  const mapping = resolveMapping(meta);
  res.json({
    ...meta,
    mapping,
    me: { userId: req.user.id, accountId: mapping.find(m => m.userId === req.user.id)?.accountId || null },
    canManage: canManage(req.user),
  });
});

router.put('/mapping/:userId', (req, res) => {
  if (!canManage(req.user)) return res.status(403).json({ error: 'Nur Admins dürfen die Zuordnung ändern' });
  const db = getDb();
  ensureMappingTable(db);
  const userId = Number(req.params.userId);
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) return res.status(404).json({ error: 'Benutzer nicht gefunden' });
  const accountId = req.body?.accountId ? String(req.body.accountId) : null;
  if (req.body?.auto) db.prepare('DELETE FROM jira_user_map WHERE user_id = ?').run(userId);
  else db.prepare('INSERT INTO jira_user_map (user_id, account_id) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET account_id = excluded.account_id').run(userId, accountId);
  res.json({ success: true });
});

// Synchronisation: Änderungen seit einer Revision (since=0 -> kompletter Stand)
router.get('/changes', async (req, res) => {
  touchActivity();
  res.json(await changesSince(req.query.since));
});

// Sofort mit Jira abgleichen ("Jetzt synchronisieren")
router.post('/sync', async (req, res) => {
  touchActivity();
  const result = await runSync({ full: req.query.full === '1' });
  res.json({ ...result, sync: syncStatus() });
});

// Sprints
router.post('/sprints', async (req, res) => {
  const meta = await loadMeta();
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name ist erforderlich' });
  const sprint = await jira('/rest/agile/1.0/sprint', {
    method: 'POST',
    body: {
      name: name.slice(0, 30),
      originBoardId: meta.boardId,
      goal: req.body?.goal || undefined,
      startDate: req.body?.startDate || undefined,
      endDate: req.body?.endDate || undefined,
    },
  });
  await refreshMirror(syncSprintsNow);
  res.status(201).json(simplifySprint(sprint));
});

router.put('/sprints/:id', async (req, res) => {
  const id = Number(req.params.id);
  const body = {};
  for (const key of ['name', 'goal', 'startDate', 'endDate']) {
    if (req.body?.[key] !== undefined) body[key] = req.body[key] || null;
  }
  if (body.name) body.name = String(body.name).trim().slice(0, 30);

  if (req.body?.state === 'active') {
    const current = await jira(`/rest/agile/1.0/sprint/${id}`);
    body.state = 'active';
    body.startDate = body.startDate || current.startDate || new Date().toISOString();
    body.endDate = body.endDate || current.endDate;
    if (!body.endDate) return res.status(400).json({ error: 'Zum Starten wird ein Enddatum benötigt' });
  }

  let moved = [];
  if (req.body?.state === 'closed') {
    // Offene Aufgaben vorher verschieben, damit nichts im abgeschlossenen Sprint hängen bleibt
    const meta = await loadMeta();
    const open = await searchIssues(`sprint = ${id} AND statusCategory != Done AND issuetype not in subTaskIssueTypes()`, meta);
    const target = req.body?.moveOpenTo || 'backlog';
    moved = open.map(i => i.key);
    await moveIssues(moved, target);
    body.state = 'closed';
  }

  const sprint = await jira(`/rest/agile/1.0/sprint/${id}`, { method: 'POST', body });
  await refreshMirror(async () => {
    await syncSprintsNow();
    if (moved.length) await syncIssueKeys([...moved, ...moved.flatMap(childKeys)]);
  });
  res.json(simplifySprint(sprint));
});

router.delete('/sprints/:id', async (req, res) => {
  const id = Number(req.params.id);
  const sprint = await jira(`/rest/agile/1.0/sprint/${id}`);
  if (sprint.state !== 'future') return res.status(400).json({ error: 'Nur geplante (noch nicht gestartete) Sprints können gelöscht werden' });
  await jira(`/rest/agile/1.0/sprint/${id}`, { method: 'DELETE' });
  await refreshMirror(syncSprintsNow);
  res.json({ success: true });
});

// Aufgaben: Details (Beschreibung, Kommentare, mögliche Statuswechsel) kommen live aus Jira
router.get('/issues/:key', async (req, res) => {
  touchActivity();
  const meta = await loadMeta();
  const key = encodeURIComponent(req.params.key);
  const [issue, transitions, comments] = await Promise.all([
    jira(`/rest/api/3/issue/${key}`, { query: { fields: [...issueFields(meta), 'description', 'timetracking'].join(',') } }),
    jira(`/rest/api/3/issue/${key}/transitions`),
    jira(`/rest/api/3/issue/${key}/comment`, { query: { orderBy: '-created', maxResults: 50 } }),
  ]);
  const simple = simplifyIssue(issue, meta);
  // Frische Daten gleich in den Spiegel übernehmen
  upsertIssue(simple);
  const subtasks = issue.fields?.subtasks?.length
    ? await searchIssues(`parent = ${issue.key} ORDER BY created ASC`, meta)
    : [];
  res.json({
    ...simple,
    description: adfToPlain(issue.fields?.description),
    timeSpent: issue.fields?.timetracking?.timeSpent || null,
    transitions: (transitions.transitions || []).map(t => ({ id: t.id, name: t.name, toId: t.to?.id, toName: t.to?.name })),
    comments: (comments.comments || []).map(c => ({
      id: c.id, author: simplifyUser(c.author), created: c.created, body: adfToPlain(c.body),
    })),
    subtasks,
  });
});

router.post('/issues', async (req, res) => {
  const meta = await loadMeta();
  const type = meta.issueTypes.find(t => t.id === String(req.body?.typeId));
  if (!type) return res.status(400).json({ error: 'Unbekannter Aufgabentyp' });
  if (type.subtask && !req.body?.parentKey) return res.status(400).json({ error: 'Ein Subtask braucht eine übergeordnete Aufgabe' });

  const fields = buildFields({ ...req.body, summary: req.body?.summary ?? '' }, meta, { creating: true });
  const reporterId = accountIdFor(meta, req.user.id);

  let created;
  try {
    created = await jira('/rest/api/3/issue', { method: 'POST', body: { fields: reporterId ? { ...fields, reporter: { accountId: reporterId } } : fields } });
  } catch (e) {
    // Reporter setzen ist nicht in jedem Projekt erlaubt -> ohne Reporter erneut versuchen
    if (reporterId && e.status === 400 && /reporter/i.test(e.message)) {
      created = await jira('/rest/api/3/issue', { method: 'POST', body: { fields } });
    } else {
      throw e;
    }
  }

  if (req.body?.sprintId && !type.subtask) await moveIssues([created.key], Number(req.body.sprintId));
  await refreshMirror(() => syncIssueKeys([created.key, req.body?.parentKey]));
  res.status(201).json({ key: created.key, url: `${meta.baseUrl}/browse/${created.key}` });
});

router.put('/issues/:key', async (req, res) => {
  const meta = await loadMeta();
  const fields = buildFields(req.body || {}, meta, { creating: false });
  if (Object.keys(fields).length) {
    await jira(`/rest/api/3/issue/${encodeURIComponent(req.params.key)}`, { method: 'PUT', body: { fields } });
  }
  await refreshMirror(() => syncIssueKeys([req.params.key]));
  res.json({ success: true });
});

router.put('/issues/:key/assignee', async (req, res) => {
  await jira(`/rest/api/3/issue/${encodeURIComponent(req.params.key)}/assignee`, {
    method: 'PUT',
    body: { accountId: req.body?.accountId || null },
  });
  await refreshMirror(() => syncIssueKeys([req.params.key]));
  res.json({ success: true });
});

router.post('/issues/:key/transition', async (req, res) => {
  const key = encodeURIComponent(req.params.key);
  const statusId = String(req.body?.statusId || '');
  const { transitions = [] } = await jira(`/rest/api/3/issue/${key}/transitions`);
  const transition = transitions.find(t => String(t.to?.id) === statusId) || transitions.find(t => String(t.id) === String(req.body?.transitionId));
  if (!transition) return res.status(400).json({ error: 'Dieser Statuswechsel ist in Jira nicht erlaubt' });
  await jira(`/rest/api/3/issue/${key}/transitions`, { method: 'POST', body: { transition: { id: transition.id } } });
  await refreshMirror(() => syncIssueKeys([req.params.key]));
  res.json({ success: true, status: transition.to?.name });
});

router.post('/issues/:key/move', async (req, res) => {
  const target = req.body?.target;
  if (target !== 'backlog' && !Number(target)) return res.status(400).json({ error: 'Ziel-Sprint fehlt' });
  await moveIssues([req.params.key], target);
  // Unteraufgaben wandern in Jira mit, ihr "updated" ändert sich dabei aber nicht unbedingt
  await refreshMirror(() => syncIssueKeys([req.params.key, ...childKeys(req.params.key)]));
  res.json({ success: true });
});

router.post('/issues/:key/comments', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Kommentar ist leer' });
  const author = portalUserName(req.user.id);
  const comment = await jira(`/rest/api/3/issue/${encodeURIComponent(req.params.key)}/comment`, {
    method: 'POST',
    body: { body: textToAdf(`[${author} über ${APP_NAME}${viaLabel(req)}]\n${text}`) },
  });
  res.status(201).json({ id: comment.id });
});

router.post('/issues/:key/worklog', async (req, res) => {
  const timeSpent = String(req.body?.timeSpent || '').trim();
  if (!/^(\d+(\.\d+)?\s*[wdhm]\s*)+$/i.test(timeSpent)) return res.status(400).json({ error: 'Zeit im Format z. B. "1h 30m" angeben' });
  const author = portalUserName(req.user.id);
  await jira(`/rest/api/3/issue/${encodeURIComponent(req.params.key)}/worklog`, {
    method: 'POST',
    body: { timeSpent, comment: textToAdf(`[${author} über ${APP_NAME}${viaLabel(req)}] ${req.body?.comment || ''}`.trim()) },
  });
  res.status(201).json({ success: true });
});

router.delete('/issues/:key', async (req, res) => {
  if (!canManage(req.user)) return res.status(403).json({ error: 'Nur Admins dürfen Aufgaben löschen' });
  const subtasks = childKeys(req.params.key);
  const parentKey = cachedIssue(req.params.key)?.parent?.key;
  await jira(`/rest/api/3/issue/${encodeURIComponent(req.params.key)}`, { method: 'DELETE', query: { deleteSubtasks: 'true' } });
  forgetIssues([req.params.key, ...subtasks]);
  if (parentKey) await refreshMirror(() => syncIssueKeys([parentKey]));
  res.json({ success: true });
});

router.use((err, req, res, next) => {
  if (err instanceof JiraError) return res.status(err.status).json({ error: err.message });
  console.error('Jira route error:', err);
  res.status(502).json({ error: 'Jira ist gerade nicht erreichbar' });
});

export default router;
