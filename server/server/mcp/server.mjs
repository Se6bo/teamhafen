// MCP Server des Portals: Jeder Benutzer verbindet seine eigene KI mit einem persönlichen Schlüssel.
// Die KI arbeitet mit den Rechten dieses Benutzers, aber nur mit Dokumentation und Sprints.
// Der Tresor ist nicht erreichbar: Es gibt keine Werkzeuge dafür, und die intern ausgestellte
// Anmeldung (via: 'mcp') wird von authMiddleware außerhalb von /api/docs und /api/jira abgelehnt.
//
// Die Werkzeuge rufen die vorhandene Portal API intern auf. So gelten dieselben Regeln
// (Versionen, Rechte, Jira Abgleich, Aktivitätsprotokoll) wie im Browser.
import express, { Router } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { signToken } from '../auth/jwt.mjs';
import { userForKey } from './keys.mjs';
import { contentToHtml, htmlToMarkdown, plainText } from './format.mjs';
import { APP_NAME, moduleEnabled } from '../config.mjs';

// Kurzer Name für die KI Programme, aus APP_NAME abgeleitet (z. B. "teamhafen")
const SERVER_NAME = APP_NAME.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'portal';
const SERVER_VERSION = '1.1.0';
const REQUESTS_PER_MINUTE = 300;
const PART_PREFIX = 'teil-von-';

function instructions() {
  const docs = moduleEnabled('docs');
  const sprints = moduleEnabled('sprints');
  const parts = [docs && 'die Projektdokumentation (Ordner, Dokumente, Dateien wie PDF, Word und Bilder)', sprints && 'die Sprints aus dem Jira Projekt'].filter(Boolean);
  const hints = [
    '- Starte mit portal_ueberblick, dort stehen Benutzer' + (sprints ? ', aktueller Sprint, Aufgabentypen, Status und Personen.' : ' und Umfang der Doku.'),
    docs && '- Dokumente liest und schreibst du als Markdown (oder mit format "html" als HTML).' + (sprints ? ' Aufgabenschlüssel wie PROJ-12 im Text werden im Portal automatisch verlinkt.' : ''),
    docs && '- doku_bearbeiten speichert vorher immer eine Version, mit doku_versionen kannst du alte Stände ansehen und wiederherstellen.',
    docs && '- Dateien (PDF, Word, Bilder …) verschiebst du mit datei_verschieben in andere Ordner und benennst sie dort auch um. Dokumente verschiebst du mit doku_bearbeiten, Ordner mit ordner_bearbeiten.',
    sprints && '- Personen gibst du mit Namen an oder mit "ich" für den eigenen Benutzer.',
    '- Löschen ist über die KI absichtlich nicht möglich, nur im Portal selbst.',
    '- Frag nach, bevor du größere Änderungen machst' + (sprints ? ' (viele Dokumente, Sprint starten oder abschließen).' : ' (viele Dokumente auf einmal).'),
  ].filter(Boolean);
  return `Du bist mit dem Portal „${APP_NAME}“ verbunden.
Hier liegen ${parts.join(' und ')}.
Du arbeitest mit den Rechten des Benutzers, dem der Schlüssel gehört. Alles, was du änderst, sieht das ganze Team.

Hinweise:
${hints.join('\n')}`;
}

class ToolError extends Error {}

/* ---------- Hilfsfunktionen ---------- */

function compact(value) {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
      out[k] = compact(v);
    }
    return out;
  }
  return value;
}

function norm(value) {
  return String(value ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}

// Zeitpunkte in deutscher Zeit als "JJJJ-MM-TT HH:MM" (SQLite liefert UTC ohne Zeitzone)
const BERLIN = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
function dateOnly(value) {
  if (!value) return null;
  const text = String(value);
  const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) ? text.replace(' ', 'T') + 'Z' : text);
  if (Number.isNaN(date.getTime())) return text.slice(0, 16);
  return BERLIN.format(date);
}

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

// "2026-11-03" als Uhrzeit in Deutschland in ISO umwandeln (wie die Sprints Seite)
function berlinIso(value, hour) {
  if (!value) return undefined;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const d = new Date(text);
    if (Number.isNaN(d.getTime())) throw new ToolError(`Ungültiges Datum: ${text} (Format JJJJ-MM-TT)`);
    return d.toISOString();
  }
  const [y, m, d] = text.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Berlin', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(guess));
  const get = (t) => Number(parts.find(p => p.type === t)?.value);
  const shown = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(guess - (shown - guess)).toISOString();
}

function publicOrigin(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

// Interner Aufruf der Portal API mit einer kurzlebigen Anmeldung des Benutzers
function makeApi(user) {
  const token = signToken({ id: user.id, username: user.username, role: user.role, via: 'mcp' }, '10m');
  const port = process.env.PORT || 80;
  return async function api(method, path, body) {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 300) }; }
    }
    if (!res.ok) {
      const message = data?.error || data?.message || `HTTP ${res.status}`;
      throw new ToolError(res.status === 404 ? `Nicht gefunden: ${message}` : message);
    }
    return data;
  };
}

/* ---------- Dokumentation ---------- */

async function loadDocsIndex(api) {
  const [folders, docs, fileData] = await Promise.all([
    api('GET', '/api/docs/folders'),
    api('GET', '/api/docs?light=1'),
    api('GET', '/api/docs/files'),
  ]);
  const byId = new Map(folders.map(f => [Number(f.id), f]));
  const pathOf = (id) => {
    const parts = [];
    const seen = new Set();
    let current = id == null ? null : byId.get(Number(id));
    while (current && !seen.has(current.id)) {
      parts.unshift(current.name);
      seen.add(current.id);
      current = current.parent_id == null ? null : byId.get(Number(current.parent_id));
    }
    return parts.length ? parts.join(' / ') : '(oberste Ebene)';
  };
  return { folders, docs, files: fileData?.files || [], byId, pathOf };
}

function docLink(origin, id) {
  return `${origin}/dokumentation?doc=${id}`;
}

