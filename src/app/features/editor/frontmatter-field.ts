// Why this exists:
//
// SpecForge documents can carry a leading YAML frontmatter block (`---` …
// `---`) holding document properties — status, owner, dates, tags. Raw YAML is
// fine to hand-edit but noisy to read at the top of every file, so this field
// brings the Obsidian "property editor" experience to the in-repo CodeMirror
// editor: an inline form of typed controls (status dropdown, date pickers,
// checkboxes, text fields) that sits where the YAML would.
//
// It mirrors the block-replace pattern of mermaid-field.ts and the interactive
// widget pattern of rich-table-field.ts:
//
// - DETECTION: @lezer/markdown has no YAML/frontmatter node, so we can't lean
//   on the syntax tree like the table/mermaid fields do. Instead we scan the
//   document's leading `---` block via the shared Wave-1 detectFrontmatter
//   helper, which is CRLF-aware and returns offsets into the live document.
//   A region only counts when it is present AND opens at offset 0.
//
// - CURSOR-AWARE SOURCE TOGGLE: cursor outside the region → the whole block is
//   replaced by the form widget. Cursor inside (or a selection touching it) →
//   the raw YAML shows as ordinary editable text, so it is always reachable by
//   clicking into the block (the mermaid/rich-table click-to-edit contract).
//
// - WRITE-BACK preserves YAML: edits route through setFrontmatterProperty,
//   which round-trips via yaml.parseDocument so comments, blank lines and key
//   order survive. Crucially the region is RE-DETECTED on the live document at
//   change time (never against a baked offset) before dispatching, the same
//   stale-proofing rich-table-field.ts uses for its checkbox offsets.
//
// - DEGRADE-TO-SOURCE, NEVER HIDE CONTENT: if the block is present but its YAML
//   is unparseable (zero parsed keys yet non-whitespace between the delimiters)
//   we render a single quiet "Invalid frontmatter — click to edit" line instead
//   of an empty form, so the raw text is always one click away — mirroring how
//   mermaid-field.ts surfaces a render error rather than swallowing the source.
//
// PRECEDENCE NOTE: the live-markdown package decorates `---` lines as thematic
// breaks (HR). editor.component.ts wires this field as Prec.high(frontmatterField)
// ahead of those decorations so the form's block replace, sitting at the very
// top of the document, out-prioritizes any competing HR line treatment on the
// delimiter lines.

import { Facet, Range, StateEffect, StateField, type EditorState } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { mouseSelectingField, shouldShowSource } from 'codemirror-live-markdown';
import {
  addFrontmatterListItem,
  detectFrontmatter,
  parseFrontmatter,
  removeFrontmatterProperty,
  removeFrontmatterPropertyIn,
  renameFrontmatterProperty,
  renameFrontmatterPropertyIn,
  setFrontmatterProperty,
  setFrontmatterPropertyIn,
} from '../../../../electron/frontmatter/frontmatter';

/**
 * A frontmatter PATH: `(string | number)[]`. String segments index map keys,
 * number segments index list items, mirroring the path contract of the module's
 * `*In` helpers. `[]` is the ROOT mapping; `['author', 'name']` a nested key;
 * `['tags', 1]` the second list item. Rendering and write-back are both
 * path-aware so nested maps and individual list entries are reachable.
 */
type FrontmatterPath = (string | number)[];

/**
 * Resolves the DISTINCT values already used for a property across the active
 * vault, given a per-property SUGGESTION KEY (see suggestionKeyForPath). This
 * decouples the CM widget from Angular: the editor injects a vault-scoped
 * provider via {@link frontmatterValueSource}, and the widget reads it from
 * editor state without importing any renderer service. Implementations resolve
 * to `[]` on any failure and never throw.
 */
export type FrontmatterValueSource = (suggestionKey: string) => Promise<string[]>;

/**
 * The injection point for the per-property value provider. The editor provides
 * one entry (backed by the doc-properties index); the widget reads the combined
 * value via `view.state.facet(frontmatterValueSource)`, which is `null` when no
 * provider is configured (e.g. tests, or the renderer running without IPC).
 */
export const frontmatterValueSource = Facet.define<FrontmatterValueSource, FrontmatterValueSource | null>({
  combine: (values) => (values.length ? values[0] : null),
});

/**
 * Maps a frontmatter PATH to the index SUGGESTION KEY for value autocomplete:
 * numeric list indices are dropped and the remaining string segments are
 * dot-joined, matching how the doc-properties index keys property values
 * (top-level scalar → `key`; nested map leaf → `author.name`; list items →
 * the list's key per item). So `['tags', 2]` → `'tags'`, `['tags']` (the
 * add-item input) → `'tags'`, `['author', 'name']` → `'author.name'`, and
 * `['status']` → `'status'`. A path with no string segments (shouldn't occur
 * here) yields `''`, which callers treat as "no suggestion key".
 */
function suggestionKeyForPath(path: FrontmatterPath): string {
  return path.filter((seg) => typeof seg === 'string').join('.');
}

// Monotonic counter for unique <datalist> ids so multiple inputs in one widget
// (and across re-renders) never share a list. Module-level: ids only need to be
// unique within the document, and a fresh id per attach is cheap.
let datalistSeq = 0;

/**
 * Wires native value autocomplete onto a FREE-TEXT input by attaching a
 * `<datalist>` populated, lazily, with the DISTINCT values already used for the
 * SAME property elsewhere in the vault. Native datalist is deliberate: it is
 * accessible, keyboard-friendly and the browser filters it by what's typed, so
 * we add every distinct value with no client-side query filtering. The dropdown
 * is Chromium-native (not fully theme-able) — an accepted trade-off.
 *
 * - No provider configured (facet `null`) → no-op, so the input behaves exactly
 *   as before.
 * - The datalist is appended to `container` (the cell/chip element being built),
 *   NOT `input.parentElement`: the input is not yet attached to the DOM during
 *   toDOM, so it has no parent to read.
 * - The fetch is LAZY and ONE-SHOT, fired on the input's FIRST focus (guarded by
 *   a flag), so rendering the form never fires a query per input and repeated
 *   focus never refetches.
 * - `exclude` (optional) filters out values already present (used by the
 *   add-item input so existing list items aren't re-suggested). It is read at
 *   fetch time, reflecting the items as they were when focus first landed.
 * - The provider's promise rejection is swallowed — autocomplete is purely
 *   additive and must never break editing.
 */
