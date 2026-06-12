// Why this exists:
//
// The `codemirror-live-markdown` package renders GFM pipe tables as an HTML
// widget, but its `TableWidget.toDOM` assigns cell text via `td.textContent` /
// `th.textContent`. That means inline markdown inside a table cell (inline code
// `like this`, **bold**, [links](url)) is shown as literal source instead of
// being formatted.
//
// This field mirrors the package's own `tableField` logic (table parsing,
// decoration building, drag/selection-aware update cycle) but brings cell
// content to parity with how the same markdown renders in normal paragraphs.
// The behavioral differences vs the package are:
//
// - Inline markdown in cells is rendered through `marked.parseInline` and the
//   result is sanitized with DOMPurify before reaching `innerHTML` — the same
//   pipeline as the app's other marked surfaces (ai-panel,
//   file-change-proposal).
// - A GFM task marker at the start of a cell (`[ ]` / `[x]` / `[X]`) becomes a
//   real checkbox that toggles the underlying source text, mirroring the
//   in-repo taskListField (task-list-field.ts). Header and body cells get the
//   same treatment.
// - `[[wikilinks]]` render as the same visual-only anchors the package's
//   linkPlugin produces in paragraphs (literal inside inline code, matching
//   the plugin's skip-list; the app passes no onWikiLinkClick, so they never
//   navigate).
// - Regular links open in a new tab (`target="_blank" rel="noopener
//   noreferrer"`, like the package's LinkWidget with its default
//   openInNewTab), and `ignoreEvent` lets clicks on hyperlinks / checkboxes
//   act on the element instead of flipping the widget to source mode. Clicks
//   anywhere else — including the visual-only wikilinks — keep the
//   click-to-edit behavior.

import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { Range, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { mouseSelectingField, shouldShowSource } from 'codemirror-live-markdown';

export type CellAlignment = 'left' | 'right' | 'center' | null;

export interface TableCell {
  /** Trimmed cell text with `\|` unescaped to `|`. */
  text: string;
  /** Offset of the trimmed content's first character within its line. */
  start: number;
}

export interface TableData {
  headers: TableCell[];
  alignments: CellAlignment[];
  rows: TableCell[][];
  /** Offset of the header line's first character within the table source. */
  headerOffset: number;
  /** Offset of each body row's line within the table source. */
  rowOffsets: number[];
}

/** Exact 3-char marker in the document, re-checked before every toggle. */
const TASK_MARKER = /^\[([ xX])\]$/;
/** Marker at the start of a cell: `[ ]` / `[x]` / `[X]` + space or end. */
const CELL_TASK_MARKER = /^\[([ xX])\](?: |$)/;
const WIKILINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

export function parseRow(line: string): TableCell[] {
  // Split on un-escaped pipes by walking the line character-by-character so
  // every cell keeps its true offset within the line. (The previous
  // placeholder-replacement trick — swapping `\|` for `\0PIPE\0` — changes
  // segment lengths and would corrupt those offsets.)
  const segments: Array<{ raw: string; start: number }> = [];
  let segmentStart = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '|' && (i === 0 || line[i - 1] !== '\\')) {
      segments.push({ raw: line.slice(segmentStart, i), start: segmentStart });
      segmentStart = i + 1;
    }
  }
  segments.push({ raw: line.slice(segmentStart), start: segmentStart });
  if (segments.length > 0 && segments[0].raw.trim() === '') segments.shift();
  if (segments.length > 0 && segments[segments.length - 1].raw.trim() === '') segments.pop();
  return segments.map(({ raw, start }) => {
    const leading = raw.length - raw.trimStart().length;
    // Unescaping `\|` -> `|` shifts offsets only AFTER the first escaped pipe
    // within the cell. The task marker is always at the cell start, before
    // any escape, so the recorded cell-start offset stays valid.
    return { text: raw.trim().replace(/\\\|/g, '|'), start: start + leading };
  });
}

function parseAlignment(cell: TableCell): CellAlignment {
  const t = cell.text;
  const left = t.startsWith(':');
  const right = t.endsWith(':');
  if (left && right) return 'center';
  if (left) return 'left';
  if (right) return 'right';
  return null;
}

function isSeparatorRow(cells: TableCell[]): boolean {
  if (cells.length === 0) return false;
  return cells.every((c) => /^:?-+:?$/.test(c.text));
}

