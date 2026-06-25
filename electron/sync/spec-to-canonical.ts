/**
 * Spec → CanonicalItem converter.
 *
 * SpecForge has no structured spec data model — the vault is portable markdown.
 * The spec hierarchy (epic → feature → story → acceptance-criteria) is a
 * *convention* expressed in the markdown the app's own AI prompts produce
 * (see `src/app/features/ai/prompts/create-stories.prompt.ts`):
 *
 *   - a doc under `/prd/` starting with a top-level `# title` (the EPIC),
 *   - stories grouped under `## Theme` headings (each a FEATURE),
 *   - each story an "As a … I want … so that …" line (a STORY),
 *   - a nested `- Acceptance criteria:` bullet list per story (its CRITERIA).
 *
 * This module parses that convention and emits {@link CanonicalItem}[] to feed
 * the (already-built, pure) {@link planPush}. The output `localId`s map 1:1 to
 * `SyncLink.specItemId`.
 *
 * ## Two layers, mirroring the rest of `electron/sync/*`
 * - {@link specToCanonicalItems} is the **pure core**: markdown docs in,
 *   canonical items out, with zero `fs` / `getDb` / network imports. Like the
 *   sync engine it can run under the Vitest (jsdom) test environment, which
 *   cannot open SQLite or touch the disk.
 * - {@link collectSpecDocs} / {@link buildCanonicalItemsForVault} are the **thin
 *   impure reader**: they walk `<root>/prd`, read files and hand the docs to the
 *   pure core. `root` is passed in explicitly — this module never resolves the
 *   active vault itself (the TER-29 orchestrator owns that and injects it).
 *
 * ## Hierarchy convention — HYBRID
 * Per document (a single `# H1`):
 *   - **Epic** = the file's `# H1`. `title` = H1 text; `description` = the body
 *     between the H1 and the first `##` (trimmed); no `parentLocalId`. Carries
 *     the file's `tags` (frontmatter; see below).
 *   - **Feature** = each `## H2` ("Theme"). `title` = H2 text; `description` =
 *     the H2 body, excluding the story / acceptance-criteria content lifted out
 *     into Story items; `parentLocalId` = the epic.
 *   - **Story** = under a feature, every "As a … I want … so that …" line
 *     (case-insensitive, tolerating leading `-`/`*` bullet markers and
 *     surrounding whitespace). **Fallback:** a feature with NO "As a …" lines
 *     uses its `### H3` headings as stories instead. `parentLocalId` = the
 *     feature.
 *   - **Acceptance criteria** = the bullets of a story's nested
 *     `- Acceptance criteria:` list → the story's `criteria: string[]` (one
 *     entry per bullet, in source order). No standalone `criterion`-level items
 *     are emitted; Linear V1 folds them inline (see `level-mapping.ts`). The
 *     `criterion` level value stays valid in the type but is unused here.
 *
 * A doc with no `# H1` is skipped (deterministically — no filename fallback).
 * Non-conforming docs never throw: we emit what matches and skip the rest.
 *
 * Parsing is fence-aware throughout: heading detection (via {@link parseHeadings})
 * and story / acceptance-criteria scanning both ignore lines inside fenced code
 * blocks, so a fenced `## heading`, `As a …` line or `Acceptance criteria:` label
 * is inert prose that stays in the surrounding description.
 *
 * ## tags
 * Read from frontmatter `data['tags']` (a string[] — a single string is coerced
 * to a one-element array; absent / non-string entries are ignored) and attached
 * to that file's **epic** item. No prompt writes a `tags:` key today; this
 * module defines that contract.
 *
 * ## localId (stable, unique, deterministic — AC #2)
 * Ids must be STABLE across re-runs on identical input, UNIQUE within the batch,
 * and DETERMINISTIC. They are NOT derived from content (a body edit would orphan
 * the SyncLink) nor from line numbers (they shift on edits). Instead:
 *   - the **epic**'s id is the frontmatter `id:` when present (string), else the
 *     document `relPath`;
 *   - a **feature**'s id is `${epicId}#${featureAnchor}`, where the anchor is a
 *     slug of the H2 text, disambiguated among duplicate siblings with a numeric
 *     suffix (`-2`, `-3`, …);
 *   - a **story**'s id is `${featureId}/${storyAnchor}`. Heading-fallback stories
 *     slug their H3 text (same sibling disambiguation); "As a …" stories use
 *     their 1-based ordinal within the feature (`s1`, `s2`, …) since story lines
 *     can be long or duplicated.
 *
 * CAVEAT: without an explicit frontmatter `id:`, the derived id embeds the
 * `relPath` and heading text, so RENAMING a file or EDITING a heading changes the
 * derived id — the next push sees a new item (re-create), not an update of the
 * old one. Set `id:` in frontmatter to pin an epic's identity across renames.
 *
 * ## ordering (deterministic — AC #4)
 * {@link collectSpecDocs} sorts docs by `relPath`. Within a doc, items are
 * emitted in source order: epic, then each feature in heading order, then that
 * feature's stories in source order. We never rely on `fs.readdir` order.
 * `planPush`'s topological sort preserves sibling INPUT order, so this input
 * order is the final order.
 *
 * @see ./canonical-item for the output model.
 * @see ./sync-engine for the downstream `planPush`.
 * @see ../markdown/heading-parser for the ATX heading parser reused here.
 */

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { CanonicalItem } from './canonical-item';
import { parseFrontmatter } from '../frontmatter/frontmatter';
import { parseHeadings, type MarkdownHeading } from '../markdown/heading-parser';

