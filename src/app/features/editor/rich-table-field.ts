// Why this exists:
//
// The `codemirror-live-markdown` package renders GFM pipe tables as an HTML
// widget, but its `TableWidget.toDOM` assigns cell text via `td.textContent` /
// `th.textContent`. That means inline markdown inside a table cell (inline code
// `like this`, **bold**, [links](url)) is shown as literal source instead of
// being formatted.
//
// This field mirrors the package's own `tableField` logic exactly (table
// parsing, decoration building, drag/selection-aware update cycle) but renders
// each cell through `marked.parseInline` and assigns the result to `innerHTML`.
// That is the ONLY behavioral difference. Using `marked` here keeps the editor's
// rendered tables consistent with the app's other marked surfaces (ai-panel,
// file-change-proposal), which already render markdown to HTML the same way.

import { marked } from 'marked';
import { Range, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { mouseSelectingField, shouldShowSource } from 'codemirror-live-markdown';

type CellAlignment = 'left' | 'right' | 'center' | null;

interface TableData {
  headers: string[];
  alignments: CellAlignment[];
  rows: string[][];
}

function parseRow(line: string): string[] {
  const placeholder = '\0PIPE\0';
  const escaped = line.replace(/\\\|/g, placeholder);
  const cells = escaped.split('|');
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.replace(new RegExp(placeholder, 'g'), '|').trim());
}

function parseAlignment(cell: string): CellAlignment {
  const t = cell.trim();
  const left = t.startsWith(':');
  const right = t.endsWith(':');
  if (left && right) return 'center';
  if (left) return 'left';
  if (right) return 'right';
  return null;
}

function isSeparatorRow(cells: string[]): boolean {
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-+:?$/.test(c.trim()));
}

function parseMarkdownTable(source: string): TableData | null {
  const lines = source.split('\n').filter((l) => l.trim() !== '');
  if (lines.length < 2) return null;
  const headerCells = parseRow(lines[0]);
  if (headerCells.length === 0) return null;
  const separatorCells = parseRow(lines[1]);
  if (!isSeparatorRow(separatorCells)) return null;
  if (headerCells.length !== separatorCells.length) return null;
  const alignments = separatorCells.map(parseAlignment);
  const rows: string[][] = [];
  for (let i = 2; i < lines.length; i++) {
    const rowCells = parseRow(lines[i]);
    rows.push(headerCells.map((_, idx) => rowCells[idx] ?? ''));
  }
  return { headers: headerCells, alignments, rows };
}

function renderInline(text: string): string {
  // `{ async: false }` pins the synchronous overload (returns string, not
  // Promise<string>), matching ai-panel/file-change-proposal and staying
  // sync even if a global `marked.use({ async: true })` is ever added.
  return marked.parseInline(text, { async: false }) as string;
}

class RichTableWidget extends WidgetType {
  constructor(private readonly data: TableData) {
    super();
  }

  override eq(other: RichTableWidget): boolean {
    if (this.data.headers.length !== other.data.headers.length) return false;
    if (this.data.rows.length !== other.data.rows.length) return false;
    for (let i = 0; i < this.data.headers.length; i++) {
      if (this.data.headers[i] !== other.data.headers[i]) return false;
      if (this.data.alignments[i] !== other.data.alignments[i]) return false;
    }
    for (let r = 0; r < this.data.rows.length; r++) {
      const a = this.data.rows[r];
      const b = other.data.rows[r];
      if (a.length !== b.length) return false;
      for (let c = 0; c < a.length; c++) {
        if (a[c] !== b[c]) return false;
      }
    }
    return true;
  }

  override toDOM(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-table-widget';

    const table = document.createElement('table');

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    this.data.headers.forEach((header, idx) => {
      const th = document.createElement('th');
      th.innerHTML = renderInline(header);
      const align = this.data.alignments[idx];
      if (align) th.style.textAlign = align;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    this.data.rows.forEach((row) => {
      const tr = document.createElement('tr');
      row.forEach((cell, idx) => {
        const td = document.createElement('td');
        td.innerHTML = renderInline(cell);
        const align = this.data.alignments[idx];
        if (align) td.style.textAlign = align;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    container.appendChild(table);
    return container;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

function buildTableDecorations(state: EditorView['state']): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const isDrag = state.field(mouseSelectingField, false);
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === 'Table') {
        const tableSource = state.doc.sliceString(node.from, node.to);
        const tableData = parseMarkdownTable(tableSource);
        if (!tableData) return;
        const isTouched = shouldShowSource(state, node.from, node.to);
        if (!isTouched && !isDrag) {
          const widget = new RichTableWidget(tableData);
          decorations.push(
            Decoration.replace({ widget, block: true }).range(node.from, node.to),
          );
        } else {
          for (let pos = node.from; pos <= node.to; ) {
            const line = state.doc.lineAt(pos);
            decorations.push(
              Decoration.line({ class: 'cm-table-source' }).range(line.from),
            );
            pos = line.to + 1;
          }
        }
      }
    },
  });
  return Decoration.set(
    decorations.sort((a, b) => a.from - b.from),
    true,
  );
}

export const richTableField = StateField.define<DecorationSet>({
  create(state) {
    return buildTableDecorations(state);
  },
  update(deco, tr) {
    if (tr.docChanged || tr.reconfigured) return buildTableDecorations(tr.state);
    const isDragging = tr.state.field(mouseSelectingField, false);
    const wasDragging = tr.startState.field(mouseSelectingField, false);
    if (wasDragging && !isDragging) return buildTableDecorations(tr.state);
    if (isDragging) return deco;
    if (tr.selection) return buildTableDecorations(tr.state);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
