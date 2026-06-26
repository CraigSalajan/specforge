/**
 * Stable story-id markers (TER-37).
 *
 * SpecForge has no structured spec data model — the vault is portable markdown.
 * To make a push idempotent across edits, renames, and reorders, each managed
 * epic / theme / story heading carries a STABLE id as an inline, same-line HTML
 * comment. The comment renders invisibly in any markdown viewer, yet survives
 * the title text being reworded or the headings being reordered:
 *
 *   `# <epic title> <!-- sf:id <id> -->`
 *   `## <theme title> <!-- sf:id <id> -->`
 *   `### As a <role>, I want <capability>, so that <benefit> <!-- sf:id <id> -->`
 *
 * The id is the canonical `localId` end-to-end: the spec → canonical converter
 * (`./spec-to-canonical`) reads the marker as the item's `localId`, which is what
 * `sync_links.specItemId` is keyed on. So once a story is created in Linear and a
 * SyncLink is written against its marker id, a re-run UPDATES that item instead
 * of duplicating it — no matter how the heading text changes.
 *
 * ## Why a pure, dependency-free module
 * Both the main process (the converter, the combined push orchestration) and the
 * renderer (which authors + injects markers) consume this, and the unit specs
 * (jsdom, no fs/SQLite) import it directly. It therefore imports nothing but
 * `crypto.randomUUID` (available in both the Electron main process and the
 * renderer's global scope).
 *
 * ## Marker format
 * A single canonical form is parsed and emitted: an HTML comment whose body is
 * `sf:id <id>` (a non-whitespace id token), optionally carrying extra trailing
 * key/value metadata (e.g. `linear=ENG-123`) the parser tolerates and ignores.
 * The comment is matched only as the LAST thing on a heading line, so heading
 * text containing `<!-- … -->` earlier in the line is never mistaken for a marker.
 */

import { computeFencedLines } from '../markdown/fenced-lines';
import { STORY_LIST_SECTIONS, type StorySectionId } from './story-format';

/** A heading carrying (or eligible to carry) an `sf:id` marker. */
export interface MarkedHeading {
  /** Heading depth (1 = `#`, 2 = `##`, 3 = `###`). */
  level: number;
  /** Heading text with any trailing `sf:id` marker stripped, trimmed. */
  title: string;
  /** The marker id when present, else `null`. */
  id: string | null;
  /** 0-based index of this heading's line within the split content. */
  lineIndex: number;
}

/**
 * Matches an ATX heading line whose tail is an `sf:id` marker. Capture groups:
 *  1. the hashes (`#`…`###…`),
 *  2. the heading text BEFORE the marker (may be empty),
 *  3. the marker id (a run of non-whitespace).
 *
 * The marker must be the last non-whitespace content on the line; arbitrary
 * trailing metadata inside the comment after the id is allowed and discarded.
 */
