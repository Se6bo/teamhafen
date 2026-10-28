// Spiegel der Jira-Daten in der Portal-Datenbank.
// Jira wird nur nach Änderungen gefragt ("updated in den letzten Minuten"), regelmäßig einmal
// komplett abgeglichen (um Löschungen zu erkennen) und nur, solange jemand das Portal nutzt.
// Jede Änderung bekommt eine fortlaufende Revision; Browser holen nur, was neuer ist als ihre.
import { getDb } from '../db/database.mjs';
import { isConfigured, loadMeta, searchIssues, listSprints, simplifySprint, config } from './core.mjs';

const INCREMENTAL_MS = Number(process.env.JIRA_SYNC_INTERVAL_SECONDS || 30) * 1000;
const FULL_MS = 15 * 60 * 1000;
const IDLE_MS = 10 * 60 * 1000;
const TOMBSTONE_KEEP = 2000;

const runtime = {
  running: null,
  lastSyncStartedAt: 0,
  lastSyncAt: 0,
  lastFullAt: 0,
  lastActivityAt: 0,
  lastError: null,
  timer: null,
};

let tablesReady = false;
function db() {
  const d = getDb();
  if (!tablesReady) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS jira_issue_cache (
        key TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        rev INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jira_issue_cache_rev ON jira_issue_cache(rev);
      CREATE TABLE IF NOT EXISTS jira_deleted_cache (
        key TEXT PRIMARY KEY,
        rev INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jira_sync_state (
        name TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    tablesReady = true;
  }
  return d;
}

function getState(name, fallback = null) {
  const row = db().prepare('SELECT value FROM jira_sync_state WHERE name = ?').get(name);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

function setState(name, value) {
  db().prepare('INSERT INTO jira_sync_state (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value')
    .run(name, JSON.stringify(value));
}

// Liefert eine Funktion, die beim ersten Aufruf eine neue Revision vergibt (nur wenn sich etwas ändert)
function revisionAllocator() {
  let rev = null;
  return () => {
    if (rev === null) {
      rev = Number(getState('rev', 0)) + 1;
      setState('rev', rev);
    }
    return rev;
  };
}

function upsertIssues(issues, nextRev) {
  const d = db();
  const select = d.prepare('SELECT data FROM jira_issue_cache WHERE key = ?');
  const upsert = d.prepare('INSERT INTO jira_issue_cache (key, data, rev) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, rev = excluded.rev');
  const undelete = d.prepare('DELETE FROM jira_deleted_cache WHERE key = ?');
  let changed = 0;
  for (const issue of issues) {
    const data = JSON.stringify(issue);
    if (select.get(issue.key)?.data === data) continue;
    upsert.run(issue.key, data, nextRev());
    undelete.run(issue.key);
    changed++;
  }
  return changed;
}

function markDeleted(keys, nextRev) {
  if (!keys.length) return 0;
  const d = db();
  const del = d.prepare('DELETE FROM jira_issue_cache WHERE key = ?');
  const tomb = d.prepare('INSERT INTO jira_deleted_cache (key, rev) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET rev = excluded.rev');
  const rev = nextRev();
  for (const key of keys) {
    del.run(key);
    tomb.run(key, rev);
  }
  // Alte Löschmarken aufräumen; wer so weit zurückliegt, bekommt ohnehin einen kompletten Stand
  const oldest = d.prepare('SELECT rev FROM jira_deleted_cache ORDER BY rev DESC LIMIT 1 OFFSET ?').get(TOMBSTONE_KEEP);
  if (oldest) {
    d.prepare('DELETE FROM jira_deleted_cache WHERE rev <= ?').run(oldest.rev);
    setState('tombstoneFloor', oldest.rev);
  }
  return keys.length;
}

async function syncSprintsInto(meta, nextRev) {
  const sprints = await listSprints(meta.boardId, 'active,future');
  const data = JSON.stringify(sprints);
  if (JSON.stringify(getState('sprints', null)) === data) return 0;
  setState('sprints', sprints);
  setState('sprintsRev', nextRev());
  return 1;
}

function cachedKeys() {
  return db().prepare('SELECT key FROM jira_issue_cache').all().map(r => r.key);
}

async function doSync({ full = false } = {}) {
  const startedAt = Date.now();
  const meta = await loadMeta();
  const nextRev = revisionAllocator();
  const project = `project = ${meta.projectKey}`;
  const needFull = full || !runtime.lastFullAt || startedAt - runtime.lastFullAt > FULL_MS || !getState('rev', 0);
  let changed = 0;

  if (needFull) {
    const issues = await searchIssues(`${project} ORDER BY key ASC`, meta);
    changed += upsertIssues(issues, nextRev);
    const present = new Set(issues.map(i => i.key));
    changed += markDeleted(cachedKeys().filter(k => !present.has(k)), nextRev);
    runtime.lastFullAt = startedAt;
  } else {
    // Überlappung von 2 Minuten, weil Jira "updated" nur minutengenau vergleicht
    const minutes = Math.max(2, Math.ceil((startedAt - runtime.lastSyncStartedAt) / 60000) + 2);
    const issues = await searchIssues(`${project} AND updated >= -${minutes}m ORDER BY updated DESC`, meta);
    changed += upsertIssues(issues, nextRev);
  }
  changed += await syncSprintsInto(meta, nextRev);

  runtime.lastSyncStartedAt = startedAt;
  runtime.lastSyncAt = Date.now();
  runtime.lastError = null;
  setState('lastSyncAt', new Date(runtime.lastSyncAt).toISOString());
  return { changed, full: needFull };
}

// Nur ein Abgleich gleichzeitig; weitere Aufrufer warten auf den laufenden
function runSync(options = {}) {
  if (!isConfigured()) return Promise.resolve({ changed: 0 });
  if (runtime.running) {
    if (!options.full) return runtime.running;
    return runtime.running.catch(() => {}).then(() => runSync(options));
  }
  runtime.running = doSync(options)
    .catch(err => {
      runtime.lastError = err.message;
      console.error('[Jira-Sync]', err.message);
      throw err;
    })
    .finally(() => { runtime.running = null; });
  return runtime.running;
}

// Nach einer Änderung aus dem Portal: genau diese Aufgaben sofort neu aus Jira holen
async function syncIssueKeys(keys) {
  const unique = [...new Set(keys.filter(Boolean))];
  if (!unique.length || !isConfigured()) return;
  const meta = await loadMeta();
  const nextRev = revisionAllocator();
  const issues = [];
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50).map(k => `"${String(k).replace(/"/g, '')}"`).join(',');
    issues.push(...await searchIssues(`key in (${chunk})`, meta));
  }
  upsertIssues(issues, nextRev);
  const found = new Set(issues.map(i => i.key));
  markDeleted(unique.filter(k => !found.has(k)), nextRev);
}

async function syncSprintsNow() {
  if (!isConfigured()) return;
  await syncSprintsInto(await loadMeta(), revisionAllocator());
}

function forgetIssues(keys) {
  markDeleted([...new Set(keys.filter(Boolean))], revisionAllocator());
}

// Unteraufgaben aus dem Spiegel (z. B. weil sie beim Verschieben des Eltern-Tickets mitwandern)
function childKeys(parentKey) {
  return db().prepare('SELECT key, data FROM jira_issue_cache').all()
    .filter(r => { try { return JSON.parse(r.data).parent?.key === parentKey; } catch { return false; } })
    .map(r => r.key);
}

function cachedIssue(key) {
  const row = db().prepare('SELECT data FROM jira_issue_cache WHERE key = ?').get(key);
  return row ? JSON.parse(row.data) : null;
}

function upsertIssue(issue) {
  upsertIssues([issue], revisionAllocator());
}

function touchActivity() {
  runtime.lastActivityAt = Date.now();
  if (Date.now() - runtime.lastSyncAt >= INCREMENTAL_MS && !runtime.running) runSync().catch(() => {});
}

// Änderungen seit einer Revision (since = 0 -> kompletter Stand)
async function changesSince(since) {
  since = Math.max(0, Number(since) || 0);
  // Noch leerer Spiegel: auf den laufenden ersten Abgleich warten statt einen zweiten zu starten
  if (!getState('rev', 0)) await (runtime.running ? runtime.running.catch(() => {}) : runSync({ full: true }));
  const d = db();
  const rev = Number(getState('rev', 0));
  const floor = Number(getState('tombstoneFloor', 0));
  const complete = since === 0 || since < floor || since > rev;
  const from = complete ? 0 : since;
  const issues = d.prepare('SELECT data FROM jira_issue_cache WHERE rev > ?').all(from).map(r => JSON.parse(r.data));
  const deleted = complete ? [] : d.prepare('SELECT key FROM jira_deleted_cache WHERE rev > ?').all(from).map(r => r.key);
  const sprintsRev = Number(getState('sprintsRev', 0));
  return {
    rev,
    complete,
    issues,
    deleted,
    sprints: complete || sprintsRev > from ? getState('sprints', []) : null,
    sync: syncStatus(),
  };
}

function syncStatus() {
  return {
    lastSyncAt: runtime.lastSyncAt ? new Date(runtime.lastSyncAt).toISOString() : getState('lastSyncAt', null),
    running: Boolean(runtime.running),
    error: runtime.lastError,
    intervalSeconds: Math.round(INCREMENTAL_MS / 1000),
  };
}

function allCachedIssues() {
  return db().prepare('SELECT data FROM jira_issue_cache').all().map(r => JSON.parse(r.data));
}

function cachedSprints() {
  return getState('sprints', []);
}

function startJiraSync() {
  if (runtime.timer) return;
  runtime.timer = setInterval(() => {
    if (!isConfigured() || runtime.running) return;
    if (Date.now() - runtime.lastActivityAt > IDLE_MS) return;
    if (Date.now() - runtime.lastSyncAt < INCREMENTAL_MS) return;
    runSync().catch(() => {});
  }, 5000);
  runtime.timer.unref?.();
  if (isConfigured()) console.log(`[Jira-Sync] aktiv für Projekt ${config().projectKey} (alle ${INCREMENTAL_MS / 1000}s, solange das Portal genutzt wird)`);
}

export {
  runSync,
  syncIssueKeys,
  syncSprintsNow,
  forgetIssues,
  childKeys,
  cachedIssue,
  cachedSprints,
  allCachedIssues,
  upsertIssue,
  touchActivity,
  changesSince,
  syncStatus,
  startJiraSync,
  simplifySprint,
};