function attachValueAutocomplete(
  view: EditorView,
  input: HTMLInputElement,
  container: HTMLElement,
  path: FrontmatterPath,
  exclude?: () => Set<string>,
): void {
  const source = view.state.facet(frontmatterValueSource);
  if (!source) return;

  const datalist = document.createElement('datalist');
  const id = `cm-fm-dl-${datalistSeq++}`;
  datalist.id = id;
  input.setAttribute('list', id);
  container.appendChild(datalist);

  let fetched = false;
  input.addEventListener('focus', () => {
    if (fetched) return;
    fetched = true;
    const key = suggestionKeyForPath(path);
    if (!key) return;
    const excluded = exclude ? exclude() : null;
    source(key)
      .then((values) => {
        datalist.replaceChildren();
        const seen = new Set<string>();
        for (const value of values) {
          if (seen.has(value)) continue;
          seen.add(value);
          if (excluded?.has(value)) continue;
          const option = document.createElement('option');
          option.value = value;
          datalist.appendChild(option);
        }
      })
      .catch(() => {
        /* autocomplete is additive — a failed lookup must never break editing */
      });
  });
}

/** Element-wise path equality used to match the pending focus hint against a row. */
function pathsEqual(a: FrontmatterPath | null, b: FrontmatterPath | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** A plain object record (a YAML map) — NOT an array, NOT null, NOT a scalar. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the nested object at `path` out of already-parsed frontmatter `data`,
 * walking string (map) and number (list) segments. Returns `{}` when the path
 * does not resolve to a plain record (used only for the add-row collision check,
 * which needs the set of sibling keys at `parentPath`).
 */
function recordAtPath(data: Record<string, unknown>, path: FrontmatterPath): Record<string, unknown> {
  let cursor: unknown = data;
  for (const segment of path) {
    if (Array.isArray(cursor) && typeof segment === 'number') {
      cursor = cursor[segment];
    } else if (isPlainRecord(cursor) && typeof segment === 'string') {
      cursor = cursor[segment];
    } else {
      return {};
    }
  }
  return isPlainRecord(cursor) ? cursor : {};
}

/**
 * Cheap recursive row estimate for {@link FrontmatterWidget.estimatedHeight}:
 * a scalar (or list) counts as 1, a nested map counts as the sum of its child
 * rows plus 1 (its own add-row). Mirrors how buildValueCell renders so scroll
 * geometry tracks nesting without measuring the DOM.
 */
function countRenderedRows(data: Record<string, unknown>): number {
  let rows = 0;
  for (const value of Object.values(data)) {
    if (isPlainRecord(value)) {
      rows += countRenderedRows(value) + 1;
    } else {
      // Scalar or list: a single row (a list renders as one wrapping chip line).
      rows += 1;
    }
  }
  return rows;
}

// Status keys offer a fixed lifecycle vocabulary; a value outside this set is
// preserved as an extra option so custom statuses aren't silently dropped.
const STATUS_OPTIONS = ['draft', 'review', 'approved', 'published'];
// Keys whose values are conventionally calendar dates, so they get a date
// picker even when the current value is empty (a bare ISO date string also
// triggers the picker regardless of key, see isDateLikeValue).
const DATE_KEY = /^(created|updated|modified|date|due)$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// COLLAPSE STATE: the form defaults to a compact single-line summary bar so the
// top of every document reads as content, not metadata. Collapse lives in editor
// state (mirroring mermaid-field.ts's StateField idiom) rather than widget DOM,
// so it survives decoration rebuilds and the editor can reset it on file switch
// (editor.component.ts dispatches setFrontmatterCollapsed.of(true) when the
// active file changes — the view is reused across files, so a per-widget flag
// would leak the previous file's expanded/collapsed state). Default true: every
// file opens collapsed.
export const setFrontmatterCollapsed = StateEffect.define<boolean>();
export const frontmatterCollapsedField = StateField.define<boolean>({
  create: () => true /* default collapsed */,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setFrontmatterCollapsed)) value = e.value;
    }
    return value;
  },
});

// ADD-PROPERTY FOCUS HANDOFF: committing a new key dispatches a doc change that
// rebuilds the widget from scratch, so the just-created value control is a brand
// new DOM node — the focus we had on the add-row input is gone by the time it
// exists. This module-level hint carries the PATH of the new property from the
// commit site to the next toDOM/buildValueCell, which focuses (and selects) that
// control once it builds. A path (not just a top-level key) lets the handoff land
// focus at any depth, so adding a child key inside a nested map works too. A
// single hint (not a stack) is enough: only one add can be in flight, and it is
// cleared the moment a rebuild consumes it, so it can never steal focus on an
// unrelated later rebuild. See commitNewProperty and buildValueCell.
let pendingValueFocusPath: FrontmatterPath | null = null;

/**
 * Strips the one trailing line break that `regionEnd` consumed so the block
 * replace ends at the closing `---` line's TEXT, leaving the body's leading
 * newline intact. Mirrors mermaid-field.ts relying on `node.to` excluding the
 * trailing newline. When `regionEnd` consumed no newline (EOF, no body) it is
 * already at the text end and is returned unchanged.
 */
function replaceEndFor(text: string, regionEnd: number): number {
  let end = regionEnd;
  if (end > 0 && text.charCodeAt(end - 1) === 10 /* \n */) {
    end -= 1;
    if (end > 0 && text.charCodeAt(end - 1) === 13 /* \r */) {
      end -= 1;
    }
  }
  return end;
}

/** A status select; preserves an out-of-vocabulary current value as a leading option. */
function createStatusSelect(value: string): HTMLSelectElement {
  const select = document.createElement('select');
  select.className = 'cm-frontmatter-control';
  const options = STATUS_OPTIONS.includes(value)
    ? STATUS_OPTIONS
    : [value, ...STATUS_OPTIONS];
  for (const option of options) {
    const el = document.createElement('option');
    el.value = option;
    el.textContent = option;
    if (option === value) el.selected = true;
    select.appendChild(el);
  }
  return select;
}