function renderTree(index, rootId, withFiles, origin) {
  const key = (v) => (v == null ? null : Number(v));
  const sortName = (a, b) => String(a).localeCompare(String(b), 'de', { numeric: true, sensitivity: 'base' });
  const lines = [];
  const walk = (folderId, depth) => {
    const pad = '  '.repeat(depth);
    index.docs.filter(d => key(d.folder_id) === folderId).sort((a, b) => sortName(a.title, b.title))
      .forEach(d => lines.push(`${pad}Dokument ${d.id}: ${d.title} (geändert ${dateOnly(d.updated_at)})`));
    if (withFiles) {
      index.files.filter(f => key(f.folder_id) === folderId).sort((a, b) => sortName(a.original_name, b.original_name))
        .forEach(f => lines.push(`${pad}Datei ${f.id}: ${f.original_name} (${formatSize(f.size)}${f.missing ? ', fehlt' : ''}) ${origin}/uploads/${f.filename}`));
    }
    index.folders.filter(f => key(f.parent_id) === folderId).sort((a, b) => sortName(a.name, b.name))
      .forEach(f => {
        lines.push(`${pad}Ordner ${f.id}: ${f.name}/`);
        walk(Number(f.id), depth + 1);
      });
  };
  walk(rootId, 0);
  return lines;
}

function folderParam(value) {
  // null oder 0 = oberste Ebene
  if (value === null || value === 0) return null;
  return value;
}

/* ---------- Jira ---------- */

async function loadJira(api) {
  const [meta, changes] = await Promise.all([api('GET', '/api/jira/meta'), api('GET', '/api/jira/changes?since=0')]);
  const sprints = changes.sprints || [];
  const sprintById = new Map(sprints.map(sp => [Number(sp.id), sp]));
  const issues = (changes.issues || []).map(issue => {
    const own = (issue.sprintIds || []).map(id => sprintById.get(Number(id))).filter(Boolean);
    const sprint = own.find(sp => sp.state === 'active') || own.find(sp => sp.state === 'future') || null;
    return { ...issue, sprint: sprint ? { id: sprint.id, name: sprint.name, state: sprint.state } : null };
  });
  const byKey = new Map(issues.map(i => [i.key, i]));
  return { meta, sprints, sprintById, issues, byKey, sync: changes.sync };
}

const CATEGORY_LABEL = { new: 'offen', indeterminate: 'in Arbeit', done: 'erledigt' };
const SPRINT_STATE = { active: 'aktiv', future: 'geplant', closed: 'abgeschlossen' };

function partOf(issue) {
  const label = (issue.labels || []).find(l => l.startsWith(PART_PREFIX));
  return label ? label.slice(PART_PREFIX.length) : null;
}

function briefIssue(i) {
  return compact({
    key: i.key,
    titel: i.summary,
    typ: i.type?.name,
    status: i.status?.name,
    zugewiesen: i.assignee?.displayName,
    punkte: i.storyPoints,
    prioritaet: i.priority?.name,
    sprint: i.sprint?.name,
    eltern: partOf(i) || i.parent?.key,
    labels: (i.labels || []).filter(l => !l.startsWith(PART_PREFIX)),
    faellig: i.duedate,
    unteraufgaben: i.subtaskCount ? `${i.subtasksDone}/${i.subtaskCount} erledigt` : null,
  });
}

function findOne(list, value, label, nameOf) {
  const wanted = norm(value);
  const exact = list.filter(x => norm(nameOf(x)) === wanted);
  if (exact.length === 1) return exact[0];
  const partial = list.filter(x => norm(nameOf(x)).includes(wanted));
  if (exact.length === 0 && partial.length === 1) return partial[0];
  const options = list.map(nameOf).join(', ');
  if (exact.length > 1 || partial.length > 1) throw new ToolError(`${label} "${value}" ist nicht eindeutig. Möglich: ${options}`);
  throw new ToolError(`${label} "${value}" nicht gefunden. Möglich: ${options}`);
}

const TYPE_SYNONYMS = {
  aufgabe: ['task', 'aufgabe'],
  task: ['task', 'aufgabe'],
  fehler: ['bug', 'fehler'],
  bug: ['bug', 'fehler'],
  teilaufgabe: ['subtask', 'sub-task', 'teilaufgabe', 'unteraufgabe'],
  unteraufgabe: ['subtask', 'sub-task', 'teilaufgabe', 'unteraufgabe'],
  subtask: ['subtask', 'sub-task', 'teilaufgabe', 'unteraufgabe'],
  story: ['story', 'user story'],
  epic: ['epic', 'epos'],
};

function resolveType(meta, value) {
  const types = meta.issueTypes || [];
  const wanted = norm(value);
  const synonyms = TYPE_SYNONYMS[wanted] || [wanted];
  const hit = types.find(t => synonyms.includes(norm(t.name)))
    || (['teilaufgabe', 'unteraufgabe', 'subtask'].includes(wanted) ? types.find(t => t.subtask) : null);
  return hit || findOne(types, value, 'Aufgabentyp', t => t.name);
}

function defaultType(meta, parent) {
  const types = meta.issueTypes || [];
  if (parent && !(parent.type?.name && /epic|epos/i.test(parent.type.name))) {
    const sub = types.find(t => t.subtask);
    if (sub) return sub;
  }
  return types.find(t => !t.subtask && /^(task|aufgabe)$/i.test(t.name))
    || types.find(t => !t.subtask && (t.hierarchyLevel ?? 0) === 0)
    || types[0];
}

function resolvePerson(meta, value) {
  if (value === null) return null;
  const wanted = norm(value);
  if (!wanted || ['niemand', 'keiner', 'keine', 'nicht zugewiesen', 'none'].includes(wanted)) return null;
  if (['ich', 'mich', 'mir', 'me'].includes(wanted)) {
    if (!meta.me?.accountId) throw new ToolError('Dein Portal Konto ist keinem Jira Konto zugeordnet. Ein Admin kann das auf der Sprints Seite unter "Zuordnung" einstellen.');
    return meta.me.accountId;
  }
  const users = meta.users || [];
  const byAccount = users.find(u => u.accountId === value);
  if (byAccount) return byAccount.accountId;
  // Portal Benutzername oder Name über die Zuordnung
  const mapped = (meta.mapping || []).find(m => m.accountId && (norm(m.username) === wanted || norm(m.name) === wanted));
  if (mapped) return mapped.accountId;
  return findOne(users, value, 'Person', u => u.displayName).accountId;
}

function resolveStatus(meta, value) {
  const statuses = meta.statuses || [];
  const wanted = norm(value);
  const exact = statuses.find(s => norm(s.name) === wanted);
  if (exact) return exact;
  const category = { offen: 'new', 'zu erledigen': 'new', todo: 'new', 'in arbeit': 'indeterminate', erledigt: 'done', fertig: 'done', done: 'done' }[wanted];
  if (category) {
    const hit = statuses.find(s => s.category === category);
    if (hit) return hit;
  }
  return findOne(statuses, value, 'Status', s => s.name);
}

