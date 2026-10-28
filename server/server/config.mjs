// Zentrale Einstellungen: Name des Portals und welche Module laufen.
//
// MODULES ist eine Liste mit Kommas, z. B. "vault" (nur Tresor) oder "vault,docs,office,sprints,ai".
//   vault    Passwort Tresor (Speicher: Vaultwarden), Browser Erweiterung
//   docs     Dokumentation mit Ordnern, Versionen und Dateien
//   office   Word, Excel und PowerPoint im Browser bearbeiten (braucht docs und Collabora)
//   sprints  Sprints und Aufgaben aus Jira
//   ai       MCP Server, damit jeder seine eigene KI mit Doku und Sprints verbindet (braucht docs oder sprints)
// Anmeldung, Benutzer, Passkeys und Suche sind immer dabei.
import 'dotenv/config';

export const ALL_MODULES = ['vault', 'docs', 'office', 'sprints', 'ai'];

function parseModules(raw) {
  const wanted = String(raw ?? ALL_MODULES.join(','))
    .split(',')
    .map(m => m.trim().toLowerCase())
    .filter(Boolean);
  const unknown = wanted.filter(m => !ALL_MODULES.includes(m));
  if (unknown.length) console.warn(`[Module] Unbekannt und ignoriert: ${unknown.join(', ')}`);
  const set = new Set(wanted.filter(m => ALL_MODULES.includes(m)));
  // Abhängigkeiten: Office nur mit Doku, KI nur mit Doku oder Sprints
  if (set.has('office') && !set.has('docs')) { set.delete('office'); console.warn('[Module] office braucht docs und ist deshalb aus.'); }
  if (set.has('ai') && !set.has('docs') && !set.has('sprints')) { set.delete('ai'); console.warn('[Module] ai braucht docs oder sprints und ist deshalb aus.'); }
  if (!set.has('vault') && !set.has('docs') && !set.has('sprints')) {
    console.warn('[Module] Kein Hauptmodul gewählt, der Tresor wird eingeschaltet.');
    set.add('vault');
  }
  return set;
}

const modules = parseModules(process.env.MODULES);

export const APP_NAME = (process.env.APP_NAME || 'Teamhafen').trim();

export function moduleEnabled(id) {
  return modules.has(id);
}

export function enabledModules() {
  return ALL_MODULES.filter(m => modules.has(m));
}

// Startseite nach der Anmeldung: Dashboard, wenn es Doku oder Sprints gibt, sonst der Tresor
export function hasDashboard() {
  return modules.has('docs') || modules.has('sprints');
}

// Was der Browser wissen darf (keine Geheimnisse)
export function publicConfig() {
  return { name: APP_NAME, modules: enabledModules(), dashboard: hasDashboard() };
}
