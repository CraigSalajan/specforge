/**
 * Pure fuzzy-matching for the quick switcher / command palette. Candidates
 * carry a `primary` string (filename, command title) and an optional
 * `secondary` string (vault-relative path, command category).
 *
 * Ranking is tiered, strongest first:
 *
 *   1. primary starts with the query
 *   2. primary contains the query
 *   3. secondary contains the query
 *   4. query is a subsequence of primary
 *   5. query is a subsequence of secondary
 *
 * Within a tier, earlier/tighter/shorter matches score higher. Tier bonuses
 * are bounded so a weaker tier can never overtake a stronger one. Kept free
 * of Angular imports so it is trivially unit-testable.
 */

/** Gap between tiers; all in-tier bonuses stay strictly below this. */
const TIER_STEP = 1000;

const TIER_PRIMARY_PREFIX = 4 * TIER_STEP;
const TIER_PRIMARY_SUBSTRING = 3 * TIER_STEP;
const TIER_SECONDARY_SUBSTRING = 2 * TIER_STEP;
const TIER_PRIMARY_SUBSEQUENCE = 1 * TIER_STEP;
const TIER_SECONDARY_SUBSEQUENCE = 0;

/** Shorter candidates rank higher (the query covers more of them). */
function lengthBonus(queryLength: number, candidateLength: number): number {
  return Math.max(0, 400 - (candidateLength - queryLength));
}

/** Matches near the start of the candidate rank higher. */
function positionBonus(index: number): number {
  return Math.max(0, 200 - index);
}

/**
 * Greedy left-to-right subsequence match. Returns the span (distance from the
 * first to the last matched character, inclusive) or null when `query` is not
 * a subsequence of `text`. The greedy span is not guaranteed minimal — good
 * enough for ranking, and O(n).
 */
function subsequenceSpan(query: string, text: string): { start: number; span: number } | null {
  let start = -1;
  let cursor = 0;
  for (const ch of query) {
    const idx = text.indexOf(ch, cursor);
    if (idx === -1) return null;
    if (start === -1) start = idx;
    cursor = idx + 1;
  }
  if (start === -1) return null; // empty query — callers guard, but be safe
  return { start, span: cursor - start };
}

/** Tighter (less spread-out) subsequences with earlier starts rank higher. */
function subsequenceBonus(queryLength: number, match: { start: number; span: number }): number {
  return Math.max(0, 500 - (match.span - queryLength)) + Math.max(0, 100 - match.start);
}

/**
 * Scores `query` against a candidate. Returns `null` when the candidate does
 * not match at all, `0` for an empty query (everything matches equally — the
 * caller decides the empty-query ordering), otherwise a positive tiered score.
 * Matching is case-insensitive.
 */
export function fuzzyScore(query: string, primary: string, secondary = ''): number | null {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return 0;
  const p = primary.toLowerCase();
  const s = secondary.toLowerCase();

  if (p.startsWith(q)) {
    return TIER_PRIMARY_PREFIX + lengthBonus(q.length, p.length);
  }

  const primaryIdx = p.indexOf(q);
  if (primaryIdx !== -1) {
    return TIER_PRIMARY_SUBSTRING + positionBonus(primaryIdx) + lengthBonus(q.length, p.length);
  }

  const secondaryIdx = s.indexOf(q);
  if (secondaryIdx !== -1) {
    return TIER_SECONDARY_SUBSTRING + positionBonus(secondaryIdx) + lengthBonus(q.length, s.length);
  }

  const primarySub = subsequenceSpan(q, p);
  if (primarySub) {
    return TIER_PRIMARY_SUBSEQUENCE + subsequenceBonus(q.length, primarySub);
  }

  const secondarySub = subsequenceSpan(q, s);
  if (secondarySub) {
    return TIER_SECONDARY_SUBSEQUENCE + subsequenceBonus(q.length, secondarySub);
  }

  return null;
}

/**
 * Filters `items` to those matching `query` and sorts them best-first.
 * Ties break alphabetically on `primary`, then `secondary`, so results are
 * deterministic. An empty query returns all items in their original order.
 */
export function rankItems<T>(
  items: readonly T[],
  query: string,
  primary: (item: T) => string,
  secondary: (item: T) => string = () => '',
): T[] {
  if (query.trim().length === 0) return [...items];

  const scored: { item: T; score: number; primary: string; secondary: string }[] = [];
  for (const item of items) {
    const p = primary(item);
    const s = secondary(item);
    const score = fuzzyScore(query, p, s);
    if (score !== null) scored.push({ item, score, primary: p, secondary: s });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.primary.localeCompare(b.primary) ||
      a.secondary.localeCompare(b.secondary),
  );
  return scored.map((entry) => entry.item);
}