const HEADING_WITH_MARKER =
  /^(\s{0,3}#{1,6})[ \t]+(.*?)[ \t]*<!--[ \t]*sf:id[ \t]+(\S+)(?:[ \t]+[^]*?)?[ \t]*-->[ \t]*$/;

/** Matches a plain ATX heading line (no marker): hashes, then text. */
const PLAIN_HEADING = /^(\s{0,3}#{1,6})[ \t]+(.*?)[ \t]*$/;

/**
 * Extracts the `sf:id` marker id from a single line, or `null` when the line is
 * not a marker-bearing heading. Pure; tolerant of trailing metadata.
 */
export function parseMarkerId(line: string): string | null {
  const m = HEADING_WITH_MARKER.exec(stripCr(line));
  return m ? m[3] : null;
}

/**
 * Strips a trailing `sf:id` marker from a single heading line, returning the
 * clean heading text (without the hashes). For a non-marker heading the plain
 * heading text is returned; for a non-heading line the input is returned trimmed.
 */
export function stripMarkerFromTitle(line: string): string {
  const clean = stripCr(line);
  const withMarker = HEADING_WITH_MARKER.exec(clean);
  if (withMarker) return withMarker[2].trim();
  const plain = PLAIN_HEADING.exec(clean);
  if (plain) return plain[2].trim();
  return clean.trim();
}

/**
 * Parses every ATX heading in `content` into a {@link MarkedHeading}, recording
 * whether each carries an `sf:id` marker. Fence-unaware on purpose — the callers
 * that need fence-awareness (the converter) parse headings separately; this
 * helper is used for marker bookkeeping (existing-id collection, injection
 * planning) over the same heading set the converter already trusts.
 */
export function parseMarkedHeadings(content: string): MarkedHeading[] {
  const lines = content.split('\n');
  const out: MarkedHeading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = stripCr(lines[i]);
    const withMarker = HEADING_WITH_MARKER.exec(line);
    if (withMarker) {
      out.push({
        level: withMarker[1].trim().length,
        title: withMarker[2].trim(),
        id: withMarker[3],
        lineIndex: i,
      });
      continue;
    }
    const plain = PLAIN_HEADING.exec(line);
    if (plain) {
      out.push({
        level: plain[1].trim().length,
        title: plain[2].trim(),
        id: null,
        lineIndex: i,
      });
    }
  }
  return out;
}

/**
 * Renders a heading line with an `sf:id` marker appended. `level` is clamped to
 * 1–6; `title` is trimmed. The id is emitted verbatim inside the comment.
 */
export function renderHeadingWithMarker(level: number, title: string, id: string): string {
  const depth = Math.min(6, Math.max(1, Math.floor(level)));
  return `${'#'.repeat(depth)} ${title.trim()} ${renderMarker(id)}`;
}

/** Renders the bare marker comment for an id (no heading hashes). */
export function renderMarker(id: string): string {
  return `<!-- sf:id ${id} -->`;
}

/**
 * Injects an `sf:id` marker onto the heading at `lineIndex` IN PLACE, returning
 * the new full content. A no-op (returns `content` unchanged) when the target
 * line already carries a marker or is not an ATX heading. Used to back-fill an
 * epic H1 that predates the marker convention.
 */
export function injectMarkerAtLine(content: string, lineIndex: number, id: string): string {
  const lines = content.split('\n');
  if (lineIndex < 0 || lineIndex >= lines.length) return content;
  const raw = lines[lineIndex];
  const hadCr = raw.endsWith('\r');
  const line = hadCr ? raw.slice(0, -1) : raw;
  if (parseMarkerId(line) !== null) return content; // already marked
  const plain = PLAIN_HEADING.exec(line);
  if (!plain) return content; // not a heading — leave untouched
  const level = plain[1].trim().length;
  const next = renderHeadingWithMarker(level, plain[2], id);
  lines[lineIndex] = hadCr ? `${next}\r` : next;
  return lines.join('\n');
}

/**
 * Generates a short, unique `sf:id`. Derives a 12-hex-char slug from
 * `crypto.randomUUID()` and, on the astronomically unlikely chance it collides
 * with an id in `existing`, lengthens / regenerates until it is unique. The
 * caller seeds `existing` with every id already in the file and adds each new id
 * to it so a batch of fresh stories never collide with each other.
 */
export function generateUniqueId(existing: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    // Widen the slice on later attempts so we eventually exhaust collisions.
    const width = 12 + attempt;
    const candidate = uuidHex().slice(0, Math.min(32, width));
    if (!existing.has(candidate)) return candidate;
  }
  // Fallback: the full hex is effectively collision-proof.
  return uuidHex();
}

/**
 * One AI-tagged story extracted from a doc — the marker-driven push source.
 *
 * `statementAndDescription` is the BODY PROSE between the `### ` heading and the
 * first recognized labeled list (the "As a …" statement line plus the description
 * paragraph), trimmed. The three lists are the bullets of the format's labeled
 * lists ({@link ./story-format.STORY_FORMAT}); each is `[]` when absent.
 */
