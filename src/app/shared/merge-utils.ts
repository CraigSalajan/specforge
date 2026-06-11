import { applyPatch, structuredPatch } from 'diff';

export type ThreeWayMergeResult = { ok: true; text: string } | { ok: false };

/**
 * Line-based three-way merge: replays the `base -> theirs` patch on top of
 * `mine`. Used when a file changed on disk under unsaved buffer edits (editor
 * reconcile) and when an AI proposal's base drifted from disk before apply.
 *
 * Returns `{ ok: false }` when the two sides touched overlapping lines —
 * jsdiff's `applyPatch` refuses to fit a hunk whose context/deletions no
 * longer match (fuzzFactor 0), which is exactly the conflict signal we want.
 */
export function threeWayMerge(base: string, mine: string, theirs: string): ThreeWayMergeResult {
  // Trivial cases: both sides identical, or only one side changed.
  if (mine === theirs) return { ok: true, text: mine };
  if (base === mine) return { ok: true, text: theirs };
  if (base === theirs) return { ok: true, text: mine };

  const patch = structuredPatch('base', 'theirs', base, theirs);
  const merged = applyPatch(mine, patch);
  return merged === false ? { ok: false } : { ok: true, text: merged };
}

/** A CodeMirror-compatible single change spec covering only the differing range. */
export interface MinimalChange {
  from: number;
  to: number;
  insert: string;
}

/**
 * Computes the smallest single-range replacement turning `oldText` into
 * `newText` (common prefix/suffix excluded). Dispatching this instead of a
 * whole-document replacement lets CodeMirror map the selection and scroll
 * position through the change. Returns `null` when the texts are identical.
 */
export function computeMinimalChange(oldText: string, newText: string): MinimalChange | null {
  if (oldText === newText) return null;

  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) {
    prefix++;
  }

  let suffix = 0;
  // Cap the suffix so it never overlaps the prefix on repeated characters
  // (e.g. "aaa" -> "aa" must not count the same chars in both directions).
  const maxSuffix = Math.min(oldText.length, newText.length) - prefix;
  while (
    suffix < maxSuffix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)
  ) {
    suffix++;
  }

  return {
    from: prefix,
    to: oldText.length - suffix,
    insert: newText.slice(prefix, newText.length - suffix),
  };
}
