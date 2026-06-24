/**
 * Pure label-name helpers for Linear label syncing (TER-22).
 *
 * SpecForge items carry free-form `tags` (label *names*, never ids — see
 * `../canonical-item`). Before those names can be matched against Linear's
 * existing labels or used to create new ones, they have to be normalized and
 * de-duplicated. These two concerns are split out as pure functions so the
 * matching rules live in one tested place rather than being inlined into the
 * adapter's network code.
 *
 * Like `./errors`, this module is deliberately free of any Electron / Node /
 * client imports and performs no I/O: it is a string-in, string-out helper that
 * runs unchanged under the renderer's jsdom test runner.
 *
 * ## Matching contract
 * Two tag names refer to the same Linear label when their *normalized keys*
 * ({@link normalizeLabelName}) are equal — i.e. matching is case-insensitive and
 * ignores surrounding whitespace. The adapter seeds its name→id index and
 * de-dupes input tags by that same key, so "Bug", " bug ", and "BUG" all resolve
 * to a single label. New labels are still created with the tag's *original*
 * casing (the normalized key is only a lookup key, never the stored name).
 *
 * @see ./linear-adapter for the adapter that resolves/creates labels using these.
 */

/**
 * Normalizes a label/tag name to its match key: trimmed and lower-cased.
 *
 * This is the single definition of "the same label" for syncing — both the
 * seeded name→id index and {@link dedupeTags} key off this value, so changing it
 * changes the matching rule everywhere at once. It returns only the lookup key;
 * it never replaces the name shown to the user or sent to Linear on create.
 *
 * @param name the raw tag/label name.
 * @returns the normalized match key (`name.trim().toLowerCase()`).
 */
export function normalizeLabelName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * De-duplicates a list of tag names by their normalized key.
 *
 * Empty and whitespace-only entries are dropped (they normalize to `''`, which
 * is not a meaningful label). Among entries that share a normalized key, the
 * first occurrence wins and its *original* casing is preserved, so the returned
 * array is a stable, first-seen-order subset of the input with no two entries
 * resolving to the same Linear label.
 *
 * @param tags the raw, possibly duplicated tag names.
 * @returns the unique tag names in first-seen order, original casing intact.
 */
export function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const tag of tags) {
    const key = normalizeLabelName(tag);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    unique.push(tag);
  }
  return unique;
}