/**
 * Builds the typed control for a SCALAR key/value pair (excluding the status
 * special-case). Arrays and nested maps no longer reach here — buildValueCell
 * routes them to the chips / nested-group renderers — so this handles only
 * boolean / number / date / text leaves.
 */
function createValueControl(key: string, value: unknown): HTMLInputElement {
  const input = document.createElement('input');
  input.className = 'cm-frontmatter-control';

  if (typeof value === 'boolean') {
    input.type = 'checkbox';
    input.checked = value;
    return input;
  }
  if (typeof value === 'number') {
    input.type = 'number';
    input.value = String(value);
    return input;
  }
  const text = value == null ? '' : String(value);
  // A date picker is only safe when it can faithfully hold the current value:
  // an ISO `YYYY-MM-DD` string, or an empty date-like key (where the picker lets
  // the user choose one). A date-like key holding a non-empty, non-ISO string
  // (e.g. `created: last Tuesday`) would render as a blank picker and silently
  // drop that free text on the next edit, so it falls through to a text input
  // that shows and preserves the value.
  const isEmptyDateKey = text === '' && DATE_KEY.test(key);
  if (ISO_DATE.test(text) || isEmptyDateKey) {
    input.type = 'date';
    input.value = ISO_DATE.test(text) ? text : '';
    return input;
  }
  input.type = 'text';
  input.value = text;
  return input;
}

/**
 * Reads the typed value out of a SCALAR control for write-back: checkbox →
 * boolean, number input → number (NaN guarded to 0), everything else → the raw
 * string value. Arrays/maps never reach a single control (they render as chips /
 * nested groups), so the legacy comma-split array branch is gone; the `isArray`
 * parameter is retained for call-site compatibility but is now always `false`.
 */
function readControlValue(control: HTMLInputElement | HTMLSelectElement, _isArray: boolean): unknown {
  if (control instanceof HTMLInputElement) {
    if (control.type === 'checkbox') return control.checked;
    if (control.type === 'number') {
      const num = control.valueAsNumber;
      return Number.isNaN(num) ? 0 : num;
    }
  }
  return control.value;
}

/**
 * The shared live-offset splice for a frontmatter rewrite that KEEPS the block.
 * Re-detects the region against the live `text` and the rewritten `newFull`,
 * then dispatches a replace of the block region only — offsets are recomputed
 * against the LIVE document (never baked into the widget), the same stale-
 * proofing rich-table-field.ts uses: CodeMirror reuses widget DOM across edits,
 * so a baked `region.from` would go stale. A no-op (`newFull === text`) or a
 * rewrite that somehow dropped the block (`!newRegion.present`) is left to the
 * caller — this helper only handles the block-preserving splice.
 */
function spliceBlock(view: EditorView, text: string, newFull: string, replaceTo: number): void {
  const newRegion = detectFrontmatter(newFull);
  if (!newRegion.present) return;
  const newReplaceTo = replaceEndFor(newFull, newRegion.regionEnd);
  view.dispatch({ changes: { from: 0, to: replaceTo, insert: newFull.slice(0, newReplaceTo) } });
}

/**
 * Re-detects the live region and dispatches a write of `value` at `path` through
 * the module's round-trip helpers. A length-1 path routes to the verified
 * top-level setFrontmatterProperty (so the existing top-level behavior is byte-
 * for-byte unchanged); a deeper path routes to setFrontmatterPropertyIn. Offsets
 * are recomputed against the LIVE document (never baked); the widget only shows
 * when the cursor is OUTSIDE the region, so this replace maps the cursor
 * correctly and the form stays rendered.
 */
function writeValueAt(view: EditorView, path: FrontmatterPath, value: unknown): void {
  const text = view.state.doc.toString();
  const region = detectFrontmatter(text);
  if (!region.present) return;
  const replaceTo = replaceEndFor(text, region.regionEnd);

  const newFull =
    path.length === 1
      ? setFrontmatterProperty(text, String(path[0]), value)
      : setFrontmatterPropertyIn(text, path, value);
  spliceBlock(view, text, newFull, replaceTo);
}

/**
 * Re-detects the live region and dispatches a removal of the node at `path`,
 * with the same live-offset discipline as writeValueAt. A length-1 path routes
 * to top-level removeFrontmatterProperty, a deeper one to
 * removeFrontmatterPropertyIn. The whole block is dropped only when the ROOT
 * empties — possible only for a length-1 last-key removal — in which case we
 * replace up to `region.regionEnd` (including the closing delimiter's trailing
 * newline) so exactly the body remains. Otherwise the block survives and is
 * spliced the same way a write is.
 */
function removeValueAt(view: EditorView, path: FrontmatterPath): void {
  const text = view.state.doc.toString();
  const region = detectFrontmatter(text);
  if (!region.present) return;

  const newFull =
    path.length === 1
      ? removeFrontmatterProperty(text, String(path[0]))
      : removeFrontmatterPropertyIn(text, path);
  const newRegion = detectFrontmatter(newFull);
  if (!newRegion.present) {
    // ROOT emptied → the whole block is dropped (only reachable when a length-1
    // last-key removal clears the mapping). Remove it including its trailing
    // newline so exactly the body remains.
    view.dispatch({ changes: { from: 0, to: region.regionEnd, insert: '' } });
    return;
  }

  const replaceTo = replaceEndFor(text, region.regionEnd);
  spliceBlock(view, text, newFull, replaceTo);
}

/**
 * Re-detects the live region and dispatches a rename of `oldKey` (within the map
 * at `parentPath`) to the key input's trimmed value, with the same live-offset
 * discipline as writeValueAt. `parentPath === []` targets the ROOT and routes to
 * top-level renameFrontmatterProperty (verified behavior unchanged); a deeper
 * parent routes to renameFrontmatterPropertyIn. A rename the helper rejects —
 * empty, unchanged or a collision — returns the text unchanged; we detect that
 * and revert the input's visible value to `oldKey` rather than dispatching a
 * no-op edit. A rename never drops the block, so there is no last-key branch.
 */