export interface TaggedTask {
  /** The heading's `sf:id` marker id — the canonical `localId` for the push. */
  id: string;
  /** The heading text with the marker (and hashes) stripped, trimmed (the short title). */
  title: string;
  /** The body prose (statement + description) before the first labeled list, trimmed. */
  statementAndDescription: string;
  /** The bullets of the `- Acceptance criteria:` list, in source order. */
  criteria: string[];
  /** The bullets of the `- Open questions:` list, in source order (`[]` when none). */
  openQuestions: string[];
  /** The bullets of the `- Risks:` list, in source order (`[]` when none). */
  risks: string[];
}

/**
 * Builds the case-insensitive label matcher for a list section's `- <label>:`
 * opener. Tolerates a leading bullet, an optional `**bold**` wrapper, and a
 * trailing colon — matching the whole-vault converter's acceptance-criteria
 * regex so the two parse the same lines. The label text itself comes from the
 * format definition, so the strings live in exactly one place.
 */
function labelMatcher(label: string): RegExp {
  const words = label.trim().split(/\s+/).map(escapeRegExp).join('\\s+');
  return new RegExp(`^\\s*(?:[-*+]\\s+)?\\**\\s*${words}\\s*\\**\\s*:?\\s*$`, 'i');
}

/** Escapes a literal string for safe embedding inside a `RegExp` source. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The recognized labeled-list sections, each paired with its compiled matcher.
 * Derived ONCE from {@link STORY_LIST_SECTIONS} so adding/renaming a section is a
 * change in {@link ./story-format} alone — the scanner below reads this table.
 */
const LABELED_LISTS: ReadonlyArray<{ id: StorySectionId; match: RegExp }> =
  STORY_LIST_SECTIONS.map((s) => ({ id: s.id, match: labelMatcher(s.label) }));

/** Returns the section id whose label matches `line`, or `null` for a non-label line. */
function matchLabel(line: string): StorySectionId | null {
  for (const { id, match } of LABELED_LISTS) {
    if (match.test(line)) return id;
  }
  return null;
}

/** A list bullet line: leading indentation, a `-`/`*`/`+` marker, then text. */
const BULLET_LINE = /^(\s*)(?:[-*+])\s+(.*)$/;

/** The heading level a story is written at (`### …`) — the only level extracted. */
const STORY_HEADING_LEVEL = 3;

/**
 * Extracts the AI-tagged STORIES from a document — the marker-driven, FLAT,
 * stories-only source for the per-file push (TER-37).
 *
 * This is deliberately NOT a heading-structure parse: a feature spec is mostly
 * background / goals / context prose, and only the AI-authored stories should ever
 * become Linear items. Stories are written at H3 (`### <title> <!-- sf:id <id> -->`;
 * see `./story-doc-builder`), so we walk the document for `###` headings that carry
 * an `sf:id` marker, strip the marker + hashes to get the title, then collect the
 * structured body: the prose (statement + description) before the first labeled
 * list, then each of the format's labeled lists (`- Acceptance criteria:`,
 * `- Open questions:`, `- Risks:`; see `./story-format`).
 *
 * Anything else is ignored: the epic `# H1` (even if a legacy doc left a marker on
 * it), every `## …` theme / `## User Stories` / `## Background` / `## Goals`
 * heading, and all untagged prose. So a doc with `# Epic`, prose, and three tagged
 * `### story` headings yields EXACTLY three tasks — the regression the rework fixes.
 *
 * Fence-aware: an `sf:id`-looking marker inside a fenced code block is inert (a
 * worked example, never a real task), and a fence inside a criteria list closes
 * that list — mirroring the converter's fence handling so the two stay consistent.
 *
 * Returns the tasks in source order. Each task's `id` is its marker id — the
 * canonical `localId` the push anchors idempotency on (`sync_links.specItemId`).
 */
