// Umwandlung zwischen dem HTML des Doku Editors und Markdown für die KI.
// Säubern und Markdown -> HTML laufen über dieselben Regeln wie Editor und API (docs/content.mjs).
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { hasHtmlTags, markdownToSafeHtml, sanitizeContent } from '../docs/content.mjs';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  // Einfache Zeilenumbrüche gelten beim Zurückschreiben als Umbruch (breaks: true)
  br: '',
});
turndown.use(gfm);
// Jira Verweise (<a class="jira-ref">PROJ-45</a>) als reinen Schlüssel ausgeben; der Editor verlinkt ihn wieder selbst
turndown.addRule('jiraRef', {
  filter: (node) => node.nodeName === 'A' && /\bjira-ref\b/.test(node.getAttribute('class') || ''),
  replacement: (content) => content,
});
turndown.addRule('underline', {
  filter: ['u'],
  replacement: (content) => `<u>${content}</u>`,
});

export function sanitizeHtml(html) {
  return sanitizeContent(html);
}

// Absolute Links auf das Portal (z. B. Bilder unter /uploads) relativ speichern
function stripOrigin(html, origin) {
  if (!origin) return html;
  const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return html.replace(new RegExp(`(href|src)="${escaped}(/[^"]*)"`, 'g'), '$1="$2"');
}

export function markdownToHtml(markdown, origin) {
  return stripOrigin(markdownToSafeHtml(markdown), origin).trim();
}

export function htmlToMarkdown(html, origin) {
  const source = String(html || '');
  // Inhalt ohne HTML (alte Importe, reiner Text) unverändert durchreichen
  if (!hasHtmlTags(source)) return source;
  let withOrigin = source;
  if (origin) withOrigin = source.replace(/(href|src)=(["'])(\/(uploads|sprints|dokumentation)[^"']*)\2/g, `$1=$2${origin}$3$2`);
  return turndown.turndown(withOrigin).trim();
}

export function contentToHtml(content, format, origin) {
  if (format === 'html') return stripOrigin(sanitizeContent(content), origin).trim();
  return markdownToHtml(content, origin);
}

export function plainText(html) {
  return String(html || '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
