import hljs from 'highlight.js/lib/common';
import type { Tokens } from 'marked';

/** Minimal HTML escaping for code that highlight.js cannot handle. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Shared `marked` code renderer that token-colors fenced code blocks with
 * highlight.js (common-language bundle). Used by both the AI chat bubbles
 * (ai-panel.component.ts) and the PDF export (pdf-export.service.ts) so the
 * language set and markup stay identical; the dark token palette lives in
 * src/styles.css under the hljs-* rules.
 *
 * Unknown / missing languages fall back to escaped plain text, and
 * `hljs.highlight` itself degrades to escaped output on illegal syntax, so
 * partially streamed code never breaks rendering. Output safety: hljs only
 * adds `class` attributes to the escaped code, which DOMPurify's default
 * config preserves — both call sites sanitize the final HTML.
 */
export function renderHighlightedCode({ text, lang }: Tokens.Code): string {
  const language = (lang ?? '').trim().split(/\s+/)[0];
  const highlighted =
    language && hljs.getLanguage(language)
      ? hljs.highlight(text, { language }).value
      : escapeHtml(text);
  const langClass = language ? ` language-${escapeHtml(language)}` : '';
  return `<pre><code class="hljs${langClass}">${highlighted}</code></pre>\n`;
}