function renameKeyAt(
  view: EditorView,
  parentPath: FrontmatterPath,
  oldKey: string,
  inputEl: HTMLInputElement,
): void {
  const newKey = inputEl.value.trim();
  const text = view.state.doc.toString();
  const region = detectFrontmatter(text);
  if (!region.present) return;

  const newFull =
    parentPath.length === 0
      ? renameFrontmatterProperty(text, oldKey, newKey)
      : renameFrontmatterPropertyIn(text, parentPath, oldKey, newKey);
  if (newFull === text) {
    // Rejected (empty / unchanged / collision): restore the visible key.
    inputEl.value = oldKey;
    return;
  }
  const replaceTo = replaceEndFor(text, region.regionEnd);
  spliceBlock(view, text, newFull, replaceTo);
}

/**
 * Re-detects the live region and dispatches an append of `value` to the list at
 * `listPath` through addFrontmatterListItem (which creates the list if absent
 * and refuses to coerce a non-list node), with the same live-offset discipline
 * as writeValueAt. Appending to a list never drops the block, so this always
 * uses the block-preserving splice.
 */
function addListItemAt(view: EditorView, listPath: FrontmatterPath, value: unknown): void {
  const text = view.state.doc.toString();
  const region = detectFrontmatter(text);
  if (!region.present) return;
  const replaceTo = replaceEndFor(text, region.regionEnd);

  const newFull = addFrontmatterListItem(text, listPath, value);
  spliceBlock(view, text, newFull, replaceTo);
}

/**
 * Suppresses drag-selection churn for an interactive control: stopPropagation
 * keeps the editor's contentDOM drag tracker (setMouseSelecting) from engaging
 * and flickering the widget to source. Unlike wireCellCheckbox in
 * rich-table-field.ts we deliberately do NOT preventDefault — these are
 * FOCUSABLE controls (the editable key input, value inputs, the select),
 * and swallowing the default mousedown would block click-to-focus, making the
 * inputs unreachable by mouse and breaking Tab-from-clicked-position.
 */
function guardControlMousedown(control: HTMLElement): void {
  control.addEventListener('mousedown', (event) => {
    event.stopPropagation();
  });
}

