// Doku-Inhalte auf dem Server säubern und umwandeln – mit genau denselben Regeln wie im Browser
// (gemeinsame Datei web/assets/doc-content.mjs, die auch der Editor lädt).
import domino from '@mixmark-io/domino';
import { Marked } from 'marked';
import { createMarkdown, hasHtmlTags, looksLikeMarkdown, normalizeDocContent, sanitizeDocHtml } from '../../../web/assets/doc-content.mjs';

const doc = domino.createDocument('');
const markdown = createMarkdown(Marked);

export { hasHtmlTags, looksLikeMarkdown };

export function sanitizeContent(html) {
  return sanitizeDocHtml(html, doc);
}

// HTML säubern, reinen Text als Markdown nach HTML umwandeln
export function normalizeContent(content) {
  return normalizeDocContent(content, { doc, markdown });
}

// Ausdrücklich als Markdown geliefert (MCP): immer umwandeln, dann säubern
export function markdownToSafeHtml(text) {
  return sanitizeDocHtml(markdown(text), doc);
}
