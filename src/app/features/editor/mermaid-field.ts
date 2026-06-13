// Why this exists:
//
// SpecForge documents lean on diagrams (flows, sequences, state machines), and
// the `codemirror-live-markdown` package has no mermaid support — its
// `codeBlockField` renders a ```mermaid fence as a plain highlighted code
// block. This field renders such fences as actual diagrams, mirroring the
// package's own math-block pattern (FencedCode + CodeInfo match → block
// replace widget) and the in-repo richTableField's update cycle
// (rich-table-field.ts):
//
// - Cursor outside the fence → the whole block is replaced by a rendered SVG
//   widget. Cursor inside (or a selection touching it) → raw source lines,
//   so the diagram is always editable by clicking into it.
// - Mermaid itself is lazy-loaded on the FIRST diagram render (dynamic
//   import, same never-throw degradation as ensureHighlighter in
//   editor.component.ts). Documents without diagrams never pay for the
//   library.
// - Rendering is async, so the widget's toDOM is fed from a module-level
//   LRU render cache: unchanged diagrams re-attach instantly on rebuilds
//   (no flicker), and a diagram that failed to parse doesn't re-render —
//   and re-fail — on every selection change.
// - Render errors show a quiet inline message (mermaid's default error SVG
//   is a giant bomb graphic; we catch the throw and render our own). The
//   source stays reachable by clicking the block.
//
// PRECEDENCE NOTE: the package's codeBlockField decorates EVERY fenced block
// except `math`, so it emits a competing block replace over mermaid fences.
// editor.component.ts wires this field as `Prec.high(mermaidField)` and
// places it before codeBlockField — when replacing decorations overlap,
// CodeMirror draws the higher-precedence one, so the diagram wins. In source
// mode both fields agree (both gate on shouldShowSource) and only emit line
// classes, which coexist.

import { Range, StateField, type EditorState } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { mouseSelectingField, shouldShowSource } from 'codemirror-live-markdown';
import type { Mermaid } from 'mermaid';

/** A finished render: either the SVG markup or a one-line error message. */
export type MermaidRenderResult = { svg: string } | { error: string };

/**
 * True when a fence info string selects mermaid: exact match after
 * trim/lowercase ("mermaid", "MERMAID", "mermaid " → true; "js",
 * "mermaid x" → false).
 */
export function isMermaidLang(info: string | null | undefined): boolean {
  return (info ?? '').trim().toLowerCase() === 'mermaid';
}

// Matches the body font stack in styles.css; mermaid measures text while
// laying out, so it needs the literal stack (it can't resolve CSS vars).
const APP_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

// One-shot lazy loader, mirroring ensureHighlighter (editor.component.ts):
// never awaited at editor startup, never throws — a missing/broken mermaid
// degrades to an inline error in the widget, not a broken editor.
let mermaidLoad: Promise<Mermaid | null> | null = null;
function loadMermaid(): Promise<Mermaid | null> {
  if (!mermaidLoad) {
    mermaidLoad = import('mermaid')
      .then((module) => {
        const mermaid = module.default;
        // Dark-only app: hex literals from the styles.css @theme palette
        // (mermaid needs literals, it can't read CSS vars). Base theme +
        // darkMode derives the long tail of per-diagram colors from these.
        // The single accent (#6366f1) is reserved for "active" semantics
        // (sequence activations, gantt active tasks) per DESIGN.md.
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          fontFamily: APP_FONT_STACK,
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          themeVariables: {
            darkMode: true,
            fontSize: '14px',
            background: '#161a22', // surface-2 (widget background)
            mainBkg: '#1e242e', // surface-3 (node fill)
            primaryColor: '#1e242e',
            primaryBorderColor: '#2f3744', // border-strong
            primaryTextColor: '#e6e9ef', // text-primary
            secondaryColor: '#161a22',
            secondaryBorderColor: '#232a35', // border-subtle
            secondaryTextColor: '#9aa3b2', // text-secondary
            tertiaryColor: '#11141a', // surface-1
            tertiaryBorderColor: '#232a35',
            tertiaryTextColor: '#9aa3b2',
            textColor: '#e6e9ef',
            lineColor: '#9aa3b2', // edges must read clearly on surface-2
            clusterBkg: '#11141a',
            clusterBorder: '#232a35',
            edgeLabelBackground: '#161a22',
            noteBkgColor: '#1e242e',
            noteBorderColor: '#2f3744',
            noteTextColor: '#e6e9ef',
            actorLineColor: '#2f3744',
            activationBkgColor: '#6366f1', // accent
            activationBorderColor: '#818cf8',
            activeTaskBkgColor: '#6366f1',
            activeTaskBorderColor: '#818cf8',
            errorBkgColor: '#1e242e',
            errorTextColor: '#ef4444', // danger
          },
        });
        return mermaid;
      })
      .catch(() => null);
  }
  return mermaidLoad;
}

