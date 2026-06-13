import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';

/**
 * Transient line highlight used by jump-to-line navigation (AI citation
 * clicks). Dispatch `setRevealHighlight.of(pos)` with a document position on
 * the target line to flash it, and `setRevealHighlight.of(null)` to clear.
 *
 * The visual is deliberately quiet per DESIGN.md: a low-opacity wash of the
 * single indigo accent that fades out — state indication, not decoration.
 * Under `prefers-reduced-motion` there is no animation; the line gets a brief
 * static highlight instead, removed when the caller dispatches the clear
 * effect (the editor does this on a timer matching the fade duration).
 */
export const setRevealHighlight = StateEffect.define<number | null>({
  map: (pos, mapping) => (pos === null ? null : mapping.mapPos(pos)),
});

const revealLineDecoration = Decoration.line({ class: 'cm-reveal-line' });

const revealHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    // The flash is ephemeral feedback for "you are here"; any edit ends it
    // immediately. This also sidesteps remapping a line decoration onto a
    // position that is no longer a line start.
    if (tr.docChanged) deco = Decoration.none;
    for (const effect of tr.effects) {
      if (effect.is(setRevealHighlight)) {
        deco =
          effect.value === null
            ? Decoration.none
            : Decoration.set([
                revealLineDecoration.range(tr.state.doc.lineAt(effect.value).from),
              ]);
      }
    }
    return deco;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// Accent as rgba matches the editor's existing convention (selection uses
// rgba(99, 102, 241, …) rather than var(--color-accent)).
const revealHighlightTheme = EditorView.baseTheme({
  '.cm-reveal-line': {
    animation: 'cm-reveal-line-fade 1200ms ease-out forwards',
  },
  '@keyframes cm-reveal-line-fade': {
    from: { backgroundColor: 'rgba(99, 102, 241, 0.22)' },
    to: { backgroundColor: 'transparent' },
  },
  '@media (prefers-reduced-motion: reduce)': {
    '.cm-reveal-line': {
      animation: 'none',
      backgroundColor: 'rgba(99, 102, 241, 0.16)',
    },
  },
});

/** How long the flash decoration stays before the editor clears it. */
export const REVEAL_HIGHLIGHT_MS = 1200;

export const revealLineExtension = [revealHighlightField, revealHighlightTheme];
