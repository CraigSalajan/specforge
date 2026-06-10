import { Injectable, inject } from '@angular/core';
import DOMPurify from 'dompurify';
import { Marked, type Tokens } from 'marked';
import hljs from 'highlight.js/lib/common';
import { IpcService } from './ipc.service';
import type { ExportPdfResult } from '../shared/types';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders a markdown document to sanitized, syntax-highlighted HTML and hands
 * it to the main process, which shows the save dialog and prints it to a PDF
 * that keeps the SpecForge dark visual design (see electron/ipc/export.ts).
 */
@Injectable({ providedIn: 'root' })
export class PdfExportService {
  private readonly ipc = inject(IpcService);

  // Dedicated Marked instance so the highlighted-code renderer never leaks
  // into the global `marked` used by the AI panel / rich-table renderers.
  private readonly marked = new Marked({
    gfm: true,
    renderer: {
      // marked v18 renderer methods receive token objects (Tokens.Code).
      code: ({ text, lang }: Tokens.Code): string => {
        const language = (lang ?? '').trim().split(/\s+/)[0];
        const highlighted =
          language && hljs.getLanguage(language)
            ? hljs.highlight(text, { language }).value
            : escapeHtml(text);
        const langClass = language ? ` language-${escapeHtml(language)}` : '';
        return `<pre><code class="hljs${langClass}">${highlighted}</code></pre>\n`;
      },
    },
  });

  async exportMarkdown(markdown: string, filePath: string): Promise<ExportPdfResult> {
    const baseName = filePath.split(/[\\/]/).pop() ?? filePath;
    const title = baseName.replace(/\.md$/i, '');
    const html = this.marked.parse(markdown, { async: false }) as string;
    // DOMPurify keeps class attributes by default, so the hljs spans survive.
    const clean = DOMPurify.sanitize(html);
    return this.ipc.exportPdf({ html: clean, title, defaultFileName: `${title}.pdf` });
  }
}
