// Gemeinsame Regeln für Doku-Inhalte. Dieselbe Datei läuft im Browser (Editor, Einfügen, Vorschau)
// und auf dem Server (API, Discord-Bot, MCP), damit überall gleich gesäubert und umgewandelt wird.
//
// Allowlist: Erlaubte Elemente bleiben, gefährliche werden samt Inhalt entfernt, alle anderen
// werden ausgepackt (der Text bleibt). Attribute sind nur die unten genannten erlaubt.
// Der Aufrufer übergibt ein „inertes“ Dokument (Browser: document.implementation.createHTMLDocument,
// Server: domino), damit beim Parsen nichts geladen oder ausgeführt wird.

const KEEP = new Set([
  'p', 'br', 'h1', 'h2', 'h3', 'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'ul', 'ol', 'li',
  'a', 'img', 'code', 'pre', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr',
]);
// Werden umbenannt statt ausgepackt, damit Zeilen und Überschriften erhalten bleiben
const RENAME = { h4: 'h3', h5: 'h3', h6: 'h3', del: 's', tfoot: 'tbody' };
// Werden samt Inhalt entfernt
const DROP = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'param', 'noscript',
  'template', 'head', 'title', 'meta', 'link', 'base', 'svg', 'math', 'form', 'input', 'button',
  'select', 'option', 'textarea', 'canvas', 'video', 'audio', 'source', 'track', 'dialog',
]);
// Block-Elemente nach dem Säubern (entscheidet, ob ein <div> zu <p> wird oder ausgepackt wird)
const BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'pre', 'blockquote', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'div']);
const ALIGNABLE = new Set(['p', 'h1', 'h2', 'h3', 'li', 'td', 'th', 'blockquote']);
const ALIGN_VALUES = new Set(['left', 'center', 'right', 'justify']);
const JIRA_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

// Typische HTML-Tags; Text wie "<VLAN-ID>" gilt damit nicht als HTML
const HTML_TAG = /<\/?(p|br|div|span|h[1-6]|strong|b|em|i|u|s|strike|del|ul|ol|li|a|img|code|pre|blockquote|table|thead|tbody|tfoot|tr|th|td|hr|font|section|article|figure|sub|sup|mark)\b[^>]*>/i;

export const MARKDOWN_OPTIONS = { gfm: true, breaks: true, async: false };

