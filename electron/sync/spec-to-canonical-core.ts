/**
 * Spec → CanonicalItem converter — the PURE core (no `fs`, no `path`, no I/O).
 *
 * Split out of `./spec-to-canonical` (TER-37) so the RENDERER can import the pure
 * conversion (e.g. {@link buildCanonicalItemsFromContent}, used by the combined
 * decompose-and-push review to preview the AI's proposed content in-memory)
 * WITHOUT pulling `node:fs`/`node:path` into the browser bundle. The impure
 * readers (vault/file walkers) stay in `./spec-to-canonical`, which re-exports
 * everything here so existing main-side imports are unchanged.
 *
 * The full hierarchy + id derivation contract lives in `./spec-to-canonical`'s
 * module docblock; this file is its dependency-free heart.
 *
 * @see ./canonical-item for the output model.
 * @see ./spec-to-canonical for the impure readers + the full contract docblock.
 * @see ./story-markers for the inline `sf:id` marker format (the localId anchor).
 */

import type { CanonicalItem } from './canonical-item';
import { parseFrontmatter } from '../frontmatter/frontmatter';
import { computeFencedLines } from '../markdown/fenced-lines';
import { parseHeadings, type MarkdownHeading } from '../markdown/heading-parser';
import { parseMarkerId, stripMarkerFromTitle } from './story-markers';

/** A single markdown spec document, addressed by its vault-relative path. */
export interface SpecDoc {
  /** Vault-relative path with forward slashes (e.g. `prd/auth-stories.md`). */
  relPath: string;
  /** Raw file content (any line endings; the parser is CRLF-safe). */
  content: string;
}

/**
 * Recognizes a user story line in the "As a … I want … so that …" form. The
 * line may carry a leading bullet marker (`-`, `*`, `+`) and surrounding
 * whitespace; matching is case-insensitive. We require "as a" and a later "want"
 * to avoid treating an ordinary sentence beginning with "As a" as a story.
 */
const STORY_LINE = /^\s*(?:[-*+]\s+)?as\s+an?\b.*\bi\s+want\b/i;

/**
 * Recognizes the "Acceptance criteria:" label that opens a story's nested
 * criteria list. Tolerates a leading bullet, an optional `**bold**` wrapper and
 * a trailing colon.
 */
const CRITERIA_LABEL = /^\s*(?:[-*+]\s+)?\**\s*acceptance\s+criteria\s*\**\s*:?\s*$/i;

/** A list bullet line: leading indentation, a `-`/`*`/`+` marker, then text. */
const BULLET_LINE = /^(\s*)(?:[-*+])\s+(.*)$/;

/** Strips an optional leading bullet marker and surrounding whitespace. */
function stripBullet(line: string): string {
  const m = BULLET_LINE.exec(line);
  return (m ? m[2] : line).trim();
}

/**
 * Slugifies heading text into a stable, url-ish anchor: lowercased, non-alphanum
 * runs collapsed to single hyphens, leading/trailing hyphens trimmed. Empty or
 * all-punctuation text yields `'section'` so an anchor is always present.
 */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'section';
}

/**
 * Disambiguates `anchor` against anchors already used among a sibling set:
 * first use is unchanged, subsequent collisions get `-2`, `-3`, … The `used`
 * map is mutated to track the running count per base anchor.
 */
function uniqueAnchor(anchor: string, used: Map<string, number>): string {
  const count = used.get(anchor) ?? 0;
  used.set(anchor, count + 1);
  return count === 0 ? anchor : `${anchor}-${count + 1}`;
}

/** Coerces a frontmatter `tags` value to a string[] (single string → one entry). */
function readTags(data: Record<string, unknown>): string[] | undefined {
  const raw = data['tags'];
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) {
    const tags = raw.filter((t): t is string => typeof t === 'string');
    return tags.length > 0 ? tags : undefined;
  }
  return undefined;
}