/** The DOM id buildValueCell assigns a scalar control, derived from its path. */
function controlIdForPath(path: FrontmatterPath): string {
  return `cm-fm-${path.map((p) => String(p)).join('-').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

/**
 * Commits the add-row key input into a new property at `parentPath`, returning
 * whether anything was committed (so the caller can keep the add input open on a
 * no-op). Shared by the add-row's Enter and Tab paths so both behave identically.
 *
 * - Empty key → false: leave the add input as-is (the keydown handler decides
 *   whether to hide it; an empty Enter/Tab just does nothing).
 * - Collision (key already exists in the live frontmatter AT `parentPath`): never
 *   write a duplicate. Re-detection is against the LIVE document (the same
 *   discipline as writeValueAt), so the check sees pending edits. We focus the
 *   EXISTING row's value control directly — no doc change, so no rebuild runs and
 *   the pendingValueFocusPath path would never fire — and reset the add input.
 * - New key → set pendingValueFocusPath so the rebuild lands focus in the new
 *   value control (at any depth), then writeValueAt with an empty value
 *   (dispatching the doc change → rebuild), and reset the add input.
 */
function commitNewProperty(
  view: EditorView,
  parentPath: FrontmatterPath,
  keyInputEl: HTMLInputElement,
): boolean {
  const key = keyInputEl.value.trim();
  if (key === '') return false;

  // Collision check against the LIVE document AT `parentPath`, matching
  // writeValueAt's offset discipline. parseFrontmatter never throws (returns
  // `{ data: {} }` on malformed YAML), so a malformed block reads as no keys and
  // falls through to a normal write rather than a spurious collision. recordAtPath
  // walks into the parsed data to the map that will hold the new key.
  const { data } = parseFrontmatter(view.state.doc.toString());
  const siblings = recordAtPath(data, parentPath);
  if (Object.prototype.hasOwnProperty.call(siblings, key)) {
    // Duplicate: focus the existing row's value control instead of creating a
    // second key. The widget DOM is live and attached here, so locate the
    // control by the id buildValueCell assigns and focus it directly — no rebuild
    // is involved, so we do NOT route through pendingValueFocusPath.
    const widget = keyInputEl.closest('.cm-frontmatter-widget');
    const id = controlIdForPath([...parentPath, key]);
    const existingControl = widget?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (existingControl) {
      existingControl.focus();
      if (
        existingControl instanceof HTMLInputElement &&
        (existingControl.type === 'text' || existingControl.type === 'number')
      ) {
        existingControl.select();
      }
    }
    keyInputEl.value = '';
    return true;
  }

  // New key: arm the focus handoff, then write an empty value. The rebuild
  // renders a text control the user can fill in, and buildValueCell consumes the
  // hint to land focus there. setFrontmatterProperty(In) round-trips the key.
  pendingValueFocusPath = [...parentPath, key];
  keyInputEl.value = '';
  writeValueAt(view, [...parentPath, key], '');
  return true;
}

export class FrontmatterWidget extends WidgetType {
  constructor(
    private readonly raw: string,
    private readonly data: Record<string, unknown>,
    private readonly collapsed: boolean,
  ) {
    super();
  }

  override eq(other: FrontmatterWidget): boolean {
    // Same raw region text → identical parse and identical write-back behavior;
    // CodeMirror reuses the existing DOM (no flicker, controls keep focus).
    // collapsed is part of identity so toggling the summary/form re-renders.
    return this.raw === other.raw && this.collapsed === other.collapsed;
  }

  // Approximate the rendered height from a RECURSIVE row count so scroll geometry
  // doesn't jump badly for nested data: a scalar ≈ 1 row, a list ≈ 1 row (the
  // chips wrap on a single line in the common case), and a nested map ≈ the sum
  // of its children plus 1 for its add-row. Plus the header and add-property rows
  // and padding. Collapsed is a single ~30px summary bar. A cheap estimate, not a
  // measurement — the widget measures itself once attached.
  override get estimatedHeight(): number {
    if (this.collapsed) return 30;
    const rows = countRenderedRows(this.data) + 2;
    return rows * 30 + 24;
  }

  // true for interactive controls so CodeMirror leaves their events alone and
  // the select/input/button acts instead of the cursor moving into the region
  // (which would flip the widget to source before the interaction lands).
  // false everywhere else keeps the click-to-edit contract — clicking the form
  // background falls through, places the cursor in the region and reveals the
  // raw YAML. NOTE: WidgetType's default ignoreEvent returns true, which would
  // make every control a dead click target; we MUST override.
  override ignoreEvent(event: Event): boolean {
    const target = event.target as HTMLElement | null;
    if (!target) return false;
    if (target.closest('[data-fm-interactive]')) return true;
    return !!target.closest('select, input, button');
  }

  override toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-frontmatter-widget';

    const keys = Object.keys(this.data);

    // DEGRADE-TO-SOURCE SAFETY: present block but the parser read zero keys.
    // If there is non-whitespace YAML between the delimiters the block is
    // malformed — render a quiet line instead of an empty form so the source
    // is never hidden; clicking it (non-interactive) reveals the raw YAML.
    // This precedes the collapse branch on purpose: a malformed block must
    // never hide behind a tidy summary bar.
    if (keys.length === 0) {
      const inner = this.raw.replace(/^---\r?\n/, '').replace(/---\r?\n?$/, '');
      if (inner.trim() !== '') {
        const invalid = document.createElement('div');
        invalid.className = 'cm-frontmatter-invalid';
        invalid.textContent = 'Invalid frontmatter — click to edit';
        container.appendChild(invalid);
        return container;
      }
    }

    if (this.collapsed) {
      container.appendChild(this.buildCollapsedBar(view, keys));
    } else {
      container.appendChild(this.buildHeader(view, keys.length));
      for (const key of keys) {
        // Top-level rows live under the ROOT path (`[]`); buildPropertyRow
        // recurses into nested maps and lists from there.
        container.appendChild(this.buildPropertyRow(view, [], key, this.data[key]));
      }
      container.appendChild(this.buildAddRow(view));
      // CONSUME THE FOCUS HINT EXACTLY ONCE: buildValueCell schedules focus when a
      // path matches pendingValueFocusPath. Clear it now that the whole form has
      // been built — whether or not a match was found — so a path the YAML
      // normalized differently (no matching row) can never linger and steal focus
      // on an unrelated later rebuild. Collapsed rebuilds skip this on purpose:
      // the controls aren't rendered, so the hint waits for the next expanded
      // build.
      pendingValueFocusPath = null;
    }

    // Intra-widget Tab navigation: the controls live inside CodeMirror's
    // contenteditable, so a bare Tab would surrender focus to the browser's
    // document focus order (a random pane), not the next control. We move focus
    // between the widget's own controls in DOM order; at either boundary we hand
    // focus back to the editor via view.focus() so Tab exits cleanly into the
    // text instead of trapping. Wrapping is deliberately avoided.
    container.addEventListener('keydown', (event) => this.handleTab(view, event));

    return container;
  }

  /**
   * Focusable controls in DOM order; all interactive controls carry the marker.
   * Hidden controls are excluded — the add-property row keeps a hidden key input
   * alongside its button, and Tab landing on an unfocusable element would lose
   * focus. `hidden`/`display:none` elements have no offsetParent.
   */
  private interactiveControls(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>('[data-fm-interactive]')).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
  }

  /**
   * Tab / Shift+Tab moves focus between the widget's controls in DOM order.
   * preventDefault + stopPropagation keep both CodeMirror and the browser's
   * default focus order from also acting. At the forward boundary (Tab on the
   * last control) and backward boundary (Shift+Tab on the first) focus returns
   * to the editor via view.focus(), so Tab exits the widget into the document
   * rather than wrap-trapping or jumping to an unrelated pane. A foreign
   * activeElement (shouldn't happen) is left to the default handler.
   */
  private handleTab(view: EditorView, event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const container = event.currentTarget as HTMLElement;
    const controls = this.interactiveControls(container);
    if (controls.length === 0) return;
    const index = controls.indexOf(document.activeElement as HTMLElement);
    if (index === -1) return;

    const atForwardBoundary = !event.shiftKey && index === controls.length - 1;
    const atBackwardBoundary = event.shiftKey && index === 0;
    if (atForwardBoundary || atBackwardBoundary) {
      event.preventDefault();
      event.stopPropagation();
      view.focus();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const next = controls[index + (event.shiftKey ? -1 : 1)];
    next.focus();
  }

  /**
   * Collapsed view: a dense single-line summary bar acting as the expand
   * control. A chevron + the "Properties" label + a quiet key count, plus the
   * status value as a small pill when a `status` key exists. The whole bar is
   * the interactive button; clicking or pressing Enter/Space expands the form.
   */
  private buildCollapsedBar(view: EditorView, keys: string[]): HTMLElement {
    const bar = document.createElement('button');
    bar.type = 'button';
    bar.className = 'cm-frontmatter-collapsed';
    bar.setAttribute('data-fm-interactive', '');
    bar.setAttribute('aria-label', 'Expand properties');
    bar.title = 'Expand properties';
    guardControlMousedown(bar);

    const chevron = document.createElement('span');
    chevron.className = 'cm-frontmatter-chevron';
    chevron.textContent = '▸';
    chevron.setAttribute('aria-hidden', 'true');
    bar.appendChild(chevron);

    const label = document.createElement('span');
    label.className = 'cm-frontmatter-summary-label';
    label.textContent = 'Properties';
    bar.appendChild(label);

    const count = document.createElement('span');
    count.className = 'cm-frontmatter-summary-count';
    count.textContent = String(keys.length);
    bar.appendChild(count);

    // Surface the status value inline so the most-scanned property is legible
    // without expanding. Case-insensitive key match, mirroring buildPropertyRow.
    const statusKey = keys.find((key) => key.toLowerCase() === 'status');
    if (statusKey !== undefined) {
      const value = this.data[statusKey];
      const pill = document.createElement('span');
      pill.className = 'cm-frontmatter-status-pill';
      pill.textContent = value == null ? '' : String(value);
      bar.appendChild(pill);
    }

    // Bubble up `tags` like the status pill: a few read-only chips plus a `+N`
    // overflow indicator so the most-scanned list is legible without expanding.
    // Restrained to at most 3 chips to stay compact and quiet. Case-insensitive
    // key match; only an actual array qualifies.
    const tagsKey = keys.find((key) => key.toLowerCase() === 'tags');
    const tags = tagsKey !== undefined ? this.data[tagsKey] : undefined;
    if (Array.isArray(tags) && tags.length > 0) {
      const MAX_TAGS = 3;
      const shown = tags.slice(0, MAX_TAGS);
      for (const tag of shown) {
        const chip = document.createElement('span');
        chip.className = 'cm-frontmatter-tag';
        chip.textContent = String(tag);
        bar.appendChild(chip);
      }
      if (tags.length > MAX_TAGS) {
        const overflow = document.createElement('span');
        overflow.className = 'cm-frontmatter-tag-overflow';
        overflow.textContent = `+${tags.length - MAX_TAGS}`;
        bar.appendChild(overflow);
      }
    }

    bar.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ effects: setFrontmatterCollapsed.of(false) });
    });
    return bar;
  }

  /**
   * Expanded header row: the "Properties" label and a collapse chevron button
   * that returns the form to the summary bar. Marked data-fm-interactive so
   * Tab navigation reaches it and the click acts on the button rather than
   * dropping the cursor into the region.
   */
  private buildHeader(view: EditorView, count: number): HTMLElement {
    const header = document.createElement('div');
    header.className = 'cm-frontmatter-header';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'cm-frontmatter-chevron-button';
    toggle.setAttribute('data-fm-interactive', '');
    toggle.setAttribute('aria-label', 'Collapse properties');
    toggle.title = 'Collapse properties';
    guardControlMousedown(toggle);

    const chevron = document.createElement('span');
    chevron.className = 'cm-frontmatter-chevron cm-frontmatter-chevron-open';
    chevron.textContent = '▾';
    chevron.setAttribute('aria-hidden', 'true');
    toggle.appendChild(chevron);

    toggle.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ effects: setFrontmatterCollapsed.of(true) });
    });
    header.appendChild(toggle);

    const label = document.createElement('span');
    label.className = 'cm-frontmatter-header-label';
    label.textContent = 'Properties';
    header.appendChild(label);

    const countEl = document.createElement('span');
    countEl.className = 'cm-frontmatter-summary-count';
    countEl.textContent = String(count);
    header.appendChild(countEl);

    return header;
  }

  /**
   * One key-input + value-cell row for a single frontmatter property at
   * `[...parentPath, key]`. The value cell dispatches on the value's kind
   * (scalar control, list chips, or nested map group) via buildValueCell, so
   * this row builder is the recursion's spine: top-level rows pass `[]` for
   * `parentPath`; a nested map's children pass that map's path.
   */
  private buildPropertyRow(
    view: EditorView,
    parentPath: FrontmatterPath,
    key: string,
    value: unknown,
  ): HTMLElement {
    const path = [...parentPath, key];
    const row = document.createElement('div');
    row.className = 'cm-frontmatter-row';

    // The key (property NAME) is itself editable: a mono text input seeded with
    // the current key. It is the FIRST data-fm-interactive control in the row,
    // so Tab reaches it before the value control and ignoreEvent already lets
    // its events through. Renames commit on `change` (blur/Enter) via
    // renameKeyAt(parentPath, key), which re-detects the live region and rejects
    // empty, unchanged or colliding names — reverting the visible value in that
    // case. The parentPath routing keeps a nested rename in its own map.
    const keyInput = document.createElement('input');
    keyInput.type = 'text';
    keyInput.className = 'cm-frontmatter-key';
    keyInput.value = key;
    keyInput.setAttribute('data-fm-interactive', '');
    keyInput.setAttribute('aria-label', `Rename ${key}`);
    keyInput.title = 'Rename property';
    guardControlMousedown(keyInput);
    keyInput.addEventListener('change', () => {
      renameKeyAt(view, parentPath, key, keyInput);
    });
    row.appendChild(keyInput);

    const cell = document.createElement('div');
    cell.className = 'cm-frontmatter-value';
    const valueEl = this.buildValueCell(view, path, value);
    cell.appendChild(valueEl);
    // VALUE AUTOCOMPLETE (free-text scalars only): a scalar leaf renders its
    // control directly into the cell, so when that control is a plain text input
    // (not the status <select>, date, number or checkbox) wire a vault-scoped
    // <datalist> of values already used for THIS property elsewhere. List chips
    // and the add-item input are wired inside buildListCell instead; nested maps
    // recurse into their own scalar rows. The datalist hangs off the cell (the
    // input isn't attached yet during toDOM, so it has no parent of its own).
    if (valueEl instanceof HTMLInputElement && valueEl.type === 'text') {
      attachValueAutocomplete(view, valueEl, cell, path);
    }
    row.appendChild(cell);

    // Per-row remove control, the symmetric counterpart to "+ add property". A
    // quiet `×` glyph button that drops this key (at its full path) via
    // removeValueAt. Marked data-fm-interactive and mousedown-guarded like the
    // other controls so the click acts on the button instead of dropping the
    // cursor into the region (which would flip the widget to source mid-
    // interaction).
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'cm-frontmatter-remove';
    remove.textContent = '×';
    remove.setAttribute('data-fm-interactive', '');
    remove.setAttribute('aria-label', `Remove ${key}`);
    remove.title = 'Remove property';
    guardControlMousedown(remove);
    remove.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      removeValueAt(view, path);
    });
    row.appendChild(remove);

    return row;
  }

  /**
   * Builds the VALUE half of a property at `path`, dispatching on the value's
   * kind. This is the recursive heart of the widget:
   *
   *  - SCALAR (string / number / boolean / null) → the existing typed control
   *    (status select when the LEAF key is `status`, else a checkbox / number /
   *    date / text input). Writes route through writeValueAt(path, …); the
   *    add-property focus handoff lands here when `path === pendingValueFocusPath`.
   *  - ARRAY (list) → a chips container: one editable chip per scalar item
   *    (commit on change → writeValueAt([...path, i]); remove × → removeValueAt),
   *    a non-scalar item recurses, and a trailing "add item" input appends via
   *    addListItemAt(path).
   *  - NESTED MAP (plain object) → an indented group of child rows
   *    (buildPropertyRow recursion) plus a nested add-row so keys can be added
   *    inside the map.
   */
  private buildValueCell(view: EditorView, path: FrontmatterPath, value: unknown): HTMLElement {
    if (Array.isArray(value)) {
      return this.buildListCell(view, path, value);
    }
    if (isPlainRecord(value)) {
      return this.buildNestedCell(view, path, value);
    }
    return this.buildScalarCell(view, path, value);
  }

  /**
   * A scalar value control: the EXISTING typed control, generalized to a path.
   * The status special-case applies when the LEAF key (`path.at(-1)`) is
   * `status` (case-insensitive). Writes route through writeValueAt(path, …) on
   * `change`, and the add-property focus handoff fires when `path` matches
   * pendingValueFocusPath — scheduled in a rAF because the widget DOM is not yet
   * attached during toDOM (`control.focus()` is a no-op until connected).
   */
  private buildScalarCell(view: EditorView, path: FrontmatterPath, value: unknown): HTMLElement {
    const leafKey = String(path[path.length - 1] ?? '');
    const isStatus = leafKey.toLowerCase() === 'status';
    const control: HTMLInputElement | HTMLSelectElement = isStatus
      ? createStatusSelect(value == null ? '' : String(value))
      : createValueControl(leafKey, value);

    control.setAttribute('data-fm-interactive', '');
    control.id = controlIdForPath(path);
    // The key is an editable input (not a `<label for>`), so the value control
    // needs its own accessible name — derive it from the leaf key.
    control.setAttribute('aria-label', leafKey);

    guardControlMousedown(control);
    control.addEventListener('change', () => {
      writeValueAt(view, path, readControlValue(control, false));
    });

    // ADD-PROPERTY FOCUS HANDOFF: if this control is the one just created from an
    // add commit (at any depth), land focus in it so the user can type the value
    // immediately (the add-row input that had focus no longer exists after the
    // rebuild). rAF is required because the widget DOM is not attached during
    // toDOM. Selecting the text (text/number inputs) lets the user overwrite the
    // empty seed; a `<select>` (status) or date input is just focused. The hint
    // is cleared by toDOM after the whole form is built, so it fires once.
    if (pathsEqual(path, pendingValueFocusPath)) {
      requestAnimationFrame(() => {
        if (!control.isConnected) return;
        control.focus();
        if (
          control instanceof HTMLInputElement &&
          (control.type === 'text' || control.type === 'number')
        ) {
          control.select();
        }
      });
    }

    return control;
  }

  /**
   * A YAML list rendered as editable chips. Each scalar item is a chip holding a
   * text input (commit on change → writeValueAt([...path, i])) and a remove ×
   * (→ removeValueAt([...path, i])); a non-scalar item recurses via
   * buildValueCell so nested lists/maps stay editable. A trailing "add item"
   * input appends via addListItemAt(path). Items are edited as text, so numbers
   * in a list become strings on edit — acceptable for the common case (tags).
   */
  private buildListCell(view: EditorView, path: FrontmatterPath, items: unknown[]): HTMLElement {
    const chips = document.createElement('div');
    chips.className = 'cm-frontmatter-chips';

    items.forEach((item, i) => {
      const itemPath = [...path, i];
      if (Array.isArray(item) || isPlainRecord(item)) {
        // A non-scalar item: recurse so nested lists/maps remain editable. It
        // sits in the chips flow but renders as its own (chips / nested) cell.
        chips.appendChild(this.buildValueCell(view, itemPath, item));
        return;
      }

      const chip = document.createElement('span');
      chip.className = 'cm-frontmatter-chip';

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'cm-frontmatter-chip-input';
      input.value = String(item);
      input.setAttribute('data-fm-interactive', '');
      input.setAttribute('aria-label', `Item ${i + 1}`);
      guardControlMousedown(input);
      input.addEventListener('change', () => {
        writeValueAt(view, itemPath, input.value);
      });
      // VALUE AUTOCOMPLETE: a chip edits one list item; its path is
      // [...path, i], and suggestionKeyForPath strips the numeric index, so the
      // suggestions are the list's own key (e.g. a `tags` chip suggests other
      // `tags` values used across the vault). The datalist hangs off the chip.
      attachValueAutocomplete(view, input, chip, itemPath);
      chip.appendChild(input);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'cm-frontmatter-chip-remove';
      remove.textContent = '×';
      remove.setAttribute('data-fm-interactive', '');
      remove.setAttribute('aria-label', `Remove item ${i + 1}`);
      remove.title = 'Remove item';
      guardControlMousedown(remove);
      remove.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        removeValueAt(view, itemPath);
      });
      chip.appendChild(remove);

      chips.appendChild(chip);
    });

    // Trailing "add item" input: Enter (or change/blur with a non-empty value)
    // appends via addListItemAt. A non-empty Tab commits then swallows the event
    // so the container's generic Tab handler does not bounce focus to the editor;
    // an empty Tab falls through to normal nav.
    const addInput = document.createElement('input');
    addInput.type = 'text';
    addInput.className = 'cm-frontmatter-chip-add';
    addInput.placeholder = 'add item';
    addInput.setAttribute('data-fm-interactive', '');
    addInput.setAttribute('aria-label', 'Add list item');
    guardControlMousedown(addInput);
    // VALUE AUTOCOMPLETE (the primary "add a tag from tags used elsewhere"
    // path): suggest values used for THIS list's key across the vault, minus the
    // items already present, so a user adding a tag sees only NEW candidates.
    // The list `path` (no index) maps straight to the list key; the datalist
    // hangs off the chips container.
    attachValueAutocomplete(
      view,
      addInput,
      chips,
      path,
      () =>
        new Set(
          items
            .filter((item) => !Array.isArray(item) && !isPlainRecord(item))
            .map((item) => String(item)),
        ),
    );

    const commitItem = (): void => {
      const next = addInput.value.trim();
      if (next === '') return;
      addInput.value = '';
      addListItemAt(view, path, next);
    };
    addInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitItem();
      } else if (event.key === 'Tab' && !event.shiftKey) {
        if (addInput.value.trim() !== '') {
          event.preventDefault();
          event.stopPropagation();
          commitItem();
        }
        // Empty: fall through to the container's Tab navigation.
      }
    });
    // change (blur with a non-empty value) also commits, so a click-away doesn't
    // silently drop a half-typed item.
    addInput.addEventListener('change', () => commitItem());

    chips.appendChild(addInput);
    return chips;
  }

  /**
   * A nested YAML map rendered as an indented group: each child key becomes a
   * full property row (buildPropertyRow recursion, so child keys are editable,
   * child values typed, and each row carries its own remove ×), followed by a
   * nested add-row so users can add keys INSIDE the map. The path threads through
   * so every nested edit routes to the right place via the module's `*In`
   * helpers.
   */
  private buildNestedCell(
    view: EditorView,
    path: FrontmatterPath,
    record: Record<string, unknown>,
  ): HTMLElement {
    const group = document.createElement('div');
    group.className = 'cm-frontmatter-nested';
    for (const childKey of Object.keys(record)) {
      group.appendChild(this.buildPropertyRow(view, path, childKey, record[childKey]));
    }
    group.appendChild(this.buildAddRow(view, path));
    return group;
  }

  /**
   * The trailing "add property" row for the map at `parentPath` (`[]` at the
   * top level, a nested map's path inside a `.cm-frontmatter-nested` group): a
   * button that reveals an inline key input. Committing the key (Enter OR Tab)
   * writes the new property with an empty value, then the field rebuilds, the
   * new typed control appears, and focus lands in it (see commitNewProperty +
   * buildValueCell's pendingValueFocusPath path) so the user can flow straight
   * into typing the value. window.prompt is intentionally avoided — the inline
   * input keeps the interaction in-editor and keyboard-accessible.
   */
  private buildAddRow(view: EditorView, parentPath: FrontmatterPath = []): HTMLElement {
    const row = document.createElement('div');
    row.className = 'cm-frontmatter-add';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cm-frontmatter-add-button';
    button.textContent = '+ add property';
    button.setAttribute('data-fm-interactive', '');
    guardControlMousedown(button);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'cm-frontmatter-control cm-frontmatter-add-input';
    input.placeholder = 'property name';
    input.hidden = true;
    input.setAttribute('data-fm-interactive', '');
    guardControlMousedown(input);

    // On an empty key, hide the input and restore the button (the old commit's
    // no-op branch); commitNewProperty handles the non-empty cases.
    const hideAddInput = (): void => {
      button.hidden = false;
      input.hidden = true;
      input.value = '';
    };

    button.addEventListener('click', (event) => {
      event.preventDefault();
      button.hidden = true;
      input.hidden = false;
      input.focus();
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        // Enter commits the key (empty → just collapse the add input).
        event.preventDefault();
        if (!commitNewProperty(view, parentPath, input)) hideAddInput();
      } else if (event.key === 'Tab' && !event.shiftKey) {
        // Tab (no Shift) commits too, so the user can flow key → value without
        // a separate Enter. stopPropagation is essential: otherwise the
        // container's generic Tab handler also fires and bounces focus to the
        // editor, defeating the focus handoff into the new value control. On an
        // empty key we fall through to the generic Tab navigation (no
        // preventDefault) so Tab still moves to the next control as before.
        const key = input.value.trim();
        if (key !== '') {
          event.preventDefault();
          event.stopPropagation();
          commitNewProperty(view, parentPath, input);
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        hideAddInput();
      }
    });

    row.appendChild(button);
    row.appendChild(input);
    return row;
  }
}

function buildFrontmatterDecorations(state: EditorState): DecorationSet {
  const text = state.doc.toString();
  const region = detectFrontmatter(text);
  // A region is only valid when present AND it opens at offset 0 (detection
  // already requires the opening `---` to be the first line, but the explicit
  // gate keeps the contract obvious).
  if (!region.present || region.regionEnd === 0) {
    return Decoration.none;
  }

  const replaceTo = replaceEndFor(text, region.regionEnd);
  const isDrag = state.field(mouseSelectingField, false);
  const touched = shouldShowSource(state, 0, replaceTo);

  if (!touched && !isDrag) {
    // parseFrontmatter operates on the full document and never throws, returning
    // `{ data: {} }` on malformed YAML (the widget then degrades to a source
    // hint rather than rendering an empty form).
    const { data } = parseFrontmatter(text);
    // Default-true so a state missing the field (e.g. the create path before
    // the field is wired) still renders collapsed.
    const collapsed = state.field(frontmatterCollapsedField, false) ?? true;
    const widget = new FrontmatterWidget(region.raw, data, collapsed);
    return Decoration.set(
      Decoration.replace({ widget, block: true }).range(0, replaceTo),
    );
  }

  // Source mode: emit a subtle per-line tint hook (cheap, mirrors mermaid). The
  // raw YAML shows as normal editable text for hand-editing.
  const decorations: Range<Decoration>[] = [];
  for (let pos = 0; pos <= replaceTo; ) {
    const line = state.doc.lineAt(pos);
    decorations.push(Decoration.line({ class: 'cm-frontmatter-source' }).range(line.from));
    if (line.to >= replaceTo) break;
    pos = line.to + 1;
  }
  return Decoration.set(decorations, true);
}

export const frontmatterField = StateField.define<DecorationSet>({
  create(state) {
    return buildFrontmatterDecorations(state);
  },
  update(deco, tr) {
    if (tr.docChanged || tr.reconfigured) return buildFrontmatterDecorations(tr.state);
    // A collapse toggle changes only editor state (no doc/selection change), so
    // rebuild explicitly to swap the summary bar for the form (or back).
    if (tr.effects.some((e) => e.is(setFrontmatterCollapsed))) {
      return buildFrontmatterDecorations(tr.state);
    }
    const isDragging = tr.state.field(mouseSelectingField, false);
    const wasDragging = tr.startState.field(mouseSelectingField, false);
    if (wasDragging && !isDragging) return buildFrontmatterDecorations(tr.state);
    if (isDragging) return deco;
    if (tr.selection) return buildFrontmatterDecorations(tr.state);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
