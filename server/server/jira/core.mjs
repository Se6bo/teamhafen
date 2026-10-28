// Zugriff auf Jira Cloud: Konfiguration, HTTP-Aufrufe, Metadaten und Umwandlung der Jira-Daten
import { getDb } from '../db/database.mjs';

const SPRINT_FIELD_FALLBACK = 'customfield_10020';
const STORY_POINTS_FALLBACK = 'customfield_10016';
const RANK_FIELD_FALLBACK = 'customfield_10019';
const META_TTL_MS = 30 * 60 * 1000;

function config() {
  const baseUrl = (process.env.JIRA_BASE_URL || '').replace(/\/+$/, '');
  return {
    baseUrl,
    email: process.env.JIRA_EMAIL || '',
    token: process.env.JIRA_API_TOKEN || '',
    projectKey: process.env.JIRA_PROJECT_KEY || '',
    boardId: process.env.JIRA_BOARD_ID ? Number(process.env.JIRA_BOARD_ID) : null,
  };
}

function isConfigured() {
  const c = config();
  return Boolean(c.baseUrl && c.email && c.token && c.projectKey);
}

function canManage(user) {
  return user?.role === 'admin' || user?.role === 'owner';
}

class JiraError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function jiraErrorMessage(data, status) {
  if (!data) return `Jira antwortet mit HTTP ${status}`;
  const parts = [];
  if (Array.isArray(data.errorMessages)) parts.push(...data.errorMessages);
  if (data.errors && typeof data.errors === 'object') {
    for (const [field, msg] of Object.entries(data.errors)) parts.push(`${field}: ${msg}`);
  }
  if (data.message) parts.push(data.message);
  return parts.filter(Boolean).join(' · ') || `Jira antwortet mit HTTP ${status}`;
}

