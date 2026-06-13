import { Injectable, inject } from '@angular/core';
import DOMPurify from 'dompurify';
import { Marked } from 'marked';
import { renderHighlightedCode } from '../shared/markdown-code';
import { IpcService } from './ipc.service';
import type { ExportPdfResult } from '../shared/types';

/**
 * Renders a markdown document to sanitized, syntax-highlighted HTML and hands
 * it to the main process, which shows the save dialog and prints it to a PDF
 * that keeps the SpecForge dark visual design (see electron/ipc/export.ts).
 */
@Injectable({ providedIn: 'root' })
export class PdfExportService {
  private readonly ipc = inject(IpcService);

  // Dedicated Marked instance so the highlighted-code renderer never leaks
  // into the global `marked` used by the rich-table renderer. The renderer
  // itself is shared with the AI chat (src/app/shared/markdown-code.ts).
  private readonly marked = new Marked({
    gfm: true,
    renderer: { code: renderHighlightedCode },
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
