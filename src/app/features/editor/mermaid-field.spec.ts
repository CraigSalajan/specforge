// Decoration-logic tests only: mermaid itself is lazy-loaded inside the
// widget's async render path, which never runs here (no EditorView, no
// toDOM), so these tests exercise the field without importing the library.

import { EditorState } from '@codemirror/state';
import { Decoration } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import { collapseOnSelectionFacet, mouseSelectingField } from 'codemirror-live-markdown';
import { isMermaidLang, mermaidField, MermaidWidget } from './mermaid-field';

const DIAGRAM_DOC = '# Title\n\n```mermaid\ngraph TD\n  A --> B\n```\n\ntext\n';

function createState(doc: string, anchor = 0): EditorState {
  const base = EditorState.create({
    doc,
    selection: { anchor },
    extensions: [
      markdown({ extensions: [GFM] }),
      // Same live-preview wiring as ensureView (editor.component.ts):
      // shouldShowSource consults both of these.
      collapseOnSelectionFacet.of(true),
      mouseSelectingField,
      mermaidField,
    ],
  });
  // EditorState.create parses with a small time budget, so on a cold parser
  // (first test in a run) the syntax tree can be incomplete when the field's
  // create() runs — in the app the view finishes the parse and triggers a
  // rebuild. Finish the parse here, then re-dispatch the selection so the
  // field deterministically rebuilds from the complete tree.
  ensureSyntaxTree(base, base.doc.length, 5000);
  return base.update({ selection: { anchor } }).state;
}

interface CollectedDecoration {
  from: number;
  to: number;
  deco: Decoration;
}

function collectDecorations(state: EditorState): CollectedDecoration[] {
  const collected: CollectedDecoration[] = [];
  const iter = state.field(mermaidField).iter();
  while (iter.value) {
    collected.push({ from: iter.from, to: iter.to, deco: iter.value });
    iter.next();
  }
  return collected;
}

describe('isMermaidLang', () => {
  it('matches the exact language tag', () => {
    expect(isMermaidLang('mermaid')).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isMermaidLang('MERMAID')).toBe(true);
    expect(isMermaidLang('Mermaid')).toBe(true);
  });

  it('tolerates surrounding whitespace', () => {
    expect(isMermaidLang('mermaid ')).toBe(true);
    expect(isMermaidLang('  mermaid')).toBe(true);
  });

  it('rejects other languages and decorated info strings', () => {
    expect(isMermaidLang('js')).toBe(false);
    expect(isMermaidLang('mermaid x')).toBe(false);
    expect(isMermaidLang('')).toBe(false);
    expect(isMermaidLang(null)).toBe(false);
    expect(isMermaidLang(undefined)).toBe(false);
  });
});

describe('mermaidField', () => {
  it('replaces the whole fenced block with a widget when the selection is outside', () => {
    const state = createState(DIAGRAM_DOC, 0);

    const decorations = collectDecorations(state);

    expect(decorations).toHaveLength(1);
    const [{ from, to, deco }] = decorations;
    expect(from).toBe(DIAGRAM_DOC.indexOf('```mermaid'));
    expect(to).toBe(DIAGRAM_DOC.lastIndexOf('```') + 3);
    expect(deco.spec.block).toBe(true);
    expect(deco.spec.widget).toBeInstanceOf(MermaidWidget);
  });

  it('passes the trimmed fence body to the widget as the diagram source', () => {
    const state = createState(DIAGRAM_DOC, 0);

    const [{ deco }] = collectDecorations(state);

    expect((deco.spec.widget as MermaidWidget).source).toBe('graph TD\n  A --> B');
  });

  it('matches an uppercase ```MERMAID fence', () => {
    const doc = DIAGRAM_DOC.replace('```mermaid', '```MERMAID');
    const state = createState(doc, 0);

    const decorations = collectDecorations(state);

    expect(decorations).toHaveLength(1);
    expect(decorations[0].deco.spec.widget).toBeInstanceOf(MermaidWidget);
  });

  it('shows source lines instead of the widget when the selection is inside the block', () => {
    const anchor = DIAGRAM_DOC.indexOf('graph TD');
    const state = createState(DIAGRAM_DOC, anchor);

    const decorations = collectDecorations(state);

    expect(decorations.some((d) => d.deco.spec.widget)).toBe(false);
    const lineDecorations = decorations.filter(
      (d) => d.deco.spec.class === 'cm-mermaid-source',
    );
    // ```mermaid / graph TD / A --> B / ``` — one line decoration per fence line.
    expect(lineDecorations).toHaveLength(4);
  });

  it('treats a cursor on the fence boundary as inside the block', () => {
    const state = createState(DIAGRAM_DOC, DIAGRAM_DOC.indexOf('```mermaid'));

    const decorations = collectDecorations(state);

    expect(decorations.some((d) => d.deco.spec.widget)).toBe(false);
    expect(decorations.some((d) => d.deco.spec.class === 'cm-mermaid-source')).toBe(true);
  });

  it('leaves non-mermaid fences untouched', () => {
    const state = createState('# Title\n\n```js\nconst x = 1;\n```\n', 0);

    expect(collectDecorations(state)).toHaveLength(0);
  });

  it('leaves fences without an info string untouched', () => {
    const state = createState('# Title\n\n```\nplain\n```\n', 0);

    expect(collectDecorations(state)).toHaveLength(0);
  });

  it('emits nothing for documents without fenced code', () => {
    const state = createState('# Title\n\njust text\n', 0);

    expect(collectDecorations(state)).toHaveLength(0);
  });
});

describe('MermaidWidget', () => {
  it('compares equal for identical source so DOM is reused across rebuilds', () => {
    expect(new MermaidWidget('graph TD').eq(new MermaidWidget('graph TD'))).toBe(true);
    expect(new MermaidWidget('graph TD').eq(new MermaidWidget('graph LR'))).toBe(false);
  });

  it('lets clicks fall through to the editor for click-to-edit', () => {
    expect(new MermaidWidget('graph TD').ignoreEvent()).toBe(false);
  });
});