// Render cache: keyed by trimmed diagram source, LRU via Map insertion order
// (delete + re-set on hit, evict oldest on overflow). Errors are cached too —
// a bad diagram must not re-render on every decoration rebuild.
const RENDER_CACHE_MAX = 100;
const renderCache = new Map<string, MermaidRenderResult>();
// De-dupes concurrent renders of identical source (e.g. the same diagram
// pasted twice) so mermaid runs once per distinct source.
const pendingRenders = new Map<string, Promise<MermaidRenderResult>>();
// Module-level counter keeps mermaid.render element ids unique across all
// widgets and editor instances.
let renderSeq = 0;

function getCachedRender(source: string): MermaidRenderResult | undefined {
  const hit = renderCache.get(source);
  if (hit !== undefined) {
    // LRU touch: re-insertion moves the entry to the back of the Map's
    // iteration order, so eviction always drops the least recently used.
    renderCache.delete(source);
    renderCache.set(source, hit);
  }
  return hit;
}

function cacheRender(source: string, result: MermaidRenderResult): void {
  renderCache.delete(source);
  renderCache.set(source, result);
  if (renderCache.size > RENDER_CACHE_MAX) {
    const oldest = renderCache.keys().next().value;
    if (oldest !== undefined) renderCache.delete(oldest);
  }
}

function renderDiagram(source: string): Promise<MermaidRenderResult> {
  const pending = pendingRenders.get(source);
  if (pending) return pending;
  const task = (async (): Promise<MermaidRenderResult> => {
    const mermaid = await loadMermaid();
    if (!mermaid) return { error: 'mermaid failed to load' };
    const id = `mermaid-d-${renderSeq++}`;
    try {
      const { svg } = await mermaid.render(id, source);
      return { svg };
    } catch (err) {
      // mermaid.render throws on parse errors AND (in some versions) leaves
      // an orphaned error element in document.body — remove both the svg id
      // and the temporary `d<id>` enclosing div it may have appended.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
      const message = err instanceof Error ? err.message : String(err);
      const firstLine = message.split('\n', 1)[0].trim();
      return { error: firstLine || 'diagram failed to render' };
    }
  })().then((result) => {
    cacheRender(source, result);
    pendingRenders.delete(source);
    return result;
  });
  pendingRenders.set(source, task);
  return task;
}