function resolveSprint(jiraData, value) {
  if (value === undefined) return undefined;
  const text = norm(value);
  if (text === 'backlog') return 'backlog';
  if (['aktiv', 'aktuell', 'active', 'laufend'].includes(text)) {
    const active = jiraData.sprints.find(sp => sp.state === 'active');
    if (!active) throw new ToolError('Es läuft gerade kein Sprint.');
    return Number(active.id);
  }
  if (['naechster', 'nachster', 'next'].includes(text)) {
    const next = jiraData.sprints.filter(sp => sp.state === 'future').sort((a, b) => Number(a.id) - Number(b.id))[0];
    if (!next) throw new ToolError('Es gibt keinen geplanten Sprint.');
    return Number(next.id);
  }
  if (/^\d+$/.test(text)) {
    const id = Number(text);
    if (!jiraData.sprintById.has(id)) throw new ToolError(`Sprint ${id} ist nicht aktiv oder geplant.`);
    return id;
  }
  return Number(findOne(jiraData.sprints, value, 'Sprint', sp => sp.name).id);
}

function resolvePriority(meta, value) {
  return findOne(meta.priorities || [], value, 'Priorität', p => p.name);
}

function issueKey(value) {
  const key = String(value || '').trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) throw new ToolError(`Ungültiger Aufgabenschlüssel: ${value}`);
  return key;
}

function sprintSummary(sp, issues) {
  const own = issues.filter(i => i.sprint && Number(i.sprint.id) === Number(sp.id) && !i.type?.subtask);
  const done = own.filter(i => i.status?.category === 'done');
  const points = own.reduce((s, i) => s + (Number(i.storyPoints) || 0), 0);
  const pointsDone = done.reduce((s, i) => s + (Number(i.storyPoints) || 0), 0);
  return compact({
    id: sp.id,
    name: sp.name,
    zustand: SPRINT_STATE[sp.state] || sp.state,
    ziel: sp.goal,
    start: dateOnly(sp.startDate),
    ende: dateOnly(sp.endDate),
    aufgaben: own.length,
    erledigt: done.length,
    punkte: points ? `${pointsDone}/${points}` : null,
  });
}

/* ---------- Werkzeuge ---------- */

