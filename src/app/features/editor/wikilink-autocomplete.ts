/**
 * `[[` autocomplete: typing `[[` pops a completion of the vault's markdown
 * files (label = basename without `.md`, dimmed detail = relPath; popup
 * chrome themed in styles.css under .cm-tooltip-autocomplete). Accepting
 * inserts the target plus the closing `]]` — reusing an existing `]]`
 * directly after the cursor instead of doubling it — and the corpus comes
 * from a getter so the live VaultService-backed list is read at each
 * keystroke, never captured stale at editor construction.
 */

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { WikiCompletionEntry } from './wikilink-utils';

// Matches `[[` plus a partial target up to the cursor. Brackets and newlines
// end the region — once the user types `]` the link is being closed by hand.
const WIKI_PREFIX = /\[\[[^\][\n]*$/;

/** Re-filter client-side while the user keeps typing plain target text. */
const VALID_FOR = /^[^\][\n]*$/;

export function wikiLinkAutocomplete(
  getEntries: () => readonly WikiCompletionEntry[],
): Extension {
  return autocompletion({
    override: [(context) => wikiLinkCompletionSource(context, getEntries())],
    icons: false,
  });
}

function wikiLinkCompletionSource(
  context: CompletionContext,
  entries: readonly WikiCompletionEntry[],
): CompletionResult | null {
  const match = context.matchBefore(WIKI_PREFIX);
  if (!match || entries.length === 0) return null;
  const from = match.from + 2; // start of the target text, just past `[[`
  const options: Completion[] = entries.map((entry) => ({
    label: entry.label,
    detail: entry.detail,
    apply: (view, _completion, applyFrom, applyTo) =>
      applyWikiCompletion(view, entry.insert, applyFrom, applyTo),
  }));
  return { from, options, validFor: VALID_FOR };
}

/**
 * Replaces the typed partial target with `insert` and closes the link. When
 * `]]` already follows the cursor (editing an existing link), it is reused;
 * either way the cursor lands after the closing brackets.
 */
function applyWikiCompletion(
  view: EditorView,
  insert: string,
  from: number,
  to: number,
): void {
  const alreadyClosed = view.state.sliceDoc(to, to + 2) === ']]';
  view.dispatch({
    changes: { from, to, insert: alreadyClosed ? insert : `${insert}]]` },
    selection: { anchor: from + insert.length + 2 },
    userEvent: 'input.complete',
  });
}