function escapeText(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Markdown-Umwandlung für Browser und Server (Aufrufer übergibt die Klasse Marked).
// Einzelne Zeilenumbrüche bleiben Umbrüche. HTML im Markdown wird nur durchgelassen, wenn es
// bekannte Tags sind (danach säubert die Allowlist); Text wie "<VLAN-ID>" bleibt sichtbar.
export function createMarkdown(MarkedClass) {
  const instance = new MarkedClass({
    ...MARKDOWN_OPTIONS,
    renderer: {
      html({ text }) {
        return hasHtmlTags(text) ? text : escapeText(text);
      },
    },
  });
  return (markdown) => instance.parse(String(markdown || ''), { async: false });
}

export function hasHtmlTags(text) {
  return HTML_TAG.test(String(text || ''));
}

// Reiner Text, der nach Markdown aussieht (Überschriften, Codeblöcke, Listen, Zitate, Tabellen)
export function looksLikeMarkdown(text) {
  return /^(#{1,6}\s|```|~~~|[-*+]\s|\d+[.)]\s|>\s|\|.*\|\s*$)/m.test(String(text || ''));
}

function safeUrl(value, image = false) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  // Browser ignorieren Steuerzeichen und Leerraum im Schema ("java\tscript:")
  const compact = raw.replace(/[\u0000- \u007f-\u009f]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact);
  if (!scheme) return raw; // relativ, z. B. /uploads/… oder #abschnitt
  const name = scheme[1].toLowerCase();
  if (name === 'http' || name === 'https' || name === 'mailto') return raw;
  if (image && name === 'data' && /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(compact)) return compact;
  return null;
}

function alignOf(el) {
  const style = el.getAttribute('style') || '';
  const m = /(?:^|;)\s*text-align\s*:\s*([a-z-]+)/i.exec(style);
  let value = (m ? m[1] : el.getAttribute('align') || '').toLowerCase();
  if (value === 'start') value = 'left';
  if (value === 'end') value = 'right';
  return ALIGN_VALUES.has(value) ? value : null;
}

function unwrap(node, align) {
  const parent = node.parentNode;
  // Ausrichtung eines ausgepackten Blocks an seine Absätze weitergeben
  if (align) {
    for (const child of node.childNodes) {
      if (child.nodeType === 1 && ALIGNABLE.has(child.nodeName.toLowerCase()) && !child.getAttribute('style')) {
        child.setAttribute('style', `text-align: ${align};`);
      }
    }
  }
  while (node.firstChild) parent.insertBefore(node.firstChild, node);
  parent.removeChild(node);
}

function rename(node, tag, doc) {
  const el = doc.createElement(tag);
  for (const a of Array.from(node.attributes)) el.setAttribute(a.name, a.value);
  while (node.firstChild) el.appendChild(node.firstChild);
  node.parentNode.replaceChild(el, node);
  return el;
}

function hasBlockChild(node) {
  return Array.from(node.childNodes).some(c => c.nodeType === 1 && BLOCK.has(c.nodeName.toLowerCase()));
}

// Gibt false zurück, wenn das Element entfernt oder ausgepackt werden soll
function cleanAttributes(el, tag, align) {
  const keep = [];
  if (tag === 'a') {
    const href = safeUrl(el.getAttribute('href'));
    if (!href) return false;
    keep.push(['href', href]);
    const title = el.getAttribute('title');
    if (title) keep.push(['title', title]);
    const classes = (el.getAttribute('class') || '').split(/\s+/);
    const key = el.getAttribute('data-jira-key') || '';
    if (classes.includes('jira-ref') && JIRA_KEY.test(key)) keep.push(['class', 'jira-ref'], ['data-jira-key', key]);
  } else if (tag === 'img') {
    const src = safeUrl(el.getAttribute('src'), true);
    if (!src) return 'drop';
    keep.push(['src', src]);
    const alt = el.getAttribute('alt');
    if (alt) keep.push(['alt', alt]);
  } else if (tag === 'td' || tag === 'th') {
    for (const name of ['colspan', 'rowspan']) {
      const n = Number(el.getAttribute(name));
      if (Number.isInteger(n) && n > 1 && n <= 50) keep.push([name, String(n)]);
    }
  }
  if (align && ALIGNABLE.has(tag)) keep.push(['style', `text-align: ${align};`]);
  for (const a of Array.from(el.attributes)) el.removeAttribute(a.name);
  for (const [name, value] of keep) el.setAttribute(name, value);
  return true;
}

function cleanChildren(parent, doc) {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 3) continue;
    if (node.nodeType !== 1) { parent.removeChild(node); continue; }
    const tag = node.nodeName.toLowerCase();
    if (DROP.has(tag)) { parent.removeChild(node); continue; }
    cleanChildren(node, doc);
    const align = alignOf(node);
    let target = RENAME[tag] || tag;
    if (tag === 'div') target = hasBlockChild(node) ? null : 'p';
    if (!target || !KEEP.has(target)) { unwrap(node, align); continue; }
    const el = target === tag ? node : rename(node, target, doc);
    const result = cleanAttributes(el, target, align);
    if (result === 'drop') el.parentNode.removeChild(el);
    else if (!result) unwrap(el, null);
  }
}

// Lose Texte und Inline-Elemente auf oberster Ebene in <p> fassen
function wrapLooseInline(root, doc) {
  const blocks = new Set(['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'li', 'pre', 'blockquote', 'table', 'hr']);
  let group = [];
  const flush = () => {
    if (group.some(n => n.nodeType === 1 || n.nodeValue.trim())) {
      const p = doc.createElement('p');
      root.insertBefore(p, group[0]);
      for (const n of group) p.appendChild(n);
    }
    group = [];
  };
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === 1 && blocks.has(node.nodeName.toLowerCase())) flush();
    else group.push(node);
  }
  flush();
}

export function sanitizeDocHtml(html, doc) {
  const root = doc.createElement('div');
  root.innerHTML = String(html || '');
  cleanChildren(root, doc);
  wrapLooseInline(root, doc);
  return root.innerHTML.trim();
}

// Inhalt fürs Speichern oder Anzeigen: HTML wird gesäubert, reiner Text gilt als Markdown.
// markdown ist die Funktion aus createMarkdown().
export function normalizeDocContent(content, { doc, markdown }) {
  const text = String(content ?? '');
  if (!text.trim()) return '';
  const html = hasHtmlTags(text) ? text : markdown(text);
  return sanitizeDocHtml(html, doc);
}
