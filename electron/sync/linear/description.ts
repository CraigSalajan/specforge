/**
 * Description composition for the Linear adapter (TER-21).
 *
 * Folds a {@link CanonicalItem}'s acceptance criteria into the Markdown
 * `description` that the adapter syncs onto a Linear issue or project, rendered
 * as an unchecked checklist (`- [ ]` lines). The checklist lives inside a
 * stable, marker-bounded region so that a re-sync can locate and rebuild it
 * rather than appending a fresh copy each time — keeping the operation
 * idempotent even though the adapter never reads the remote description before
 * writing (it composes from the local body alone).
 *
 * The module is deliberately pure: no transport, no I/O, no GraphQL. It takes
 * the local body plus the criteria array and returns the composed string (or
 * `undefined`, so a criteria-less, body-less item omits the field exactly as
 * before this change).
 *
 * ## Why marker-bounded, not append-only
 * The model carries no remote state, so we cannot diff against what Linear
 * already stores. Instead every write produces a *deterministic* description:
 * the user-authored body (with any prior {@link CRITERIA_MARKER_START} /
 * {@link CRITERIA_MARKER_END} region removed and its trailing whitespace
 * normalized), then a single freshly rendered region holding the current
 * criteria. Because the output is rebuilt from the current `(body, criteria)`
 * alone — never edited in place — re-running with the same criteria yields a
 * byte-identical string and re-running with changed criteria swaps the block
 * with no duplication, regardless of the body's prior spacing, a stray second
 * region, or a criterion whose own text contains a marker literal (those are
 * neutralized so they cannot terminate the region early).
 *
 * Every criterion renders as `- [ ]` (unchecked). The canonical model has no
 * per-criterion checked state, so `- [x]` is never emitted.
 */

/** Opening marker for the synced criteria region (an HTML/Markdown comment, invisible when rendered). */
export const CRITERIA_MARKER_START = '<!-- specforge:criteria:start -->';

/** Closing marker for the synced criteria region. */
export const CRITERIA_MARKER_END = '<!-- specforge:criteria:end -->';

/** Escapes a literal string for safe embedding inside a `RegExp` source. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Globally matches every marked criteria region (markers inclusive) plus any
 * whitespace immediately before it, so removing the region(s) does not leave a
 * dangling blank line behind the preceding body. Built from the marker constants
 * so the two never drift apart. The `g` flag lets a single `replace` clear *all*
 * stale regions, not just the first; it is used only with `String.replace`
 * (never with the stateful `RegExp.test`/`exec`), so there is no `lastIndex`
 * bug. Non-greedy (`*?`) so it stops at the first closing marker.
 */
const CRITERIA_REGION_RE = new RegExp(
  `\\s*${escapeRegExp(CRITERIA_MARKER_START)}[\\s\\S]*?${escapeRegExp(CRITERIA_MARKER_END)}`,
  'g',
);

/**
 * Neutralizes any marker literal embedded *inside* a criterion's text so it can
 * never open or close a region. Without this, a criterion containing the end
 * marker would let the region regex stop early on a re-sync, corrupting the
 * block and breaking idempotency. The zero-width-space splice keeps the text
 * human-readable while ensuring the literal marker substring no longer matches.
 */
function neutralizeMarkers(text: string): string {
  return text
    .replaceAll(CRITERIA_MARKER_START, CRITERIA_MARKER_START.replace('<!--', '<!​--'))
    .replaceAll(CRITERIA_MARKER_END, CRITERIA_MARKER_END.replace('-->', '--​>'));
}

/** Keeps only criteria with visible (non-whitespace) text, trimmed of outer whitespace. */
function normalizeCriteria(criteria: string[] | undefined): string[] {
  if (criteria === undefined) return [];
  return criteria.map((c) => c.trim()).filter((c) => c.length > 0);
}

/**
 * Removes every marked criteria region from `body`. When at least one region is
 * removed, trailing whitespace left behind by the removal is also trimmed so no
 * dangling blank line survives. When `body` has no region, it is returned
 * byte-identical (no trim), preserving the pre-TER-21 no-op: a description that
 * was never touched must round-trip unchanged, trailing whitespace and all.
 */
function stripRegions(body: string): string {
  const stripped = body.replace(CRITERIA_REGION_RE, '');
  return stripped === body ? body : stripped.replace(/\s+$/, '');
}

/**
 * Renders the marker-bounded criteria block. Each entry becomes one unchecked
 * `- [ ]` checklist line (trimmed by {@link normalizeCriteria}, with any embedded
 * marker literal neutralized by {@link neutralizeMarkers}). Empty/whitespace-only
 * entries are dropped. The returned string is the region only — the markers and
 * the lines between them, no surrounding body.
 *
 * @example
 * renderCriteriaChecklist(['First', 'Second'])
 * // <!-- specforge:criteria:start -->
 * // - [ ] First
 * // - [ ] Second
 * // <!-- specforge:criteria:end -->
 */
export function renderCriteriaChecklist(criteria: string[]): string {
  const lines = normalizeCriteria(criteria).map((c) => `- [ ] ${neutralizeMarkers(c)}`);
  return [CRITERIA_MARKER_START, ...lines, CRITERIA_MARKER_END].join('\n');
}

/**
 * Composes the description the adapter writes by merging the user-authored
 * `body` with the item's `criteria`.
 *
 * Behaviour:
 * - **No non-empty criteria** → returns `body` unchanged, except that any
 *   existing marked region in `body` is stripped (so clearing all criteria
 *   removes a previously-synced checklist). A `body` of `undefined` stays
 *   `undefined`, so a criteria-less, body-less item still omits the field.
 * - **Criteria present** → rebuilds the description as the user-authored body
 *   (with any prior region(s) removed) followed by exactly one freshly rendered
 *   block, separated by a single blank line. When the body is empty (or was only
 *   a region), the block stands alone with no leading whitespace.
 *
 * The result is always derived from the *current* body and criteria alone — it
 * never edits a region in place — so it is idempotent for any `(body, criteria)`:
 * `composeDescription(composeDescription(b, c), c) === composeDescription(b, c)`,
 * even when the body carries a previously-composed region, multiple regions, or
 * surrounding whitespace.
 */
export function composeDescription(
  body: string | undefined,
  criteria: string[] | undefined,
): string | undefined {
  const normalized = normalizeCriteria(criteria);

  // No criteria to fold: hand back the body, but drop any stale marked region so
  // removing all criteria also removes the checklist it once produced. A
  // region-free body round-trips byte-identical (see stripRegions), preserving
  // the pre-TER-21 no-op exactly.
  if (normalized.length === 0) {
    return body === undefined ? undefined : stripRegions(body);
  }

  // Rebuild deterministically: the body with any prior region(s) removed and its
  // trailing whitespace normalized, then a single fresh block separated by one
  // blank line. Trimming the prefix's trailing whitespace (not just what region
  // removal leaves) keeps the separator exactly `\n\n` regardless of how the body
  // was spaced, so re-composing is byte-stable. The block stands alone (no leading
  // blank line) when the body contributes no text, so a region-only or
  // whitespace-only body collapses cleanly instead of leaking a leading separator.
  const prefix = (body === undefined ? '' : stripRegions(body)).replace(/\s+$/, '');
  const block = renderCriteriaChecklist(normalized);
  return prefix.length === 0 ? block : `${prefix}\n\n${block}`;
}