/** Reads a frontmatter `id` value as a non-empty trimmed string, else undefined. */
function readExplicitId(data: Record<string, unknown>): string | undefined {
  const raw = data['id'];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Joins body lines, trimming surrounding blank lines but preserving interior
 * structure. Returns `undefined` for an empty/blank-only body so we never emit
 * an empty `description` (which would needlessly enter the content hash).
 */
function joinBody(lines: string[]): string | undefined {
  const text = lines.join('\n').replace(/^\s+|\s+$/g, '');
  return text.length > 0 ? text : undefined;
}

/**
 * Computes the `[start, end)` 0-based body bounds for the heading at `index`
 * within `headings`: the body runs from the line after the heading up to the
 * next heading whose level is ≤ this heading's level (its scope closes there).
 */
function bodyBounds(
  headings: MarkdownHeading[],
  index: number,
  totalLines: number,
): { start: number; end: number } {
  const current = headings[index];
  const start = current.line; // 0-based line AFTER the heading (heading.line is 1-based)
  let end = totalLines;
  for (let j = index + 1; j < headings.length; j++) {
    if (headings[j].level <= current.level) {
      end = headings[j].line - 1;
      break;
    }
  }
  return { start, end };
}

/** Internal: a story parsed out of a feature scope before id assignment. */
interface ParsedStory {
  title: string;
  criteria?: string[];
  /** True when the story came from an `### H3` heading (fallback path). */
  fromHeading: boolean;
  /**
   * The story's stable `sf:id` marker id, when its `### H3` heading carries one
   * (TER-37). `undefined` for unmarked H3 stories and all "As a …" line stories
   * (a non-heading bullet line cannot carry a heading marker). When present it IS
   * the story's `localId`.
   */
  markerId?: string;
}

/**
 * Parses one document's lines + headings into stories for a given feature scope
 * (the line range `[scopeStart, scopeEnd)`), using the H3 headings that fall in
 * that scope for the fallback path.
 *
 * Returns the parsed stories (title + criteria) in source order, plus the set of
 * line indices "consumed" by story/criteria content so the caller can compute a
 * clean feature description from what's left.
 */
function parseStoriesInScope(
  lines: string[],
  featureHeadings: MarkdownHeading[],
  scopeStart: number,
  scopeEnd: number,
  fenced: Set<number>,
): { stories: ParsedStory[]; consumed: Set<number> } {
  const consumed = new Set<number>();

  // H3 headings within this scope, in source order.
  const h3s = featureHeadings.filter(
    (h) => h.level === 3 && h.line - 1 >= scopeStart && h.line - 1 < scopeEnd,
  );

  // Collect "As a …" story lines in this scope (fenced lines are inert prose).
  // A `### As a …` H3 *heading* line is NOT an "As a …" story line — STORY_LINE
  // never matches a leading `#`, so it falls to the marked/heading path below.
  const asAStories: ParsedStory[] = [];
  for (let i = scopeStart; i < scopeEnd; i++) {
    if (!fenced.has(i) && STORY_LINE.test(lines[i])) {
      consumed.add(i);
      const criteria = collectCriteriaAfter(lines, i + 1, scopeEnd, consumed, fenced);
      asAStories.push({ title: stripBullet(lines[i]), criteria, fromHeading: false });
    }
  }

  if (asAStories.length > 0) {
    // "As a …" lines are the stories. But a MARKED H3 carries an explicit, stable
    // `sf:id` identity that must never be silently dropped (idempotency anchor —
    // dropping it would orphan its SyncLink and re-create the item). So when both
    // forms coexist (e.g. a hand-written "As a …" bullet alongside a builder-added
    // `### As a … <!-- sf:id X -->` heading under the same theme), emit the marked
    // H3 stories too, appended after the line stories. UNMARKED H3s stay inert in
    // the feature description, exactly as before (whole-vault behavior unchanged) —
    // so only marked H3 lines are consumed here.
    const markedH3Stories = parseH3Stories(lines, h3s, scopeEnd, consumed, fenced, true);
    return { stories: [...asAStories, ...markedH3Stories], consumed };
  }

  // Fallback: every H3 heading in scope becomes a story (marked or not).
  return { stories: parseH3Stories(lines, h3s, scopeEnd, consumed, fenced, false), consumed };
}

/**
 * Parses the H3 headings in a feature scope into stories, marking their lines
 * (and any criteria) consumed. A marked H3 (`### As a … <!-- sf:id X -->`)
 * contributes its marker id as the story's localId and the marker-stripped text
 * as the title; an unmarked H3 uses its heading text. The H3 body runs to the
 * next H3 (or `scopeEnd`).
 *
 * When `markedOnly` is set, only marked H3s are lifted into stories (and consumed);
 * unmarked H3s are left untouched so they stay in the feature description. This is
 * the coexistence path where "As a …" lines are already the primary stories and we
 * only rescue marked H3s for their stable identity.
 */
function parseH3Stories(
  lines: string[],
  h3s: MarkdownHeading[],
  scopeEnd: number,
  consumed: Set<number>,
  fenced: Set<number>,
  markedOnly: boolean,
): ParsedStory[] {
  const stories: ParsedStory[] = [];
  for (let k = 0; k < h3s.length; k++) {
    const headingLine = h3s[k].line - 1;
    const markerId = parseMarkerId(lines[headingLine]) ?? undefined;
    if (markedOnly && markerId === undefined) continue; // leave unmarked H3s inert
    consumed.add(headingLine);
    const nextLine = k + 1 < h3s.length ? h3s[k + 1].line - 1 : scopeEnd;
    const criteria = collectCriteriaAfter(lines, headingLine + 1, nextLine, consumed, fenced);
    const title = markerId !== undefined ? stripMarkerFromTitle(lines[headingLine]) : h3s[k].text;
    stories.push({ title, criteria, fromHeading: true, markerId });
  }
  return stories;
}

/**
 * Collects the bullets of an "Acceptance criteria:" list that begins somewhere
 * in `[start, end)`. Scans for the criteria label, then gathers the following
 * bullet lines until a blank line (paragraph break), a non-bullet line, or the
 * scope end. Marks every consumed line in `consumed`.
 * Returns `undefined` when no criteria list is found.
 */
function collectCriteriaAfter(
  lines: string[],
  start: number,
  end: number,
  consumed: Set<number>,
  fenced: Set<number>,
): string[] | undefined {
  let labelLine = -1;
  for (let i = start; i < end; i++) {
    if (fenced.has(i)) continue; // fenced content is inert
    const line = lines[i];
    if (CRITERIA_LABEL.test(line)) {
      labelLine = i;
      break;
    }
    // A new story line ends our search before any criteria label appears.
    if (STORY_LINE.test(line)) return undefined;
  }
  if (labelLine === -1) return undefined;
  consumed.add(labelLine);

  const criteria: string[] = [];
  for (let i = labelLine + 1; i < end; i++) {
    if (fenced.has(i)) break; // a fence closes the list
    const line = lines[i];
    if (line.trim().length === 0) break; // a blank line (paragraph break) ends the list
    if (STORY_LINE.test(line)) break; // next story starts
    const bullet = BULLET_LINE.exec(line);
    if (!bullet) break; // non-bullet content closes the list
    consumed.add(i);
    criteria.push(bullet[2].trim());
  }
  return criteria.length > 0 ? criteria : undefined;
}

/**
 * PURE: convert markdown spec docs into canonical items. No I/O.
 *
 * Items are emitted in deterministic source order per doc (epic, then features
 * in heading order, then each feature's stories in source order); docs are
 * processed in the order given (sort upstream — `collectSpecDocs` does).
 * Non-conforming docs are skipped without throwing.
 */
export function specToCanonicalItems(docs: SpecDoc[]): CanonicalItem[] {
  const items: CanonicalItem[] = [];
  for (const doc of docs) {
    appendDocItems(items, doc);
  }
  return items;
}

/**
 * PURE convenience (TER-37): convert a SINGLE document's IN-MEMORY content to
 * canonical items, without any fs read. This lets the combined decompose-and-push
 * review compute its push preview from the AI's *proposed* file content before
 * that content is ever written to disk — the same items the eventual disk-backed
 * push will produce (the marker ids are the localIds either way).
 *
 * `relPath` should be the vault-relative, forward-slashed path the file will live
 * at, so an UNMARKED epic's relPath-derived id still matches the disk push.
 */
export function buildCanonicalItemsFromContent(relPath: string, content: string): CanonicalItem[] {
  return specToCanonicalItems([{ relPath, content }]);
}

/** Parses a single doc, appending its canonical items to `out`. */
function appendDocItems(out: CanonicalItem[], doc: SpecDoc): void {
  const { data, body } = parseFrontmatter(doc.content);
  // Parse headings against the body so frontmatter `#` lines never count, and so
  // heading line numbers index into `body` (which the criteria scan also uses).
  const headings = parseHeadings(body);
  const lines = body.split('\n');
  // Lines inside fenced code blocks are inert for story/criteria scanning, just as
  // they are for heading detection — so a fenced "As a …" example is not a story.
  const fenced = computeFencedLines(lines);

  // The doc's first H1 is the epic; a doc without one is skipped deterministically.
  const h1Index = headings.findIndex((h) => h.level === 1);
  if (h1Index === -1) return;
  const h1 = headings[h1Index];

  // Epic id (TER-37): an inline `sf:id` marker on the H1 wins; else the explicit
  // frontmatter `id:`; else the document relPath. A marked H1 also strips the
  // marker out of the epic title.
  const epicMarkerId = parseMarkerId(lines[h1.line - 1]);
  const epicId = epicMarkerId ?? readExplicitId(data) ?? doc.relPath;
  const epicTitle = epicMarkerId !== null ? stripMarkerFromTitle(lines[h1.line - 1]) : h1.text;

  // Features are the H2 headings after the H1, in source order.
  const featureHeadings = headings.slice(h1Index + 1);
  const h2Indices = featureHeadings
    .map((h, i) => ({ h, i }))
    .filter((x) => x.h.level === 2)
    .map((x) => x.i);

  // Epic description = body between the H1 line and the first H2 (or EOF).
  const firstH2Line =
    h2Indices.length > 0 ? featureHeadings[h2Indices[0]].line - 1 : lines.length;
  const epicDescription = joinBody(lines.slice(h1.line, firstH2Line));

  const epic: CanonicalItem = { localId: epicId, level: 'epic', title: epicTitle };
  if (epicDescription !== undefined) epic.description = epicDescription;
  const tags = readTags(data);
  if (tags !== undefined) epic.tags = tags;
  out.push(epic);

  // Each H2 → a feature; recognize its stories, then derive its clean description.
  const usedFeatureAnchors = new Map<string, number>();
  for (let fi = 0; fi < h2Indices.length; fi++) {
    const h2 = featureHeadings[h2Indices[fi]];
    const { start, end } = bodyBounds(featureHeadings, h2Indices[fi], lines.length);

    // Feature id (TER-37): an inline `sf:id` marker on the H2 wins; else the
    // slug-anchor derivation. A marked H2 also strips the marker out of its title.
    const featureMarkerId = parseMarkerId(lines[h2.line - 1]);
    const featureId =
      featureMarkerId ?? `${epicId}#${uniqueAnchor(slugify(h2.text), usedFeatureAnchors)}`;
    const featureTitle = featureMarkerId !== null ? stripMarkerFromTitle(lines[h2.line - 1]) : h2.text;

    const { stories, consumed } = parseStoriesInScope(lines, featureHeadings, start, end, fenced);

    // Feature description = the scope body minus any line consumed by a story,
    // its criteria, or an H3 heading we lifted into a story.
    const descLines: string[] = [];
    for (let i = start; i < end; i++) {
      if (!consumed.has(i)) descLines.push(lines[i]);
    }
    const featureDescription = joinBody(descLines);

    const feature: CanonicalItem = {
      localId: featureId,
      level: 'feature',
      title: featureTitle,
      parentLocalId: epicId,
    };
    if (featureDescription !== undefined) feature.description = featureDescription;
    out.push(feature);

    // Stories (TER-37): a marked H3 (`### As a … <!-- sf:id X -->`) uses its marker
    // id as the localId; else "As a …" lines use ordinal anchors and unmarked
    // H3-fallback stories slug their text.
    const usedStoryAnchors = new Map<string, number>();
    let asAOrdinal = 0;
    for (const story of stories) {
      const localId =
        story.markerId !== undefined
          ? story.markerId
          : `${featureId}/${
              story.fromHeading
                ? uniqueAnchor(slugify(story.title), usedStoryAnchors)
                : `s${(asAOrdinal += 1)}`
            }`;
      const storyItem: CanonicalItem = {
        localId,
        level: 'story',
        title: story.title,
        parentLocalId: featureId,
      };
      if (story.criteria !== undefined) storyItem.criteria = story.criteria;
      out.push(storyItem);
    }
  }
}