function buildServer({ user, origin }) {
  const api = makeApi(user);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: instructions() });

  // Werkzeuge gibt es nur für aktive Module (Doku: doku_, ordner_, datei_; Sprints: sprint, aufgabe, zeit_)
  const toolModule = (name) => (/^(doku_|ordner_|datei_)/.test(name) ? 'docs' : /^(sprint|aufgabe|zeit_)/.test(name) ? 'sprints' : null);
  const tool = (name, { title, description, input = {}, readOnly = false, idempotent = false }, fn) => {
    const needs = toolModule(name);
    if (needs && !moduleEnabled(needs)) return;
    server.registerTool(name, {
      title,
      description,
      inputSchema: input,
      annotations: { title, readOnlyHint: readOnly, destructiveHint: false, idempotentHint: idempotent || readOnly, openWorldHint: false },
    }, async (args) => {
      try {
        const result = await fn(args || {});
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        const message = e instanceof ToolError ? e.message : `Fehler: ${e.message}`;
        return { isError: true, content: [{ type: 'text', text: message }] };
      }
    });
  };

  const formatParam = z.enum(['markdown', 'html']).optional().describe('Format des Inhalts, Standard markdown');
  const personDescription = 'Name der Person, "ich" für dich selbst oder "niemand"';
  const sprintParam = z.union([z.string(), z.number().int()]).optional();

  /* ----- Überblick ----- */

  tool('portal_ueberblick', {
    title: 'Überblick',
    description: 'Wer angemeldet ist, laufender Sprint, eigene offene Aufgaben, Umfang der Doku sowie gültige Aufgabentypen, Status, Prioritäten und Personen. Am besten zuerst aufrufen.',
    readOnly: true,
  }, async () => {
    const docsIndex = moduleEnabled('docs') ? await loadDocsIndex(api) : null;
    const result = {
      portal: origin,
      angemeldet_als: compact({
        benutzer: user.username,
        name: [user.first_name, user.last_name].filter(Boolean).join(' '),
        rolle: user.role,
        verbindung: user.key_name,
      }),
      dokumentation: docsIndex ? { ordner: docsIndex.folders.length, dokumente: docsIndex.docs.length, dateien: docsIndex.files.length } : undefined,
    };
    if (!moduleEnabled('sprints')) return result;
    try {
      const jiraData = await loadJira(api);
      const { meta } = jiraData;
      const active = jiraData.sprints.find(sp => sp.state === 'active');
      const mine = meta.me?.accountId
        ? jiraData.issues.filter(i => i.assignee?.accountId === meta.me.accountId && i.status?.category !== 'done')
        : [];
      Object.assign(result, {
        jira: compact({
          projekt: `${meta.projectName} (${meta.projectKey})`,
          dein_jira_konto: meta.me?.accountId ? (meta.users || []).find(u => u.accountId === meta.me.accountId)?.displayName || 'zugeordnet' : 'nicht zugeordnet',
          laufender_sprint: active ? sprintSummary(active, jiraData.issues) : 'keiner',
          geplante_sprints: jiraData.sprints.filter(sp => sp.state === 'future').map(sp => `${sp.id}: ${sp.name}`),
          meine_offenen_aufgaben: mine.slice(0, 30).map(briefIssue),
          aufgabentypen: (meta.issueTypes || []).map(t => t.subtask ? `${t.name} (Unteraufgabe)` : t.name),
          status: (meta.statuses || []).map(s => `${s.name} (${CATEGORY_LABEL[s.category] || s.category})`),
          prioritaeten: (meta.priorities || []).map(p => p.name),
          personen: (meta.users || []).map(u => u.displayName),
          letzter_abgleich: jiraData.sync?.lastSyncAt,
        }),
      });
    } catch (e) {
      result.jira = `nicht verfügbar: ${e.message}`;
    }
    return result;
  });

  /* ----- Dokumentation ----- */

  tool('doku_struktur', {
    title: 'Doku Struktur',
    description: 'Ordnerbaum der Dokumentation mit Dokumenten (ID, Titel) und Dateien (PDF, Word … mit Download Adresse). Optional nur ab einem Ordner.',
    input: {
      ordner_id: z.number().int().optional().describe('Nur diesen Ordner und seine Unterordner zeigen'),
      mit_dateien: z.boolean().optional().describe('Dateien mit anzeigen, Standard true'),
    },
    readOnly: true,
  }, async ({ ordner_id, mit_dateien = true }) => {
    const index = await loadDocsIndex(api);
    let root = null;
    const lines = [];
    if (ordner_id) {
      if (!index.byId.has(Number(ordner_id))) throw new ToolError(`Ordner ${ordner_id} nicht gefunden`);
      root = Number(ordner_id);
      lines.push(`Ordner ${root}: ${index.pathOf(root)}/`);
    } else {
      lines.push('Dokumentation (oberste Ebene)/');
    }
    const tree = renderTree(index, root, mit_dateien, origin).map(l => '  ' + l);
    return [...lines, ...(tree.length ? tree : ['  (leer)'])].join('\n');
  });

  tool('doku_suchen', {
    title: 'Doku durchsuchen',
    description: 'Sucht in Titeln und Inhalten aller Dokumente sowie in Ordner und Dateinamen.',
    input: {
      suche: z.string().min(2).describe('Suchbegriff'),
      limit: z.number().int().min(1).max(50).optional().describe('Höchstens so viele Dokumente, Standard 15'),
    },
    readOnly: true,
  }, async ({ suche, limit = 15 }) => {
    const [index, fullDocs] = await Promise.all([loadDocsIndex(api), api('GET', '/api/docs')]);
    const q = norm(suche);
    const docs = fullDocs.map(d => {
      const text = plainText(d.content);
      const inTitle = norm(d.title).includes(q);
      const pos = norm(text).indexOf(q);
      if (!inTitle && pos < 0) return null;
      const start = Math.max(0, pos - 80);
      return {
        score: inTitle ? 2 : 1,
        updated: d.updated_at,
        hit: compact({
          id: d.id,
          titel: d.title,
          ordner: index.pathOf(d.folder_id),
          auszug: pos >= 0 ? (start > 0 ? '… ' : '') + text.slice(start, pos + q.length + 120) + ' …' : null,
          geaendert: dateOnly(d.updated_at),
        }),
      };
    }).filter(Boolean)
      .sort((a, b) => b.score - a.score || String(b.updated).localeCompare(String(a.updated)))
      .slice(0, limit)
      .map(x => x.hit);
    const folders = index.folders.filter(f => norm(f.name).includes(q)).slice(0, 10)
      .map(f => ({ id: f.id, name: f.name, pfad: index.pathOf(f.id) }));
    const files = index.files.filter(f => norm(f.original_name).includes(q)).slice(0, 10)
      .map(f => ({ id: f.id, name: f.original_name, ordner: index.pathOf(f.folder_id), url: `${origin}/uploads/${f.filename}` }));
    return compact({ dokumente: docs, ordner: folders, dateien: files }) || {};
  });

  tool('doku_lesen', {
    title: 'Dokument lesen',
    description: 'Liest ein Dokument mit Inhalt (Markdown oder HTML), Ordner, Autor und Anhängen.',
    input: {
      id: z.number().int().describe('ID des Dokuments'),
      format: formatParam,
    },
    readOnly: true,
  }, async ({ id, format = 'markdown' }) => {
    const [doc, index, attachments] = await Promise.all([
      api('GET', `/api/docs/${id}`),
      loadDocsIndex(api),
      api('GET', `/api/docs/${id}/files`).catch(() => []),
    ]);
    const content = format === 'html' ? (doc.content || '') : htmlToMarkdown(doc.content, origin);
    const head = [
      `Dokument ${doc.id}: ${doc.title}`,
      `Ordner: ${index.pathOf(doc.folder_id)}${doc.folder_id ? ` (Ordner ${doc.folder_id})` : ''}`,
      `Autor: ${doc.author_username || 'unbekannt'} · erstellt ${dateOnly(doc.created_at)} · geändert ${dateOnly(doc.updated_at)}`,
      `Im Portal: ${docLink(origin, doc.id)}`,
    ];
    if (attachments.length) {
      head.push('Anhänge:');
      for (const a of attachments) head.push(`  ${a.original_name} (${formatSize(a.size)}${a.missing ? ', fehlt' : ''}) ${origin}/uploads/${a.filename}`);
    }
    head.push(`Format: ${format}`, '────────');
    return `${head.join('\n')}\n${content || '(leer)'}`;
  });

  tool('doku_erstellen', {
    title: 'Dokument erstellen',
    description: 'Legt ein neues Dokument an.',
    input: {
      titel: z.string().min(1).describe('Titel'),
      inhalt: z.string().optional().describe('Inhalt, standardmäßig Markdown'),
      ordner_id: z.number().int().nullable().optional().describe('Zielordner, leer oder 0 = oberste Ebene'),
      format: formatParam,
    },
  }, async ({ titel, inhalt, ordner_id, format = 'markdown' }) => {
    const folderId = folderParam(ordner_id) ?? null;
    if (folderId !== null) {
      const folders = await api('GET', '/api/docs/folders');
      if (!folders.some(f => Number(f.id) === Number(folderId))) throw new ToolError(`Ordner ${folderId} nicht gefunden`);
    }
    const html = inhalt ? contentToHtml(inhalt, format, origin) : '';
    const doc = await api('POST', '/api/docs', { title: titel.trim(), content: html || null, folder_id: folderId });
    return { erstellt: true, id: doc.id, titel: doc.title, ordner_id: doc.folder_id ?? null, link: docLink(origin, doc.id) };
  });

  tool('doku_bearbeiten', {
    title: 'Dokument bearbeiten',
    description: 'Ändert Titel, Inhalt oder Ordner eines Dokuments. Der Inhalt kann ersetzt, hinten angehängt oder vorne eingefügt werden. Der alte Stand bleibt im Versionsverlauf.',
    input: {
      id: z.number().int().describe('ID des Dokuments'),
      titel: z.string().min(1).optional().describe('Neuer Titel'),
      inhalt: z.string().optional().describe('Neuer Inhalt oder Text zum Anhängen, standardmäßig Markdown'),
      modus: z.enum(['ersetzen', 'anhaengen', 'voranstellen']).optional().describe('Was mit dem Inhalt passiert, Standard ersetzen'),
      ordner_id: z.number().int().nullable().optional().describe('In diesen Ordner verschieben, null oder 0 = oberste Ebene'),
      format: formatParam,
    },
  }, async ({ id, titel, inhalt, modus = 'ersetzen', ordner_id, format = 'markdown' }) => {
    const body = {};
    if (titel !== undefined) body.title = titel.trim();
    if (inhalt !== undefined) {
      const html = contentToHtml(inhalt, format, origin);
      if (modus === 'ersetzen') {
        body.content = html;
      } else {
        const current = await api('GET', `/api/docs/${id}`);
        const old = current.content || '';
        body.content = modus === 'anhaengen' ? `${old}${old ? '\n' : ''}${html}` : `${html}${old ? '\n' : ''}${old}`;
      }
    }
    if (ordner_id !== undefined) body.folder_id = folderParam(ordner_id);
    if (!Object.keys(body).length) throw new ToolError('Nichts zu ändern: titel, inhalt oder ordner_id angeben.');
    const doc = await api('PUT', `/api/docs/${id}`, body);
    return compact({ gespeichert: true, id: doc.id, titel: doc.title, ordner_id: doc.folder_id, link: docLink(origin, doc.id) });
  });

  tool('doku_versionen', {
    title: 'Versionen eines Dokuments',
    description: 'Listet die gespeicherten Versionen eines Dokuments. Mit "version" wird der Inhalt dieser Version gezeigt.',
    input: {
      id: z.number().int().describe('ID des Dokuments'),
      version: z.number().int().optional().describe('Diese Version mit Inhalt anzeigen'),
      format: formatParam,
    },
    readOnly: true,
  }, async ({ id, version, format = 'markdown' }) => {
    const versions = await api('GET', `/api/docs/${id}/versions`);
    if (version !== undefined) {
      const v = versions.find(x => Number(x.version_number) === Number(version));
      if (!v) throw new ToolError(`Version ${version} nicht gefunden. Vorhanden: ${versions.map(x => x.version_number).join(', ') || 'keine'}`);
      const content = format === 'html' ? (v.content || '') : htmlToMarkdown(v.content, origin);
      return `Version ${v.version_number} von Dokument ${id} · ${v.author_username || 'unbekannt'} · ${dateOnly(v.created_at)}\n────────\n${content || '(leer)'}`;
    }
    return {
      dokument: id,
      hinweis: 'Eine Version ist jeweils der Stand vor einer Änderung.',
      versionen: versions.map(v => compact({
        version: v.version_number,
        von: [v.author_first_name, v.author_last_name].filter(Boolean).join(' ') || v.author_username,
        zeitpunkt: dateOnly(v.created_at),
        zeichen: plainText(v.content).length,
      })),
    };
  });

  tool('doku_version_wiederherstellen', {
    title: 'Version wiederherstellen',
    description: 'Setzt ein Dokument auf eine frühere Version zurück. Der aktuelle Stand wird vorher selbst als Version gesichert.',
    input: {
      id: z.number().int().describe('ID des Dokuments'),
      version: z.number().int().describe('Nummer der Version'),
    },
  }, async ({ id, version }) => {
    const doc = await api('POST', `/api/docs/${id}/restore/${version}`);
    return { wiederhergestellt: true, id: doc.id, titel: doc.title, version, link: docLink(origin, doc.id) };
  });

  tool('ordner_erstellen', {
    title: 'Ordner erstellen',
    description: 'Legt einen Ordner in der Dokumentation an, optional in einem anderen Ordner.',
    input: {
      name: z.string().min(1).describe('Name des Ordners'),
      eltern_id: z.number().int().nullable().optional().describe('Übergeordneter Ordner, leer oder 0 = oberste Ebene'),
    },
  }, async ({ name, eltern_id }) => {
    const folder = await api('POST', '/api/docs/folders', { name: name.trim(), parent_id: folderParam(eltern_id) ?? null });
    return { erstellt: true, id: folder.id, name: folder.name, eltern_id: folder.parent_id ?? null };
  });

  tool('ordner_bearbeiten', {
    title: 'Ordner umbenennen oder verschieben',
    description: 'Benennt einen Ordner um oder verschiebt ihn in einen anderen Ordner.',
    input: {
      id: z.number().int().describe('ID des Ordners'),
      name: z.string().min(1).optional().describe('Neuer Name'),
      eltern_id: z.number().int().nullable().optional().describe('Neuer übergeordneter Ordner, null oder 0 = oberste Ebene'),
    },
  }, async ({ id, name, eltern_id }) => {
    const body = {};
    if (name !== undefined) body.name = name.trim();
    if (eltern_id !== undefined) body.parent_id = folderParam(eltern_id);
    if (!Object.keys(body).length) throw new ToolError('Nichts zu ändern: name oder eltern_id angeben.');
    const folder = await api('PUT', `/api/docs/folders/${id}`, body);
    return { gespeichert: true, id: folder.id, name: folder.name, eltern_id: folder.parent_id ?? null };
  });

  tool('datei_verschieben', {
    title: 'Datei verschieben oder umbenennen',
    description: 'Verschiebt eine Datei der Dokumentation (PDF, Word, Excel, Bild …, in doku_struktur als "Datei <id>") in einen anderen Ordner und benennt sie optional um. Die Dateiendung bleibt erhalten. Löschen ist nicht möglich.',
    input: {
      id: z.number().int().describe('ID der Datei, z. B. 12 bei "Datei 12" in doku_struktur'),
      ordner_id: z.number().int().nullable().optional().describe('Zielordner, null oder 0 = oberste Ebene; weglassen = Ordner bleibt gleich'),
      neuer_name: z.string().min(1).optional().describe('Neuer Dateiname; fehlt die Endung, wird die alte angehängt'),
    },
  }, async ({ id, ordner_id, neuer_name }) => {
    const body = {};
    if (ordner_id !== undefined) body.folder_id = folderParam(ordner_id);
    if (neuer_name !== undefined) body.original_name = neuer_name.trim();
    if (!Object.keys(body).length) throw new ToolError('Nichts zu ändern: ordner_id oder neuer_name angeben.');
    const file = await api('PUT', `/api/docs/files/${id}`, body);
    const index = await loadDocsIndex(api);
    return compact({
      gespeichert: true,
      id: file.id,
      name: file.original_name,
      ordner_id: file.folder_id ?? 0,
      ordner: index.pathOf(file.folder_id),
      url: `${origin}/uploads/${file.filename}`,
      link: `${origin}/dokumentation?file=${file.id}`,
    });
  });

  /* ----- Sprints und Aufgaben (Jira) ----- */

  tool('sprints_liste', {
    title: 'Sprints',
    description: 'Laufender und geplante Sprints mit Ziel, Zeitraum, Anzahl Aufgaben und Story Points, dazu der Umfang des Backlogs.',
    readOnly: true,
  }, async () => {
    const jiraData = await loadJira(api);
    const order = { active: 0, future: 1 };
    const backlog = jiraData.issues.filter(i => !i.sprint && !i.type?.subtask && i.status?.category !== 'done' && (i.type?.hierarchyLevel ?? 0) === 0 && !/epic|epos/i.test(i.type?.name || ''));
    return {
      sprints: [...jiraData.sprints]
        .sort((a, b) => (order[a.state] ?? 2) - (order[b.state] ?? 2) || Number(a.id) - Number(b.id))
        .map(sp => sprintSummary(sp, jiraData.issues)),
      backlog: { offene_aufgaben: backlog.length },
    };
  });

  tool('aufgaben_suchen', {
    title: 'Aufgaben suchen',
    description: 'Filtert die Jira Aufgaben des Projekts (aus dem Spiegel des Portals, daher schnell). Alle Filter sind optional und werden kombiniert.',
    input: {
      sprint: sprintParam.describe('"aktiv", "backlog", "naechster", Sprint ID oder Name'),
      status: z.string().optional().describe('Statusname oder "offen", "in Arbeit", "erledigt"'),
      zugewiesen: z.string().optional().describe(personDescription),
      typ: z.string().optional().describe('Aufgabentyp, z. B. Story, Aufgabe, Bug, Epic'),
      text: z.string().optional().describe('Sucht in Schlüssel, Titel und Labels'),
      label: z.string().optional().describe('Nur mit diesem Label'),
      eltern: z.string().optional().describe('Nur Unteraufgaben dieser Aufgabe (oder Aufgaben dieses Epics)'),
      unteraufgaben: z.boolean().optional().describe('Unteraufgaben mit anzeigen, Standard true'),
      limit: z.number().int().min(1).max(200).optional().describe('Höchstens so viele, Standard 50'),
    },
    readOnly: true,
  }, async (args) => {
    const jiraData = await loadJira(api);
    const { meta } = jiraData;
    let list = jiraData.issues;
    if (args.sprint !== undefined) {
      const target = resolveSprint(jiraData, args.sprint);
      list = target === 'backlog'
        ? list.filter(i => !i.sprint && i.status?.category !== 'done' && !/epic|epos/i.test(i.type?.name || ''))
        : list.filter(i => i.sprint && Number(i.sprint.id) === target);
    }
    if (args.status !== undefined) {
      const wanted = norm(args.status);
      const category = { offen: 'new', 'in arbeit': 'indeterminate', erledigt: 'done' }[wanted];
      if (category) list = list.filter(i => i.status?.category === category);
      else {
        const status = resolveStatus(meta, args.status);
        list = list.filter(i => String(i.status?.id) === String(status.id));
      }
    }
    if (args.zugewiesen !== undefined) {
      const accountId = resolvePerson(meta, args.zugewiesen);
      list = list.filter(i => (i.assignee?.accountId || null) === accountId);
    }
    if (args.typ !== undefined) {
      const type = resolveType(meta, args.typ);
      list = list.filter(i => String(i.type?.id) === String(type.id));
    }
    if (args.text) {
      const q = norm(args.text);
      list = list.filter(i => norm(`${i.key} ${i.summary} ${(i.labels || []).join(' ')}`).includes(q));
    }
    if (args.label) {
      const l = norm(args.label);
      list = list.filter(i => (i.labels || []).some(x => norm(x) === l));
    }
    if (args.eltern) {
      const parent = issueKey(args.eltern);
      list = list.filter(i => i.parent?.key === parent || partOf(i) === parent);
    }
    if (args.unteraufgaben === false) list = list.filter(i => !i.type?.subtask);
    const limit = args.limit || 50;
    list = [...list].sort((a, b) => String(a.rank || '').localeCompare(String(b.rank || '')) || a.key.localeCompare(b.key, 'de', { numeric: true }));
    return { gefunden: list.length, gezeigt: Math.min(limit, list.length), aufgaben: list.slice(0, limit).map(briefIssue) };
  });

  tool('aufgabe_lesen', {
    title: 'Aufgabe lesen',
    description: 'Alle Details einer Jira Aufgabe: Beschreibung, Kommentare, Unteraufgaben, mögliche Statuswechsel und Dokumente, in denen sie erwähnt wird.',
    input: { key: z.string().describe('Aufgabenschlüssel, z. B. PROJ-12') },
    readOnly: true,
  }, async ({ key }) => {
    const k = issueKey(key);
    const [issue, mentions] = await Promise.all([
      api('GET', `/api/jira/issues/${encodeURIComponent(k)}`),
      api('GET', `/api/docs/mentions/${encodeURIComponent(k)}`).catch(() => []),
    ]);
    return compact({
      ...briefIssue(issue),
      melder: issue.reporter?.displayName,
      erstellt: dateOnly(issue.created),
      geaendert: dateOnly(issue.updated),
      gebuchte_zeit: issue.timeSpent,
      jira_link: issue.url,
      portal_link: `${origin}/sprints?issue=${encodeURIComponent(k)}`,
      beschreibung: issue.description,
      moegliche_status: (issue.transitions || []).map(t => t.toName || t.name),
      unteraufgaben_liste: (issue.subtasks || []).map(briefIssue),
      kommentare: (issue.comments || []).map(c => compact({ von: c.author?.displayName, am: dateOnly(c.created), text: c.body })),
      erwaehnt_in_dokumenten: mentions.map(d => ({ id: d.id, titel: d.title })),
    });
  });

  tool('aufgabe_erstellen', {
    title: 'Aufgabe erstellen',
    description: 'Legt eine neue Jira Aufgabe an. Mit "eltern" wird sie zur Unteraufgabe (bei einem Epic zur Aufgabe im Epic).',
    input: {
      titel: z.string().min(1).describe('Titel'),
      typ: z.string().optional().describe('Aufgabentyp, Standard Aufgabe (mit eltern: Unteraufgabe)'),
      beschreibung: z.string().optional().describe('Beschreibung als einfacher Text'),
      zugewiesen: z.string().optional().describe(personDescription),
      prioritaet: z.string().optional().describe('Name der Priorität'),
      story_points: z.number().optional().describe('Story Points'),
      sprint: sprintParam.describe('"aktiv", "naechster", Sprint ID oder Name; ohne Angabe landet sie im Backlog'),
      eltern: z.string().optional().describe('Übergeordnete Aufgabe oder Epic, z. B. PROJ-4'),
      labels: z.array(z.string()).optional().describe('Labels'),
      faellig: z.string().optional().describe('Fälligkeitsdatum JJJJ-MM-TT'),
    },
  }, async (args) => {
    const jiraData = await loadJira(api);
    const { meta } = jiraData;
    let parent = null;
    let parentKey;
    const labels = [...(args.labels || [])];
    if (args.eltern) {
      const key = issueKey(args.eltern);
      parent = jiraData.byKey.get(key);
      if (!parent) {
        try { parent = await api('GET', `/api/jira/issues/${encodeURIComponent(key)}`); }
        catch { throw new ToolError(`Übergeordnete Aufgabe ${key} nicht gefunden`); }
      }
      parentKey = key;
    }
    const type = args.typ ? resolveType(meta, args.typ) : defaultType(meta, parent);
    if (type.subtask && !parent) throw new ToolError('Eine Unteraufgabe braucht "eltern".');
    // Unteraufgabe einer Unteraufgabe: in Jira Subtask der Hauptaufgabe plus Label "teil-von-…" (wie im Portal)
    if (type.subtask && parent?.type?.subtask) {
      parentKey = parent.parent?.key;
      if (!parentKey) throw new ToolError(`Zu ${parent.key} fehlt die Hauptaufgabe.`);
      labels.push(`${PART_PREFIX}${parent.key}`);
    }
    const sprint = args.sprint !== undefined ? resolveSprint(jiraData, args.sprint) : undefined;
    const body = compact({
      typeId: type.id,
      summary: args.titel,
      description: args.beschreibung,
      assigneeId: args.zugewiesen !== undefined ? resolvePerson(meta, args.zugewiesen) : undefined,
      priorityId: args.prioritaet ? resolvePriority(meta, args.prioritaet).id : undefined,
      storyPoints: args.story_points,
      parentKey,
      labels,
      duedate: args.faellig,
      sprintId: typeof sprint === 'number' ? sprint : undefined,
    });
    if (args.story_points === 0) body.storyPoints = 0;
    const created = await api('POST', '/api/jira/issues', body);
    return { erstellt: true, key: created.key, typ: type.name, jira_link: created.url, portal_link: `${origin}/sprints?issue=${encodeURIComponent(created.key)}` };
  });

  tool('aufgabe_bearbeiten', {
    title: 'Aufgabe bearbeiten',
    description: 'Ändert eine Jira Aufgabe: Felder, Status, Zuweisung und Sprint in einem Aufruf. Nur angegebene Werte werden geändert.',
    input: {
      key: z.string().describe('Aufgabenschlüssel, z. B. PROJ-12'),
      titel: z.string().min(1).optional(),
      beschreibung: z.string().optional().describe('Neue Beschreibung als einfacher Text (ersetzt die alte, Formatierung aus Jira geht dabei verloren)'),
      status: z.string().optional().describe('Neuer Status, z. B. "In Arbeit" oder "Fertig"'),
      zugewiesen: z.string().optional().describe(personDescription),
      prioritaet: z.string().optional(),
      story_points: z.number().nullable().optional().describe('null entfernt die Story Points'),
      sprint: sprintParam.describe('"aktiv", "naechster", "backlog", Sprint ID oder Name'),
      labels: z.array(z.string()).optional().describe('Ersetzt alle Labels'),
      faellig: z.string().nullable().optional().describe('JJJJ-MM-TT, null entfernt das Datum'),
      eltern: z.string().nullable().optional().describe('Neues Epic bzw. neue übergeordnete Aufgabe, null entfernt sie'),
    },
  }, async (args) => {
    const k = issueKey(args.key);
    const jiraData = await loadJira(api);
    const { meta } = jiraData;
    const current = jiraData.byKey.get(k);
    const changed = [];

    const fields = {};
    if (args.titel !== undefined) fields.summary = args.titel;
    if (args.beschreibung !== undefined) fields.description = args.beschreibung;
    if (args.prioritaet !== undefined) fields.priorityId = resolvePriority(meta, args.prioritaet).id;
    if (args.story_points !== undefined) fields.storyPoints = args.story_points;
    if (args.faellig !== undefined) fields.duedate = args.faellig;
    if (args.eltern !== undefined) fields.parentKey = args.eltern ? issueKey(args.eltern) : null;
    if (args.labels !== undefined) {
      // Interne "teil-von" Labels behalten, sonst verliert die Unteraufgabe ihren Platz
      const keep = (current?.labels || []).filter(l => l.startsWith(PART_PREFIX));
      fields.labels = [...new Set([...args.labels, ...keep])];
    }
    // Erst alles prüfen, dann schreiben
    const assignee = args.zugewiesen !== undefined ? resolvePerson(meta, args.zugewiesen) : undefined;
    const status = args.status !== undefined ? resolveStatus(meta, args.status) : undefined;
    const sprint = args.sprint !== undefined ? resolveSprint(jiraData, args.sprint) : undefined;

    if (Object.keys(fields).length) {
      await api('PUT', `/api/jira/issues/${encodeURIComponent(k)}`, fields);
      const labelOf = { summary: 'titel', description: 'beschreibung', priorityId: 'prioritaet', storyPoints: 'story_points', duedate: 'faellig', parentKey: 'eltern', labels: 'labels' };
      changed.push(...Object.keys(fields).map(f => labelOf[f] || f));
    }
    if (assignee !== undefined) {
      await api('PUT', `/api/jira/issues/${encodeURIComponent(k)}/assignee`, { accountId: assignee });
      changed.push('zugewiesen');
    }
    if (sprint !== undefined) {
      await api('POST', `/api/jira/issues/${encodeURIComponent(k)}/move`, { target: sprint });
      changed.push('sprint');
    }
    if (status !== undefined) {
      if (String(current?.status?.id) !== String(status.id)) {
        await api('POST', `/api/jira/issues/${encodeURIComponent(k)}/transition`, { statusId: status.id });
      }
      changed.push('status');
    }
    if (!changed.length) throw new ToolError('Nichts zu ändern: mindestens ein Feld angeben.');
    const fresh = await api('GET', `/api/jira/issues/${encodeURIComponent(k)}`);
    return { gespeichert: true, geaendert: changed, aufgabe: briefIssue(fresh) };
  });

  tool('aufgabe_kommentieren', {
    title: 'Kommentar schreiben',
    description: 'Schreibt einen Kommentar zu einer Jira Aufgabe. Er erscheint mit deinem Namen und dem Hinweis, dass er über die KI kam.',
    input: {
      key: z.string().describe('Aufgabenschlüssel, z. B. PROJ-12'),
      text: z.string().min(1).describe('Kommentar'),
    },
  }, async ({ key, text }) => {
    const k = issueKey(key);
    const result = await api('POST', `/api/jira/issues/${encodeURIComponent(k)}/comments`, { text });
    return { gespeichert: true, key: k, kommentar_id: result.id };
  });

  tool('zeit_buchen', {
    title: 'Zeit buchen',
    description: 'Bucht Arbeitszeit auf eine Jira Aufgabe.',
    input: {
      key: z.string().describe('Aufgabenschlüssel, z. B. PROJ-12'),
      zeit: z.string().describe('Dauer, z. B. "1h 30m", "45m", "2h"'),
      kommentar: z.string().optional().describe('Was gemacht wurde'),
    },
  }, async ({ key, zeit, kommentar }) => {
    const k = issueKey(key);
    await api('POST', `/api/jira/issues/${encodeURIComponent(k)}/worklog`, { timeSpent: zeit, comment: kommentar || '' });
    return { gebucht: true, key: k, zeit };
  });

  tool('sprint_erstellen', {
    title: 'Sprint erstellen',
    description: 'Legt einen neuen geplanten Sprint an (Name höchstens 30 Zeichen).',
    input: {
      name: z.string().min(1).max(30),
      ziel: z.string().optional().describe('Sprintziel'),
      start: z.string().optional().describe('Startdatum JJJJ-MM-TT'),
      ende: z.string().optional().describe('Enddatum JJJJ-MM-TT'),
    },
  }, async ({ name, ziel, start, ende }) => {
    const sprint = await api('POST', '/api/jira/sprints', compact({
      name, goal: ziel, startDate: berlinIso(start, 8), endDate: berlinIso(ende, 16),
    }));
    return { erstellt: true, sprint: compact({ id: sprint.id, name: sprint.name, zustand: SPRINT_STATE[sprint.state], ziel: sprint.goal, start: dateOnly(sprint.startDate), ende: dateOnly(sprint.endDate) }) };
  });

  tool('sprint_bearbeiten', {
    title: 'Sprint bearbeiten, starten oder abschließen',
    description: 'Ändert Name, Ziel oder Zeitraum eines Sprints, startet ihn oder schließt ihn ab. Beim Abschließen wandern offene Aufgaben in den Backlog oder einen anderen Sprint. Starten und Abschließen betrifft das ganze Team, vorher nachfragen.',
    input: {
      id: z.number().int().describe('Sprint ID'),
      name: z.string().min(1).max(30).optional(),
      ziel: z.string().optional(),
      start: z.string().optional().describe('JJJJ-MM-TT'),
      ende: z.string().optional().describe('JJJJ-MM-TT'),
      aktion: z.enum(['starten', 'abschliessen']).optional(),
      offene_nach: sprintParam.describe('Beim Abschließen: "backlog" (Standard), "naechster" oder Sprint ID'),
    },
  }, async ({ id, name, ziel, start, ende, aktion, offene_nach }) => {
    const body = compact({ name, goal: ziel, startDate: berlinIso(start, 8), endDate: berlinIso(ende, 16) });
    if (ziel === '') body.goal = '';
    if (aktion === 'starten') body.state = 'active';
    if (aktion === 'abschliessen') {
      body.state = 'closed';
      if (offene_nach !== undefined) {
        const jiraData = await loadJira(api);
        const target = resolveSprint(jiraData, offene_nach);
        if (target === Number(id)) throw new ToolError('Offene Aufgaben können nicht in denselben Sprint wandern.');
        body.moveOpenTo = target;
      } else {
        body.moveOpenTo = 'backlog';
      }
    }
    if (!Object.keys(body).length) throw new ToolError('Nichts zu ändern.');
    const sprint = await api('PUT', `/api/jira/sprints/${id}`, body);
    return { gespeichert: true, sprint: compact({ id: sprint.id, name: sprint.name, zustand: SPRINT_STATE[sprint.state], ziel: sprint.goal, start: dateOnly(sprint.startDate), ende: dateOnly(sprint.endDate) }) };
  });

  return server;
}

