import { BrowserWindow, app, dialog, ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

const Channels = {
  ExportPdf: 'specforge:export-pdf',
} as const;

interface ExportPdfPayload {
  html: string;
  title: string;
  defaultFileName: string;
}

interface ExportPdfResult {
  success: boolean;
  filePath?: string;
  canceled?: boolean;
  error?: string;
}

const PRINT_TIMEOUT_MS = 15_000;
const FONT_SETTLE_DELAY_MS = 100;

/**
 * Mirrors the SpecForge design tokens (src/styles.css `@theme`) plus the
 * `.prose-preview` typography and hljs palette so the exported PDF reads as a
 * SpecForge document. printToPDF runs with `margins: 0` and `@page { margin: 0 }`
 * so the root `html` background paints the entire sheet dark (printBackground: true).
 * Per-page content insets come from a `.page-frame` spacer table: `<thead>` and
 * `<tfoot>` repeat on every printed page, and cell padding insets the sides.
 */
const EXPORT_STYLESHEET = `
  @page { margin: 0; }
  html { background: #0b0d10; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 15px;
    line-height: 1.7;
    color: #e6e9ef;
    orphans: 3;
    widows: 3;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  *, *::before, *::after { box-sizing: border-box; }
  h1 { font-size: 1.9em; font-weight: 700; margin: 0.6em 0 0.4em; border-bottom: 1px solid #232a35; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; font-weight: 600; margin: 1em 0 0.4em; }
  h3 { font-size: 1.2em; font-weight: 600; margin: 1em 0 0.3em; }
  h4, h5, h6 { font-weight: 600; margin: 1em 0 0.3em; }
  h1:first-child { margin-top: 0; }
  p { margin: 0.6em 0; }
  ul, ol { margin: 0.6em 0; padding-left: 1.6em; }
  li { margin: 0.2em 0; }
  a { color: #818cf8; text-decoration: underline; }
  blockquote { border-left: 3px solid #2f3744; padding-left: 1em; color: #9aa3b2; margin: 0.8em 0; }
  code {
    font-family: ui-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
    background: #161a22;
    padding: 0.1em 0.3em;
    border-radius: 3px;
    font-size: 0.9em;
  }
  pre {
    background: #11141a;
    border: 1px solid #232a35;
    border-radius: 8px;
    padding: 1em;
    margin: 0.8em 0;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }
  pre code {
    background: none;
    padding: 0;
    border-radius: 0;
    font-size: 13px;
    white-space: pre-wrap;
    overflow-wrap: break-word;
  }
  hr { border: none; border-top: 1px solid #232a35; margin: 1.5em 0; }
  main table { border-collapse: collapse; margin: 0.8em 0; }
  main th, main td { border: 1px solid #232a35; padding: 0.4em 0.8em; }
  main th { background: #161a22; }
  img { max-width: 100%; height: auto; border-radius: 6px; }

  /* highlight.js token palette (mirrors src/styles.css so exported code
     blocks match the editor). */
  .hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-operator { color: #818cf8; }
  .hljs-string, .hljs-selector-class, .hljs-selector-id { color: #6ee7a8; }
  .hljs-comment { color: #6b7384; font-style: italic; }
  .hljs-number, .hljs-meta { color: #f0a868; }
  .hljs-title, .hljs-function, .hljs-name { color: #7dd3fc; }
  .hljs-attr, .hljs-attribute, .hljs-variable, .hljs-params { color: #e6e9ef; }
  .hljs-built_in, .hljs-class, .hljs-punctuation { color: #9aa3b2; }

  /* Print fragmentation */
  pre, blockquote, main table, img { break-inside: avoid; }
  h1, h2, h3, h4 { break-after: avoid; }

  /* Page-inset scaffolding. printToPDF margins are 0 because Chromium
     leaves @page margin areas unpainted (white) even with printBackground.
     Insets live inside the printable area instead: thead/tfoot repeat at
     the top/bottom of every printed page, the cell padding insets the
     sides, and the root html background keeps the full sheet dark. */
  table.page-frame { width: 100%; border-collapse: collapse; margin: 0; }
  table.page-frame > thead td { height: 0.75in; padding: 0; border: none; }
  table.page-frame > tfoot td { height: 0.65in; padding: 0; border: none; }
  table.page-frame > tbody > tr > td.page-content { padding: 0 0.85in; border: none; vertical-align: top; }
`;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildExportDocument(html: string, title: string): string {
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${EXPORT_STYLESHEET}</style>`,
    '</head>',
    `<body class="export"><table class="page-frame"><thead><tr><td></td></tr></thead><tbody><tr><td class="page-content"><main>${html}</main></td></tr></tbody><tfoot><tr><td></td></tr></tfoot></table></body>`,
    '</html>',
  ].join('\n');
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  // If the timeout wins the race, the losing promise may still reject later
  // (e.g. printToPDF rejects once the handler's finally block destroys the
  // window). Attach a no-op handler so that late rejection never surfaces as
  // an unhandled rejection in the main process.
  promise.catch(() => {
    /* outcome already reported via the race */
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function assertPayload(payload: unknown): asserts payload is ExportPdfPayload {
  const p = payload as ExportPdfPayload | null;
  if (
    typeof p !== 'object' ||
    p === null ||
    typeof p.html !== 'string' ||
    typeof p.title !== 'string' ||
    typeof p.defaultFileName !== 'string'
  ) {
    throw new Error('Invalid export payload');
  }
}

export function registerExportHandlers(): void {
  ipcMain.handle(
    Channels.ExportPdf,
    async (_e, payload: ExportPdfPayload): Promise<ExportPdfResult> => {
      assertPayload(payload);

      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const save = await dialog.showSaveDialog(win, {
        title: 'Export to PDF',
        defaultPath: payload.defaultFileName,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (save.canceled || !save.filePath) return { success: false, canceled: true };

      // Loaded from a temp file rather than a data: URL — data: URLs can hit
      // length limits on large documents.
      const tempPath = path.join(app.getPath('temp'), `specforge-export-${randomUUID()}.html`);
      let printWin: BrowserWindow | null = null;
      try {
        await fs.writeFile(tempPath, buildExportDocument(payload.html, payload.title), 'utf-8');

        printWin = new BrowserWindow({
          show: false,
          webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
        });
        // loadFile resolves on did-finish-load and rejects on did-fail-load.
        await printWin.loadFile(tempPath);

        // Give web fonts a chance to resolve before printing; tolerate failures.
        try {
          await printWin.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
        } catch {
          /* fonts API unavailable — print anyway */
        }
        await new Promise((resolve) => setTimeout(resolve, FONT_SETTLE_DELAY_MS));

        // Electron ≥20: printToPDF conforms to the Chromium devtools protocol —
        // margins are in INCHES. They stay 0 so the dark page chrome runs
        // edge-to-edge; content insets come from the CSS @page margin in
        // EXPORT_STYLESHEET.
        const pdf = await withTimeout(
          printWin.webContents.printToPDF({
            pageSize: 'A4',
            printBackground: true,
            landscape: false,
            preferCSSPageSize: false,
            margins: { top: 0, bottom: 0, left: 0, right: 0 },
          }),
          PRINT_TIMEOUT_MS,
          'PDF generation timed out after 15s',
        );

        await fs.writeFile(save.filePath, pdf);
        return { success: true, filePath: save.filePath };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        // Guard isDestroyed(): if the app quits mid-export Electron destroys
        // all windows, and destroy() on a destroyed window throws — inside
        // finally that would mask the handler's result.
        if (printWin && !printWin.isDestroyed()) printWin.destroy();
        await fs.unlink(tempPath).catch(() => {
          /* temp file already gone or never written */
        });
      }
    },
  );
}
