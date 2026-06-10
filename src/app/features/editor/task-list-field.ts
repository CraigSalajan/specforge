// Why this exists:
//
// `markdown({ extensions: [GFM] })` parses GFM task-list items, so the lezer
// tree already contains `Task` nodes whose first child is a 3-character
// `TaskMarker` (`[ ]` / `[x]` / `[X]`). But `codemirror-live-markdown`
// (0.5.1-alpha) ships no task-list support — its styleMap and hidden-mark
// handling never touch `TaskMarker` — so checkboxes render as literal source
// text (see the PACKAGE LIMITATIONS note in src/styles.css).
//
// This field mirrors the structure of the in-repo `richTableField` (same
// StateField + decoration build, same drag/selection-aware update cycle):
// on lines the selection does not touch, the marker is replaced by a real
// `<input type="checkbox">` widget; moving the cursor onto the line reveals
// the raw `[ ]` source, matching how the package reveals block formatting
// marks on the active line. Clicking the checkbox toggles the underlying
// `[ ]`/`[x]` text via a normal view dispatch, so the edit flows through the
// editor's existing dirty/auto-save pipeline like any keystroke.

import { EditorState, Range, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { mouseSelectingField, shouldShowSource } from 'codemirror-live-markdown';

const TASK_MARKER = /^\[([ xX])\]$/;

// Flip the 3-char task marker that starts at the widget's document position.
// The position is resolved at click time via `posAtDOM` (never baked into the
// widget), so a DOM node CodeMirror kept alive across unrelated edits still
// toggles the right range. The marker text is re-checked before dispatching
// as a guard against any stale mapping.
function toggleTaskMarker(view: EditorView, dom: HTMLElement): void {
  const from = view.posAtDOM(dom);
  const to = from + 3;
  if (to > view.state.doc.length) return;
  const match = TASK_MARKER.exec(view.state.doc.sliceString(from, to));
  if (!match) return;
  view.dispatch({
    changes: { from, to, insert: match[1] === ' ' ? '[x]' : '[ ]' },
  });
}

class TaskCheckboxWidget extends WidgetType {
  constructor(private readonly checked: boolean) {
    super();
  }

  // Compare checked state only, so CodeMirror reuses the DOM node across
  // transactions and only redraws when a toggle actually changes the marker.
  override eq(other: TaskCheckboxWidget): boolean {
    return this.checked === other.checked;
  }

  override toDOM(view: EditorView): HTMLElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'cm-task-checkbox';
    input.checked = this.checked;
    input.setAttribute(
      'aria-label',
      this.checked ? 'Mark task as not done' : 'Mark task as done',
    );
    input.addEventListener('mousedown', (event) => {
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
    input.addEventListener('click', (event) => {
      // preventDefault: the visual state must come from the document, not the
      // native toggle — the dispatch below rebuilds the field, and eq() sees
      // the flipped state and redraws the widget.
      event.preventDefault();
      toggleTaskMarker(view, input);
    });
    return input;
  }

  // true = CodeMirror leaves events inside the widget alone (no cursor move
  // onto the line, which would swap the widget for source text mid-click).
  // DOM listeners attached in toDOM still receive the events and handle the
  // toggle themselves.
  override ignoreEvent(): boolean {
    return true;
  }
}

function buildTaskDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const isDrag = state.field(mouseSelectingField, false);
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'TaskMarker') return;
      const match = TASK_MARKER.exec(state.doc.sliceString(node.from, node.to));
      if (!match) return;
      // Reveal source whenever the selection touches the marker's LINE (not
      // just the marker itself) — the same active-line rule livePreviewPlugin
      // uses for block formatting marks, so the `- ` list mark and the `[ ]`
      // marker appear and disappear together.
      const line = state.doc.lineAt(node.from);
      const isTouched = shouldShowSource(state, line.from, line.to);
      if (!isTouched && !isDrag) {
        decorations.push(
          Decoration.replace({
            widget: new TaskCheckboxWidget(match[1] !== ' '),
          }).range(node.from, node.to),
        );
      }
    },
  });
  return Decoration.set(
    decorations.sort((a, b) => a.from - b.from),
    true,
  );
}

export const taskListField = StateField.define<DecorationSet>({
  create(state) {
    return buildTaskDecorations(state);
  },
  update(deco, tr) {
    if (tr.docChanged || tr.reconfigured) return buildTaskDecorations(tr.state);
    const isDragging = tr.state.field(mouseSelectingField, false);
    const wasDragging = tr.startState.field(mouseSelectingField, false);
    if (wasDragging && !isDragging) return buildTaskDecorations(tr.state);
    if (isDragging) return deco;
    if (tr.selection) return buildTaskDecorations(tr.state);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