export function parseMarkdownTable(source: string): TableData | null {
  // Walk the raw lines with a running offset (instead of split + filter) so
  // each kept line's offset within `source` stays correct even when blank
  // lines appear inside the range the syntax tree handed us.
  const lines: Array<{ text: string; offset: number }> = [];
  let offset = 0;
  for (const text of source.split('\n')) {
    if (text.trim() !== '') lines.push({ text, offset });
    offset += text.length + 1;
  }
  if (lines.length < 2) return null;
  const headers = parseRow(lines[0].text);
  if (headers.length === 0) return null;
  const separatorCells = parseRow(lines[1].text);
  if (!isSeparatorRow(separatorCells)) return null;
  if (headers.length !== separatorCells.length) return null;
  const alignments = separatorCells.map(parseAlignment);
  const rows: TableCell[][] = [];
  const rowOffsets: number[] = [];
  for (let i = 2; i < lines.length; i++) {
    const rowCells = parseRow(lines[i].text);
    rows.push(headers.map((_, idx) => rowCells[idx] ?? { text: '', start: 0 }));
    rowOffsets.push(lines[i].offset);
  }
  return { headers, alignments, rows, headerOffset: lines[0].offset, rowOffsets };
}

function renderCellHtml(text: string): string {
  // `{ async: false }` pins the synchronous overload (returns string, not
  // Promise<string>), matching ai-panel/file-change-proposal and staying
  // sync even if a global `marked.use({ async: true })` is ever added.
  const html = marked.parseInline(text, { async: false }) as string;
  // Strip anything unsafe before it reaches innerHTML — same DOMPurify pass
  // as the app's other marked surfaces (ai-panel, file-change-proposal).
  return DOMPurify.sanitize(html);
}

function createCellCheckbox(checked: boolean): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'cm-task-checkbox';
  input.checked = checked;
  input.setAttribute(
    'aria-label',
    checked ? 'Mark task as not done' : 'Mark task as done',
  );
  return input;
}

function createWikilinkAnchor(display: string): HTMLAnchorElement {
  const anchor = document.createElement('a');
  // Same classes the package's linkPlugin gives wikilink widgets in
  // paragraphs (styled in styles.css). No href and no handler: the app passes
  // no onWikiLinkClick, so wikilinks are visual-only and must not navigate.
  anchor.className = 'cm-link-widget cm-wikilink-widget';
  anchor.textContent = display;
  return anchor;
}

// Replace `[[Target]]` / `[[Target|Display]]` in the cell's TEXT nodes with
// wikilink anchors. Working on the parsed DOM (not the markdown string) keeps
// wikilinks inside inline code spans literal, matching the package
// linkPlugin's skip-list behavior.
function replaceWikilinks(root: DocumentFragment): void {
  // Snapshot the text nodes first; replacing them while the TreeWalker is
  // live would skip the replacement's siblings.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    textNodes.push(node as Text);
  }
  for (const textNode of textNodes) {
    if (textNode.parentElement?.closest('code, a')) continue;
    const value = textNode.nodeValue ?? '';
    const matches = [...value.matchAll(WIKILINK_PATTERN)];
    if (matches.length === 0) continue;
    const replacement = document.createDocumentFragment();
    let consumed = 0;
    for (const match of matches) {
      const index = match.index ?? 0;
      if (index > consumed) {
        replacement.appendChild(document.createTextNode(value.slice(consumed, index)));
      }
      replacement.appendChild(createWikilinkAnchor(match[2] ?? match[1]));
      consumed = index + match[0].length;
    }
    if (consumed < value.length) {
      replacement.appendChild(document.createTextNode(value.slice(consumed)));
    }
    textNode.replaceWith(replacement);
  }
}

export interface CellContent {
  /** Detached nodes ready to append to the td/th. */
  fragment: DocumentFragment;
  /**
   * The leading task checkbox when the cell starts with `[ ]` / `[x]` /
   * `[X]`. Already part of `fragment`; exposed so the widget can wire the
   * toggle handlers (this builder stays pure / view-free for testability).
   */
  checkbox: HTMLInputElement | null;
}

export function buildCellContent(text: string): CellContent {
  const fragment = document.createDocumentFragment();
  const marker = CELL_TASK_MARKER.exec(text);
  let checkbox: HTMLInputElement | null = null;
  let inlineSource = text;
  if (marker) {
    checkbox = createCellCheckbox(marker[1] !== ' ');
    fragment.appendChild(checkbox);
    inlineSource = text.slice(marker[0].length);
    // Explicit separator: the marker's trailing space was consumed above, and
    // task lists show a space between the checkbox and the label.
    if (inlineSource !== '') fragment.appendChild(document.createTextNode(' '));
  }
  // Parse the sanitized HTML into a detached template so the anchor /
  // wikilink post-processing below operates on real nodes before anything is
  // attached to the table.
  const template = document.createElement('template');
  template.innerHTML = renderCellHtml(inlineSource);
  // Regular markdown links open externally, like the package's LinkWidget
  // (openInNewTab defaults to true). Done BEFORE wikilink replacement so the
  // visual-only wikilink anchors created below don't get a target.
  template.content.querySelectorAll('a').forEach((anchor) => {
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
  });
  replaceWikilinks(template.content);
  fragment.appendChild(template.content);
  return { fragment, checkbox };
}