/** A single markdown spec document, addressed by its vault-relative path. */
export interface SpecDoc {
  /** Vault-relative path with forward slashes (e.g. `prd/auth-stories.md`). */
  relPath: string;
  /** Raw file content (any line endings; the parser is CRLF-safe). */
  content: string;
}

/** Directories never walked when collecting spec docs (mirrors the indexer). */
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.specforge',
  '.obsidian',
  '.vscode',
  'dist',
  'out',
]);

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

/** Code-fence opener: up to 3 spaces of indentation, then ``` or ~~~ (3+). */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** Code-fence closer: same shape as the opener but nothing after the run. */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Indices of `lines` that fall *inside* a fenced code block (the fence delimiter
 * lines themselves included). Story- and criteria-line scanning consult this so a
 * fenced `As a … I want …` example or `- Acceptance criteria:` label is treated as
 * inert prose — never lifted into a story. This mirrors the fence handling in
 * {@link parseHeadings} (which already keeps fenced `##` lines from becoming
 * features), keeping the converter consistently fence-aware. An unterminated fence
 * swallows the rest of the document, matching CommonMark and the heading parser.
 */
function computeFencedLines(lines: string[]): Set<number> {
  const fenced = new Set<number>();
  let fence: { marker: string; length: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (fence) {
      fenced.add(i);
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = { marker: open[1][0], length: open[1].length };
      fenced.add(i);
    }
  }
  return fenced;
}

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

  // Collect "As a …" story lines in this scope (fenced lines are inert prose).
  const asAStories: ParsedStory[] = [];
  for (let i = scopeStart; i < scopeEnd; i++) {
    if (!fenced.has(i) && STORY_LINE.test(lines[i])) {
      consumed.add(i);
      const criteria = collectCriteriaAfter(lines, i + 1, scopeEnd, consumed, fenced);
      asAStories.push({ title: stripBullet(lines[i]), criteria, fromHeading: false });
    }
  }

  if (asAStories.length > 0) {
    return { stories: asAStories, consumed };
  }

  // Fallback: H3 headings within this scope become stories.
  const h3s = featureHeadings.filter(
    (h) => h.level === 3 && h.line - 1 >= scopeStart && h.line - 1 < scopeEnd,
  );
  const stories: ParsedStory[] = [];
  for (let k = 0; k < h3s.length; k++) {
    const h3 = h3s[k];
    const headingLine = h3.line - 1;
    consumed.add(headingLine);
    // The H3 body runs to the next H3 (or end of scope).
    const nextLine = k + 1 < h3s.length ? h3s[k + 1].line - 1 : scopeEnd;
    const criteria = collectCriteriaAfter(lines, headingLine + 1, nextLine, consumed, fenced);
    stories.push({ title: h3.text, criteria, fromHeading: true });
  }
  return { stories, consumed };
}