export class MermaidWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }

  override eq(other: MermaidWidget): boolean {
    // Same trimmed source → same diagram; CodeMirror reuses the existing DOM,
    // which also keeps any in-flight async render pointed at live nodes.
    return this.source === other.source;
  }

  // Roughly the rendered min-height (kept in sync with .cm-mermaid-widget's
  // min-height in styles.css) so scroll geometry doesn't jump while the
  // first async render is pending.
  override get estimatedHeight(): number {
    return 60;
  }

  override toDOM(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-mermaid-widget';
    if (this.source === '') {
      // Never worth loading mermaid for; its own error for "" is cryptic.
      showError(container, 'empty diagram');
      return container;
    }
    const cached = getCachedRender(this.source);
    if (cached) {
      applyResult(container, cached);
      return container;
    }
    const loading = document.createElement('div');
    loading.className = 'cm-mermaid-loading';
    loading.textContent = 'Rendering diagram…';
    container.appendChild(loading);
    void renderDiagram(this.source).then((result) => {
      // Widget DOM may have been destroyed (file switched, block edited)
      // before the render finished — the result stays cached for the next
      // toDOM, so nothing is lost by bailing here.
      if (!container.isConnected) return;
      applyResult(container, result);
    });
    return container;
  }

  // false for everything: the diagram has no interactive children
  // (securityLevel 'strict' strips click bindings), so every click should
  // fall through to CodeMirror, which places the cursor at the block edge —
  // shouldShowSource treats a boundary cursor as inside, flipping the block
  // to editable source. Same click-to-edit contract as RichTableWidget's
  // non-interactive areas. NOTE: WidgetType's default ignoreEvent returns
  // true (editor ignores widget events), which would make the diagram a
  // dead click target.
  override ignoreEvent(): boolean {
    return false;
  }
}

function applyResult(container: HTMLElement, result: MermaidRenderResult): void {
  if ('svg' in result) {
    // Deliberately NOT re-sanitized: DOMPurify mangles SVG, and mermaid's
    // strict securityLevel already encodes labels / strips interactivity.
    container.innerHTML = result.svg;
  } else {
    showError(container, result.error);
  }
}

function showError(container: HTMLElement, message: string): void {
  const error = document.createElement('div');
  error.className = 'cm-mermaid-error';
  error.textContent = `Mermaid: ${message}`;
  container.replaceChildren(error);
}

function buildMermaidDecorations(state: EditorState): DecorationSet {
  const decorations: Range<Decoration>[] = [];
  const isDrag = state.field(mouseSelectingField, false);
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'FencedCode') return;
      const codeInfo = node.node.getChild('CodeInfo');
      if (!codeInfo) return;
      if (!isMermaidLang(state.doc.sliceString(codeInfo.from, codeInfo.to))) return;
      const isTouched = shouldShowSource(state, node.from, node.to);
      if (!isTouched && !isDrag) {
        const codeText = node.node.getChild('CodeText');
        const source = codeText
          ? state.doc.sliceString(codeText.from, codeText.to).trim()
          : '';
        decorations.push(
          Decoration.replace({ widget: new MermaidWidget(source), block: true }).range(
            node.from,
            node.to,
          ),
        );
      } else {
        // Source mode: line-class treatment mirroring richTableField. The
        // visible styling comes from the package codeBlockField's parallel
        // cm-codeblock-source lines (mono font, surface tint) — this class
        // is the field's own hook and keeps source mode styleable if the
        // codeBlockField wiring ever changes.
        for (let pos = node.from; pos <= node.to; ) {
          const line = state.doc.lineAt(pos);
          decorations.push(
            Decoration.line({ class: 'cm-mermaid-source' }).range(line.from),
          );
          pos = line.to + 1;
        }
      }
    },
  });
  return Decoration.set(
    decorations.sort((a, b) => a.from - b.from),
    true,
  );
}

export const mermaidField = StateField.define<DecorationSet>({
  create(state) {
    return buildMermaidDecorations(state);
  },
  update(deco, tr) {
    if (tr.docChanged || tr.reconfigured) return buildMermaidDecorations(tr.state);
    const isDragging = tr.state.field(mouseSelectingField, false);
    const wasDragging = tr.startState.field(mouseSelectingField, false);
    if (wasDragging && !isDragging) return buildMermaidDecorations(tr.state);
    if (isDragging) return deco;
    if (tr.selection) return buildMermaidDecorations(tr.state);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