// Flip the 3-char task marker at the cell's recorded offset within the table
// source. The table's document position is resolved at click time via
// `posAtDOM` (never baked into the widget) — CodeMirror reuses widget DOM
// across unrelated edits, and a baked `node.from` would go stale; this is the
// same stale-proofing task-list-field.ts uses. The marker text is re-checked
// against the live document before dispatching as a guard against any stale
// mapping.
function toggleCellTaskMarker(
  view: EditorView,
  container: HTMLElement,
  offsetInTable: number,
): void {
  const from = view.posAtDOM(container) + offsetInTable;
  const to = from + 3;
  if (to > view.state.doc.length) return;
  const match = TASK_MARKER.exec(view.state.doc.sliceString(from, to));
  if (!match) return;
  view.dispatch({
    changes: { from, to, insert: match[1] === ' ' ? '[x]' : '[ ]' },
  });
}

function wireCellCheckbox(
  view: EditorView,
  container: HTMLElement,
  checkbox: HTMLInputElement,
  offsetInTable: number,
): void {
  checkbox.addEventListener('mousedown', (event) => {
    // preventDefault: keep the input from stealing focus so the editor's
    // selection and scroll position stay exactly where they are.
    event.preventDefault();
    // stopPropagation: the editor component tracks drag-selection with a
    // contentDOM mousedown listener (setMouseSelecting). Its mouseup
    // counterpart clears the flag on a rAF, which lands AFTER our click
    // dispatch — letting it engage here would rebuild decorations in
    // "dragging" mode and flicker every task widget to source text.
    event.stopPropagation();
  });
  checkbox.addEventListener('click', (event) => {
    // preventDefault: the visual state must come from the document, not the
    // native toggle — the dispatch below rebuilds the field, and eq() sees
    // the changed table source and redraws the widget.
    event.preventDefault();
    toggleCellTaskMarker(view, container, offsetInTable);
  });
}

class RichTableWidget extends WidgetType {
  constructor(
    private readonly source: string,
    private readonly data: TableData,
  ) {
    super();
  }

  override eq(other: RichTableWidget): boolean {
    // Same source string -> same parse AND same in-source offsets. Comparing
    // parsed fields would let two tables that differ only in intra-cell
    // whitespace — and therefore in checkbox offsets — compare equal and
    // reuse stale DOM.
    return this.source === other.source;
  }

  override toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-table-widget';

    const table = document.createElement('table');

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    this.data.headers.forEach((cell, idx) => {
      const th = document.createElement('th');
      this.fillCell(view, container, th, cell, this.data.headerOffset, idx);
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    this.data.rows.forEach((row, rowIdx) => {
      const tr = document.createElement('tr');
      row.forEach((cell, idx) => {
        const td = document.createElement('td');
        this.fillCell(view, container, td, cell, this.data.rowOffsets[rowIdx], idx);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    container.appendChild(table);
    return container;
  }

  // true for clicks on interactive cell content: CodeMirror leaves the event
  // alone, so the anchor can navigate / the checkbox can toggle instead of
  // the cursor moving into the table (which would flip the widget to source
  // mode before the interaction lands). `a[href]` (not bare `a`) so the
  // visual-only wikilink anchors — no href, no handler — are NOT ignored:
  // swallowing their clicks would leave a dead pointer-cursor target, while
  // falling through matches the package's LinkWidget, whose paragraph
  // wikilinks also return false here. false everywhere else keeps the
  // click-to-edit behavior — clicking plain cell text still reveals the
  // table source.
  override ignoreEvent(event: Event): boolean {
    const target = event.target as HTMLElement | null;
    return !!target?.closest?.('a[href], input.cm-task-checkbox');
  }

  private fillCell(
    view: EditorView,
    container: HTMLElement,
    cellEl: HTMLTableCellElement,
    cell: TableCell,
    lineOffset: number,
    columnIndex: number,
  ): void {
    const align = this.data.alignments[columnIndex];
    if (align) cellEl.style.textAlign = align;
    const { fragment, checkbox } = buildCellContent(cell.text);
    if (checkbox) {
      // The marker sits at the trimmed cell start: line offset within the
      // table source + cell start within the line.
      wireCellCheckbox(view, container, checkbox, lineOffset + cell.start);
    }
    cellEl.appendChild(fragment);
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
          const widget = new RichTableWidget(tableSource, tableData);
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
