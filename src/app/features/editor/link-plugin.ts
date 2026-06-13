// Why this exists:
//
// The `codemirror-live-markdown` package renders links and `[[wikilinks]]`
// through its `linkPlugin()`, but its wikilink anchors are built inside the
// package's own `LinkWidget.toDOM` — there is no hook to mark a wikilink
// whose target does not exist, and replace-decoration widgets cannot be
// reached by mark decorations from a separate extension. This plugin mirrors
// the package's link plugin (same parsing, same decoration/update cycle,
// same class names so the existing styles.css rules keep applying) — the
// same approach rich-table-field.ts takes for tables — with two behavioral
// additions:
//
// - Wikilinks are REAL: clicking a rendered `[[Target]]` /
//   `[[Target|alias]]` / `[[Target#Heading]]` widget invokes
//   `onWikiLinkClick` with the raw target (alias stripped, fragment kept).
//   The widget claims its pointer events (`ignoreEvent` → true +
//   mousedown preventDefault/stopPropagation, mirroring the task-checkbox
//   wiring in rich-table-field.ts) so CodeMirror does not move the cursor
//   into the link on mousedown — which would flip the widget to source mode
//   and swallow the click before it lands. Editing a wikilink is done by
//   placing the cursor next to it (keyboard or click beside the widget),
//   exactly like the package's tables/code blocks.
// - Wikilinks whose target does not resolve get `cm-wikilink-unresolved`
//   (muted + dashed underline, styled in styles.css) on both the rendered
//   widget and the source-mode mark. Resolution is checked synchronously at
//   decoration build time via the injected `isWikiTargetResolved` callback;
//   dispatching `refreshLinkResolution` forces a rebuild when the vault's
//   file set changes without a doc/selection change.
//
// Regular `[text](url)` links keep the package behavior verbatim: sanitized
// href, open in new tab, `ignoreEvent` → false.

import { StateEffect } from '@codemirror/state';
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { mouseSelectingField, shouldShowSource } from 'codemirror-live-markdown';

/**
 * Effect that forces the plugin to rebuild its decorations. Dispatched by the
 * editor component when the vault's markdown file set changes, so unresolved
 * marks update without waiting for an edit or selection change.
 */
export const refreshLinkResolution = StateEffect.define<null>();

export interface AppLinkPluginOptions {
  /**
   * Synchronous resolvability check for a raw wikilink target (alias already
   * stripped; may still carry a `#fragment`). Drives the unresolved styling.
   */
  isWikiTargetResolved: (rawTarget: string) => boolean;
  /** Invoked when a rendered wikilink widget is clicked. */
  onWikiLinkClick: (rawTarget: string) => void;
}

// Same patterns/skip-list as the package's link plugin.
const WIKI_LINK_REGEX = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const LINK_SYNTAX_REGEX = /^\[([^\]]*)\]\((.+?)(?:\s+["']([^"']+)["'])?\)$/;
const SKIP_PARENT_TYPES = new Set(['FencedCode', 'CodeBlock', 'InlineCode']);
const DANGEROUS_PROTOCOLS = ['javascript:', 'vbscript:', 'data:text/html'];

function sanitizeUrl(url: string): string {
  const lower = url.toLowerCase().trim();
  if (DANGEROUS_PROTOCOLS.some((protocol) => lower.startsWith(protocol))) return '';
  try {
    return encodeURI(url);
  } catch {
    return '';
  }
}

/** Rendered `[text](url)` widget — behavior identical to the package's. */
class ExternalLinkWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly url: string,
    private readonly title: string | undefined,
  ) {
    super();
  }

  override eq(other: ExternalLinkWidget): boolean {
    return other.text === this.text && other.url === this.url && other.title === this.title;
  }

  override toDOM(): HTMLElement {
    const anchor = document.createElement('a');
    anchor.textContent = this.text;
    anchor.title = this.title ?? '';
    anchor.className = 'cm-link-widget';
    const safeUrl = sanitizeUrl(this.url);
    if (safeUrl) anchor.href = safeUrl;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    return anchor;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** Rendered `[[Target]]` widget: navigates (or offers create) on click. */
class WikiLinkWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly target: string,
    private readonly resolved: boolean,
    private readonly onClick: (target: string) => void,
  ) {
    super();
  }

  override eq(other: WikiLinkWidget): boolean {
    // `resolved` participates so a file create/delete redraws the widget.
    return (
      other.text === this.text && other.target === this.target && other.resolved === this.resolved
    );
  }

  override toDOM(): HTMLElement {
    const anchor = document.createElement('a');
    anchor.textContent = this.text;
    anchor.className = this.resolved
      ? 'cm-link-widget cm-wikilink-widget'
      : 'cm-link-widget cm-wikilink-widget cm-wikilink-unresolved';
    // Quiet affordance: hover reveals where the link goes — or that it does
    // not exist yet and a click will offer to create it.
    anchor.title = this.resolved ? this.target : `${this.target} — not created yet`;
    anchor.addEventListener('mousedown', (event) => {
      // preventDefault: keep editor focus/selection where they are.
      // stopPropagation: don't engage the drag-selection tracking the editor
      // component wires on contentDOM (same rationale as the task-checkbox
      // wiring in rich-table-field.ts).
      event.preventDefault();
      event.stopPropagation();
    });
    anchor.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.onClick(this.target);
    });
    return anchor;
  }

  // CodeMirror must leave pointer events on the widget alone: handling the
  // mousedown itself would move the cursor into the link range, flip the
  // widget to source mode, and detach the anchor before its click fires.
  override ignoreEvent(): boolean {
    return true;
  }
}