async function jira(path, { method = 'GET', body, query } = {}) {
  const c = config();
  const url = new URL(c.baseUrl + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${c.email}:${c.token}`).toString('base64'),
      'Accept': 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = { message: text.slice(0, 300) }; }
  }
  if (!res.ok) {
    const status = res.status === 401 || res.status === 403 ? 502 : res.status;
    const prefix = res.status === 401 ? 'Jira-Zugang ungültig (Token oder E-Mail prüfen). ' :
      res.status === 403 ? 'Keine Berechtigung in Jira. ' : '';
    throw new JiraError(status >= 500 ? 502 : status, prefix + jiraErrorMessage(data, res.status));
  }
  return data;
}

/* ---------- Atlassian Document Format <-> Text ---------- */

function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  const children = (node.content || []).map(adfToText);
  switch (node.type) {
    case 'text': return node.text || '';
    case 'hardBreak': return '\n';
    case 'mention': return node.attrs?.text || '@jemand';
    case 'emoji': return node.attrs?.text || node.attrs?.shortName || '';
    case 'inlineCard': return node.attrs?.url || '';
    case 'paragraph':
    case 'heading': return children.join('') + '\n\n';
    case 'codeBlock': return children.join('') + '\n';
    case 'listItem': return '• ' + children.join('').trim() + '\n';
    case 'bulletList':
    case 'orderedList': return children.join('');
    case 'rule': return '———\n';
    case 'tableRow': return children.map(c => c.trim()).join(' | ') + '\n';
    default: return children.join('');
  }
}

function adfToPlain(doc) {
  return adfToText(doc).replace(/\n{3,}/g, '\n\n').trim();
}

function textToAdf(text) {
  const paragraphs = String(text || '').replace(/\r\n/g, '\n').split(/\n{2,}/);
  return {
    type: 'doc',
    version: 1,
    content: paragraphs.map(p => {
      const lines = p.split('\n');
      const content = [];
      lines.forEach((line, i) => {
        if (i > 0) content.push({ type: 'hardBreak' });
        if (line) content.push({ type: 'text', text: line });
      });
      return { type: 'paragraph', content };
    }),
  };
}

/* ---------- Metadaten (gecacht) ---------- */

let metaCache = null;
let metaCacheAt = 0;

async function detectBoardId(projectKey) {
  const c = config();
  if (c.boardId) return c.boardId;
  const data = await jira('/rest/agile/1.0/board', { query: { projectKeyOrId: projectKey, type: 'scrum', maxResults: 10 } });
  const board = data?.values?.[0];
  if (!board) throw new JiraError(404, `Kein Scrum-Board für Projekt ${projectKey} gefunden`);
  return board.id;
}

async function loadMeta(force = false) {
  if (!force && metaCache && Date.now() - metaCacheAt < META_TTL_MS) return metaCache;
  const { projectKey, baseUrl } = config();

  const [project, boardId, fields, statusesByType, users] = await Promise.all([
    jira(`/rest/api/3/project/${encodeURIComponent(projectKey)}`),
    detectBoardId(projectKey),
    jira('/rest/api/3/field'),
    jira(`/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`),
    jira('/rest/api/3/user/assignable/search', { query: { project: projectKey, maxResults: 200 } }),
  ]);

  let boardConfig = null;
  try { boardConfig = await jira(`/rest/agile/1.0/board/${boardId}/configuration`); } catch { boardConfig = null; }

  let priorities = [];
  try {
    const p = await jira('/rest/api/3/priority/search', { query: { maxResults: 50 } });
    priorities = p?.values || [];
  } catch {
    priorities = (await jira('/rest/api/3/priority').catch(() => [])) || [];
  }

  const sprintField = fields.find(f => f.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint')?.id || SPRINT_FIELD_FALLBACK;
  const storyPointsField = boardConfig?.estimation?.field?.fieldId
    || fields.find(f => /^story point estimate$/i.test(f.name))?.id
    || fields.find(f => /^story points$/i.test(f.name))?.id
    || STORY_POINTS_FALLBACK;
  const rankField = fields.find(f => f.schema?.custom === 'com.pyxis.greenhopper.jira:gh-lexo-rank')?.id || RANK_FIELD_FALLBACK;

  const statusMap = new Map();
  for (const entry of statusesByType || []) {
    for (const s of entry.statuses || []) {
      if (!statusMap.has(s.id)) {
        statusMap.set(s.id, { id: s.id, name: s.name, category: s.statusCategory?.key || 'new' });
      }
    }
  }
  const statuses = [...statusMap.values()];

  const categoryOrder = { new: 0, indeterminate: 1, done: 2 };
  let columns = (boardConfig?.columnConfig?.columns || [])
    .map(col => ({ name: col.name, statusIds: (col.statuses || []).map(s => String(s.id)) }))
    .filter(col => col.statusIds.length);
  if (!columns.length) {
    columns = [...statuses]
      .sort((a, b) => (categoryOrder[a.category] ?? 1) - (categoryOrder[b.category] ?? 1))
      .map(s => ({ name: s.name, statusIds: [s.id] }));
  }

  metaCache = {
    baseUrl,
    projectKey,
    projectName: project.name,
    projectId: project.id,
    boardId,
    sprintField,
    storyPointsField,
    rankField,
    columns,
    statuses,
    issueTypes: (project.issueTypes || []).map(t => ({
      id: t.id, name: t.name, subtask: Boolean(t.subtask), hierarchyLevel: t.hierarchyLevel ?? 0, iconUrl: t.iconUrl,
    })),
    priorities: priorities.map(p => ({ id: p.id, name: p.name, iconUrl: p.iconUrl })),
    users: (users || [])
      .filter(u => u.accountType === 'atlassian' && u.active !== false)
      .map(u => ({ accountId: u.accountId, displayName: u.displayName, avatarUrl: u.avatarUrls?.['48x48'] || null })),
  };
  metaCacheAt = Date.now();
  return metaCache;
}

/* ---------- Zuordnung Portal-Benutzer -> Jira-Account ---------- */

function ensureMappingTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jira_user_map (
      user_id INTEGER PRIMARY KEY,
      account_id TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function resolveMapping(meta) {
  const db = getDb();
  ensureMappingTable(db);
  const portalUsers = db.prepare('SELECT id, username, first_name, last_name FROM users ORDER BY first_name, last_name').all();
  const explicit = new Map(db.prepare('SELECT user_id, account_id FROM jira_user_map').all().map(r => [r.user_id, r.account_id]));
  const byName = new Map();
  for (const u of meta.users) byName.set(normalizeName(u.displayName), u.accountId);

  return portalUsers.map(u => {
    const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ');
    if (explicit.has(u.id)) {
      return { userId: u.id, username: u.username, name: fullName || u.username, accountId: explicit.get(u.id) || null, auto: false };
    }
    const accountId = byName.get(normalizeName(fullName)) || byName.get(normalizeName(u.username)) || null;
    return { userId: u.id, username: u.username, name: fullName || u.username, accountId, auto: true };
  });
}

function accountIdFor(meta, userId) {
  return resolveMapping(meta).find(m => m.userId === userId)?.accountId || null;
}

function portalUserName(userId) {
  const u = getDb().prepare('SELECT username, first_name, last_name FROM users WHERE id = ?').get(userId);
  if (!u) return 'Portal';
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username;
}

/* ---------- Issue-Formatierung ---------- */

function issueFields(meta) {
  return [
    'summary', 'status', 'issuetype', 'assignee', 'reporter', 'priority', 'parent', 'labels',
    'created', 'updated', 'duedate', 'subtasks', meta.sprintField, meta.storyPointsField, meta.rankField,
  ];
}

function simplifyUser(u) {
  if (!u) return null;
  return { accountId: u.accountId, displayName: u.displayName, avatarUrl: u.avatarUrls?.['48x48'] || null };
}

function simplifyIssue(issue, meta) {
  const f = issue.fields || {};
  const sprints = Array.isArray(f[meta.sprintField]) ? f[meta.sprintField] : [];
  const openSprint = sprints.find(s => s.state === 'active') || sprints.find(s => s.state === 'future') || null;
  return {
    id: issue.id,
    key: issue.key,
    url: `${meta.baseUrl}/browse/${issue.key}`,
    summary: f.summary || '',
    status: f.status ? { id: f.status.id, name: f.status.name, category: f.status.statusCategory?.key || 'new' } : null,
    type: f.issuetype ? { id: f.issuetype.id, name: f.issuetype.name, subtask: Boolean(f.issuetype.subtask), iconUrl: f.issuetype.iconUrl } : null,
    assignee: simplifyUser(f.assignee),
    reporter: simplifyUser(f.reporter),
    priority: f.priority ? { id: f.priority.id, name: f.priority.name, iconUrl: f.priority.iconUrl } : null,
    parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary || '', type: f.parent.fields?.issuetype?.name || '' } : null,
    labels: f.labels || [],
    storyPoints: f[meta.storyPointsField] ?? null,
    sprint: openSprint ? { id: openSprint.id, name: openSprint.name, state: openSprint.state } : null,
    // Rohdaten für die Synchronisation: der Browser leitet Sprint und Reihenfolge daraus selbst ab
    sprintIds: sprints.map(sp => sp.id),
    rank: f[meta.rankField] || '',
    subtaskCount: (f.subtasks || []).length,
    subtasksDone: (f.subtasks || []).filter(s => s.fields?.status?.statusCategory?.key === 'done').length,
    duedate: f.duedate || null,
    created: f.created,
    updated: f.updated,
  };
}

async function searchIssues(jql, meta, limit = 5000) {
  const issues = [];
  let nextPageToken;
  do {
    const data = await jira('/rest/api/3/search/jql', {
      method: 'POST',
      body: { jql, fields: issueFields(meta), maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) },
    });
    issues.push(...(data.issues || []));
    nextPageToken = data.isLast === false ? data.nextPageToken : undefined;
  } while (nextPageToken && issues.length < limit);
  return issues.map(i => simplifyIssue(i, meta));
}

function buildFields(body, meta, { creating }) {
  const fields = {};
  if (creating) fields.project = { key: meta.projectKey };
  if (body.summary !== undefined) {
    const summary = String(body.summary || '').trim();
    if (!summary) throw new JiraError(400, 'Titel ist erforderlich');
    fields.summary = summary.slice(0, 255);
  }
  if (body.typeId) fields.issuetype = { id: String(body.typeId) };
  if (body.description !== undefined) fields.description = body.description ? textToAdf(body.description) : null;
  if (body.assigneeId !== undefined) fields.assignee = body.assigneeId ? { accountId: body.assigneeId } : null;
  if (body.priorityId) fields.priority = { id: String(body.priorityId) };
  if (body.parentKey !== undefined) {
    if (body.parentKey) fields.parent = { key: String(body.parentKey) };
    else if (!creating) fields.parent = null;
  }
  if (body.labels !== undefined) {
    fields.labels = (Array.isArray(body.labels) ? body.labels : String(body.labels).split(','))
      .map(l => String(l).trim().replace(/\s+/g, '-'))
      .filter(Boolean);
  }
  if (body.storyPoints !== undefined) {
    const sp = body.storyPoints === '' || body.storyPoints === null ? null : Number(body.storyPoints);
    if (sp !== null && Number.isNaN(sp)) throw new JiraError(400, 'Story Points müssen eine Zahl sein');
    fields[meta.storyPointsField] = sp;
  }
  if (body.duedate !== undefined) fields.duedate = body.duedate || null;
  if (creating) {
    // Leere Felder weglassen: Jira lehnt Felder ab, die nicht auf der Erstellmaske des Typs liegen
    for (const [k, v] of Object.entries(fields)) {
      if (v === null || (Array.isArray(v) && !v.length)) delete fields[k];
    }
  }
  return fields;
}

async function moveIssues(keys, target) {
  if (!keys.length) return;
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    if (target === 'backlog') {
      await jira('/rest/agile/1.0/backlog/issue', { method: 'POST', body: { issues: chunk } });
    } else {
      await jira(`/rest/agile/1.0/sprint/${Number(target)}/issue`, { method: 'POST', body: { issues: chunk } });
    }
  }
}

function simplifySprint(s) {
  return {
    id: s.id, name: s.name, state: s.state, goal: s.goal || '',
    startDate: s.startDate || null, endDate: s.endDate || null, completeDate: s.completeDate || null,
  };
}

async function listSprints(boardId, states) {
  const sprints = [];
  let startAt = 0;
  for (;;) {
    const data = await jira(`/rest/agile/1.0/board/${boardId}/sprint`, { query: { state: states, startAt, maxResults: 50 } });
    sprints.push(...(data.values || []));
    if (data.isLast !== false || !data.values?.length) break;
    startAt += data.values.length;
  }
  return sprints.map(simplifySprint);
}

export {
  config,
  isConfigured,
  canManage,
  JiraError,
  jira,
  adfToText,
  adfToPlain,
  textToAdf,
  loadMeta,
  ensureMappingTable,
  resolveMapping,
  accountIdFor,
  portalUserName,
  issueFields,
  simplifyUser,
  simplifyIssue,
  searchIssues,
  buildFields,
  moveIssues,
  simplifySprint,
  listSprints,
};