/**
 * Collects the bullets of an "Acceptance criteria:" list that begins somewhere
 * in `[start, end)`. Scans for the criteria label, then gathers the following
 * bullet lines (more-indented or sibling bullets) until a non-bullet,
 * non-blank line or the scope end. Marks every consumed line in `consumed`.
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
    if (line.trim().length === 0) {
      // A single blank line inside the list is tolerated; mark and continue.
      consumed.add(i);
      continue;
    }
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
 * processed in the order given (sort upstream — {@link collectSpecDocs} does).
 * Non-conforming docs are skipped without throwing.
 */
export function specToCanonicalItems(docs: SpecDoc[]): CanonicalItem[] {
  const items: CanonicalItem[] = [];
  for (const doc of docs) {
    appendDocItems(items, doc);
  }
  return items;
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

  // Epic id: explicit frontmatter `id:` wins, else the document relPath.
  const epicId = readExplicitId(data) ?? doc.relPath;

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

  const epic: CanonicalItem = { localId: epicId, level: 'epic', title: h1.text };
  if (epicDescription !== undefined) epic.description = epicDescription;
  const tags = readTags(data);
  if (tags !== undefined) epic.tags = tags;
  out.push(epic);

  // Each H2 → a feature; recognize its stories, then derive its clean description.
  const usedFeatureAnchors = new Map<string, number>();
  for (let fi = 0; fi < h2Indices.length; fi++) {
    const h2 = featureHeadings[h2Indices[fi]];
    const { start, end } = bodyBounds(featureHeadings, h2Indices[fi], lines.length);

    const featureAnchor = uniqueAnchor(slugify(h2.text), usedFeatureAnchors);
    const featureId = `${epicId}#${featureAnchor}`;

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
      title: h2.text,
      parentLocalId: epicId,
    };
    if (featureDescription !== undefined) feature.description = featureDescription;
    out.push(feature);

    // Stories: "As a …" lines use ordinal anchors; H3-fallback stories slug text.
    const usedStoryAnchors = new Map<string, number>();
    let asAOrdinal = 0;
    for (const story of stories) {
      const anchor = story.fromHeading
        ? uniqueAnchor(slugify(story.title), usedStoryAnchors)
        : `s${(asAOrdinal += 1)}`;
      const storyItem: CanonicalItem = {
        localId: `${featureId}/${anchor}`,
        level: 'story',
        title: story.title,
        parentLocalId: featureId,
      };
      if (story.criteria !== undefined) storyItem.criteria = story.criteria;
      out.push(storyItem);
    }
  }
}

/**
 * IMPURE: walk `<root>/prd` recursively for `.md` files (skipping ignored
 * dirs), read each one, and return the docs sorted by `relPath` (relative to
 * `<root>`, forward-slashed). Returns `[]` when the `prd` folder is absent.
 *
 * Synchronous on purpose: the TER-29 orchestrator calls this off the UI thread
 * (main process) and wants a settled list before planning a push; the file set
 * is small (a vault's `/prd/`).
 */
export function collectSpecDocs(root: string): SpecDoc[] {
  const prdRoot = path.join(root, 'prd');
  const abs = walkMarkdownSync(prdRoot);
  const docs: SpecDoc[] = [];
  for (const file of abs) {
    let content: string;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue; // unreadable file → skip, never throw
    }
    docs.push({ relPath: toRelPath(root, file), content });
  }
  docs.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return docs;
}

/** IMPURE convenience: {@link collectSpecDocs} + {@link specToCanonicalItems}. */
export function buildCanonicalItemsForVault(root: string): CanonicalItem[] {
  return specToCanonicalItems(collectSpecDocs(root));
}

/** Vault-relative, forward-slashed path (stable identity across platforms). */
function toRelPath(root: string, absPath: string): string {
  return path.relative(root, absPath).split(path.sep).join('/');
}

/**
 * Recursive `.md` walk mirroring the indexer's `walkMarkdown` (replicated here
 * rather than imported, since the indexer's helper is not exported and pulls in
 * the DB). Skips {@link IGNORED_DIRS}; returns `[]` if `dir` is absent.
 */
function walkMarkdownSync(dir: string): string[] {
  const out: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // missing/unreadable dir → skip
    }
    for (const e of entries) {
      if (IGNORED_DIRS.has(e.name)) continue;
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
        out.push(full);
      }
    }
  }
  return out;
}