interface SkipRange {
  from: number;
  to: number;
}

function buildLinkDecorations(
  view: EditorView,
  options: AppLinkPluginOptions,
): DecorationSet {
  const decorations: { from: number; to: number; deco: Decoration }[] = [];
  const state = view.state;
  const isDrag = state.field(mouseSelectingField, false);

  // Code contexts where link syntax stays literal (package skip-list).
  const skipRanges: SkipRange[] = [];
  syntaxTree(state).iterate({
    enter: (node) => {
      if (SKIP_PARENT_TYPES.has(node.name)) {
        skipRanges.push({ from: node.from, to: node.to });
      }
    },
  });
  const isInSkipRange = (from: number, to: number): boolean =>
    skipRanges.some((r) => from >= r.from && to <= r.to);

  // Regular [text](url) links via the syntax tree.
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Link') return;
      if (isInSkipRange(node.from, node.to)) return;
      const text = state.doc.sliceString(node.from, node.to);
      if (text.startsWith('!')) return; // image syntax
      const match = LINK_SYNTAX_REGEX.exec(text);
      if (!match) return;
      const [, linkText, url, title] = match;
      if (!shouldShowSource(state, node.from, node.to) && !isDrag) {
        const widget = new ExternalLinkWidget(linkText, url, title);
        decorations.push({
          from: node.from,
          to: node.to,
          deco: Decoration.replace({ widget }),
        });
      } else {
        decorations.push({
          from: node.from,
          to: node.to,
          deco: Decoration.mark({ class: 'cm-link-source' }),
        });
      }
    },
  });

  // Wikilinks via regex over the document (they are not lezer Link nodes).
  const docText = state.doc.toString();
  WIKI_LINK_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKI_LINK_REGEX.exec(docText)) !== null) {
    const from = match.index;
    const to = from + match[0].length;
    if (isInSkipRange(from, to)) continue;
    const target = match[1];
    const display = match[2] ?? target;
    const resolved = options.isWikiTargetResolved(target);
    if (!shouldShowSource(state, from, to) && !isDrag) {
      const widget = new WikiLinkWidget(display, target, resolved, options.onWikiLinkClick);
      decorations.push({ from, to, deco: Decoration.replace({ widget }) });
    } else {
      const cls = resolved
        ? 'cm-link-source cm-wikilink-source'
        : 'cm-link-source cm-wikilink-source cm-wikilink-unresolved';
      decorations.push({ from, to, deco: Decoration.mark({ class: cls }) });
    }
  }

  return Decoration.set(
    decorations.sort((a, b) => a.from - b.from).map((d) => d.deco.range(d.from, d.to)),
    true,
  );
}

/**
 * Drop-in replacement for the package's `linkPlugin()` (same decoration and
 * update cycle, including the drag-selection handling) with wikilink
 * navigation + unresolved marking. See the header comment for why this is
 * mirrored in-repo.
 */
export function appLinkPlugin(options: AppLinkPluginOptions) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildLinkDecorations(view, options);
      }

      update(update: ViewUpdate): void {
        const resolutionRefreshed = update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(refreshLinkResolution)),
        );
        if (resolutionRefreshed || update.docChanged || update.viewportChanged) {
          this.decorations = buildLinkDecorations(update.view, options);
          return;
        }
        const isDragging = update.state.field(mouseSelectingField, false);
        const wasDragging = update.startState.field(mouseSelectingField, false);
        if (wasDragging && !isDragging) {
          this.decorations = buildLinkDecorations(update.view, options);
          return;
        }
        if (isDragging) return;
        if (update.selectionSet) {
          this.decorations = buildLinkDecorations(update.view, options);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
}