/* ---------- HTTP Endpunkt ---------- */

const usage = new Map();
function overLimit(keyId) {
  const now = Date.now();
  const entry = usage.get(keyId);
  if (!entry || now - entry.start > 60 * 1000) {
    usage.set(keyId, { start: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > REQUESTS_PER_MINUTE;
}

function rpcError(res, status, message, code = -32000) {
  return res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

function describeRpc(body) {
  const list = Array.isArray(body) ? body : [body];
  return list.map(m => (m?.method === 'tools/call' ? `tools/call ${m.params?.name}` : m?.method)).filter(Boolean).join(', ');
}

export function mcpRouter() {
  const router = Router();
  router.use(express.json({ limit: '10mb' }));

  const handle = async (req, res) => {
    const header = req.headers.authorization || '';
    const key = req.params.key || (header.startsWith('Bearer ') ? header.slice(7).trim() : '');
    const user = userForKey(key);
    // Der Schlüssel selbst wird nie protokolliert
    console.log(`${new Date().toISOString()} - ${req.method} /mcp [${user ? user.username : 'ohne gültigen Schlüssel'}] ${describeRpc(req.body)}`);
    if (!user) {
      res.set('WWW-Authenticate', `Bearer realm="${APP_NAME}"`);
      return rpcError(res, 401, 'Ungültiger oder fehlender Schlüssel. Im Portal unter Einstellungen → KI verbinden einen neuen erstellen.', -32001);
    }
    if (req.method !== 'POST') {
      res.set('Allow', 'POST');
      return rpcError(res, 405, 'Dieser Server arbeitet ohne Sitzungen, nur POST ist möglich.');
    }
    if (overLimit(user.key_id)) return rpcError(res, 429, 'Zu viele Anfragen, bitte kurz warten.');

    const server = buildServer({ user, origin: publicOrigin(req) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[MCP]', error);
      if (!res.headersSent) rpcError(res, 500, 'Interner Fehler', -32603);
    }
  };

  router.all('/', handle);
  router.all('/:key', handle);
  router.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed') return rpcError(res, 400, 'Ungültiges JSON', -32700);
    if (err?.type === 'entity.too.large') return rpcError(res, 413, 'Anfrage zu groß');
    next(err);
  });
  return router;
}