export function extractTaggedTasks(content: string): TaggedTask[] {
  const lines = content.split('\n');
  const fenced = computeFencedLines(lines);
  const tasks: TaggedTask[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (fenced.has(i)) continue; // fenced `sf:id` text is inert
    const m = HEADING_WITH_MARKER.exec(stripCr(lines[i]));
    if (!m) continue; // not a marked heading
    if (m[1].trim().length !== STORY_HEADING_LEVEL) continue; // only `### story` headings
    const body = collectStoryBody(lines, i + 1, fenced);
    tasks.push({
      id: m[3],
      title: m[2].trim(),
      statementAndDescription: body.prose,
      criteria: body.lists.acceptanceCriteria ?? [],
      openQuestions: body.lists.openQuestions ?? [],
      risks: body.lists.risks ?? [],
    });
  }

  return tasks;
}

/** The parsed body of one tagged story: its prose + each recognized labeled list. */
interface StoryBody {
  /** The statement + description prose before the first labeled list, trimmed. */
  prose: string;
  /** Bullets keyed by section id; a key is present only when its list appears. */
  lists: Partial<Record<StorySectionId, string[]>>;
}

/**
 * Parses the body that follows a tagged `### ` heading: the prose (statement +
 * description) up to the first recognized labeled list, then each labeled list in
 * source order. ONE fence-aware, heading-bounded scan drives all three lists
 * (Acceptance criteria / Open questions / Risks) off {@link STORY_FORMAT}'s
 * labels, so the labels live in exactly one place.
 *
 * Scoping mirrors the prior `collectCriteria`: the scan stops at the next heading,
 * a fence, or EOF. Within a list, bullets are gathered until a blank line, a
 * non-bullet line, another label, a heading, a fence, or EOF.
 */
function collectStoryBody(lines: string[], start: number, fenced: Set<number>): StoryBody {
  const proseLines: string[] = [];
  const lists: Partial<Record<StorySectionId, string[]>> = {};
  let i = start;
  let seenLabel = false;

  while (i < lines.length) {
    if (fenced.has(i)) break; // a fence closes the story's scope
    const line = stripCr(lines[i]); // CRLF-safe: `$`-anchored regexes choke on a trailing CR
    if (PLAIN_HEADING.test(line)) break; // the next heading ends this task's scope

    const sectionId = matchLabel(line);
    if (sectionId !== null) {
      seenLabel = true;
      const { bullets, next } = collectBullets(lines, i + 1, fenced);
      // First occurrence wins (a duplicate label is folded into the prior list-less
      // gap, never overwriting a captured list); keeps the parse deterministic.
      if (lists[sectionId] === undefined) lists[sectionId] = bullets;
      i = next;
      continue;
    }

    // Prose only counts BEFORE the first labeled list — anything after the lists
    // begin is out of the structured body and ignored (heading-bounded already).
    if (!seenLabel) proseLines.push(line);
    i++;
  }

  return { prose: proseLines.join('\n').trim(), lists };
}

/**
 * Gathers the bullet lines of a labeled list starting at `start`, until a blank
 * line, a non-bullet line, a heading, another label, a fence, or EOF. Returns the
 * bullets plus the index of the line that closed the list (so the caller resumes
 * scanning there).
 */
function collectBullets(
  lines: string[],
  start: number,
  fenced: Set<number>,
): { bullets: string[]; next: number } {
  const bullets: string[] = [];
  let i = start;
  for (; i < lines.length; i++) {
    if (fenced.has(i)) break; // a fence closes the list
    const line = stripCr(lines[i]);
    if (line.trim().length === 0) break; // a blank line (paragraph break) ends the list
    if (PLAIN_HEADING.test(line)) break; // a heading ends the list
    if (matchLabel(line) !== null) break; // the next labeled list ends this one
    const bullet = BULLET_LINE.exec(line);
    if (!bullet) break; // non-bullet content closes the list
    bullets.push(bullet[2].trim());
  }
  return { bullets, next: i };
}

/** Strips a trailing CR so CRLF content parses identically to LF. */
function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** The 32 hex chars of a v4 UUID (hyphens removed). */
function uuidHex(): string {
  return crypto.randomUUID().replace(/-/g, '');
}
