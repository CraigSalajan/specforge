/**
 * Renders AI-authored structured stories into an existing feature document (TER-37).
 *
 * The combined `/decompose-stories` flow feeds the AI the WHOLE feature document as
 * context and gets back a flat list of actionable user stories. This pure module
 * turns that list into the revised file content WITHOUT rewriting anything the user
 * (or a prior run) already wrote:
 *
 *   - ALL existing content — including previously tagged stories AND the feature's
 *     background / goals / context prose — is preserved verbatim. The AI never
 *     rewrites existing material, so manual edits survive.
 *   - Each NEW story is appended under a `## User Stories` section (created if the
 *     doc has none), rendered as `### <title> <!-- sf:id <id> -->` followed by the
 *     structured story body (statement, description, acceptance criteria, open
 *     questions, risks) in the order defined by {@link ./story-format.STORY_FORMAT}.
 *     Each section renders only when it has content.
 *   - The `## User Stories` heading itself is PLAIN — it carries no marker and is
 *     never pushed. ONLY the `### <story>` headings are tagged, so ONLY stories
 *     become Linear items. The epic H1 and any theme/context headings are left
 *     untouched and untagged.
 *
 * Story marker ids are freshly generated and guaranteed unique within the file. The
 * per-file push reads those marker ids as the `localId`s (see
 * `./task-items.buildTaskItemsFromContent`), so the push that follows anchors
 * idempotency on them and pushes EXACTLY the tagged stories — nothing else.
 *
 * Pure + dependency-free (only `crypto.randomUUID` via `./story-markers`) so the
 * renderer can call it directly and the specs can import it under jsdom.
 */

import { computeFencedLines } from '../markdown/fenced-lines';
import { STORY_FORMAT, listLabelLine, type StorySectionId } from './story-format';
import {
  generateUniqueId,
  parseMarkedHeadings,
  renderHeadingWithMarker,
  type MarkedHeading,
} from './story-markers';

/** The plain (untagged, never-pushed) heading new stories are grouped under. */
const USER_STORIES_HEADING = 'User Stories';

/** One AI-authored story, before it is rendered into the doc. */
export interface ProposedStory {
  /** A short imperative title (required) — becomes the `### ` heading + issue title. */
  title: string;
  /** The persona/role clause (optional — part of an "As a …" framing). */
  role?: string;
  /** The capability clause (optional). */
  capability?: string;
  /** The benefit clause (optional). */
  benefit?: string;
  /** A short prose paragraph of additional detail (optional). */
  description?: string;
  /** 2–5 testable acceptance criteria. */
  acceptanceCriteria: string[];
  /** Unresolved questions identified from the doc (optional; omitted when none). */
  openQuestions?: string[];
  /** Risks/concerns identified from the doc (optional; omitted when none). */
  risks?: string[];
}

/** The outcome of {@link buildProposedContent}. */
export interface ProposedDocResult {
  /** The complete revised file content (existing material preserved verbatim). */
  content: string;
  /** Number of NEW story headings added. */
  storiesAdded: number;
  /** Whether a new `## User Stories` section heading was created. */
  sectionCreated: boolean;
}

/**
 * Builds the revised file content from `existingContent` plus the AI's proposed
 * NEW stories. Returns the unchanged content (and zero counts) when `stories` is
 * empty, so an "already fully covered" decomposition writes nothing.
 *
 * Every NEW story lands under the doc's `## User Stories` section — appended to the
 * existing one when present, or under a freshly-created heading at end-of-file.
 * Existing content (prose, epic, prior tagged stories) is never rewritten.
 */
export function buildProposedContent(
  existingContent: string,
  stories: ProposedStory[],
): ProposedDocResult {
  // Nothing to add → leave the file byte-identical (no spurious churn).
  if (stories.length === 0) {
    return { content: existingContent, storiesAdded: 0, sectionCreated: false };
  }

  // Seed the unique-id pool with every id already present so fresh story ids never
  // collide with existing markers (or with each other within this batch). ONLY
  // stories are tagged now, but existing markers at any level are honored.
  const usedIds = new Set<string>();
  for (const h of parseMarkedHeadings(existingContent)) {
    if (h.id !== null) usedIds.add(h.id);
  }
  const mintId = (): string => {
    const id = generateUniqueId(usedIds);
    usedIds.add(id);
    return id;
  };

  const usesCrlf = /\r\n/.test(existingContent);
  const eol = usesCrlf ? '\r\n' : '\n';
  let lines = existingContent.split(/\r?\n/);

  const renderedStories = stories.map((story) => renderStory(story, mintId()));

  // Find the existing `## User Stories` section (case-insensitive, marker-stripped
  // title match). When present, insert the new stories at the end of that section;
  // otherwise append a fresh plain heading + the stories at end-of-file.
  //
  // Fence-aware: a `## User Stories` line inside a fenced code block (e.g. a doc
  // demonstrating the convention) is NOT the real section. Matching it would splice
  // stories INSIDE the fence — corrupting the example AND making them invisible to
  // the fence-AWARE extractor, so the push reports N added but pushes 0. We mirror
  // the extractor's fence handling so detection/insertion ignore fenced headings.
  const headings = realHeadings(lines);
  const existingSection = headings.find(
    (h) => h.level === 2 && h.title.toLowerCase() === USER_STORIES_HEADING.toLowerCase(),
  );

  let sectionCreated = false;
  if (existingSection) {
    lines = insertIntoSection(lines, headings, existingSection, renderedStories);
  } else {
    sectionCreated = true;
  }

  let content = lines.join('\n');
  if (sectionCreated) {
    // A brand-new, PLAIN (untagged → never pushed) section heading + its stories.
    const block = [`## ${USER_STORIES_HEADING}`, ...renderedStories].join('\n\n');
    content = appendBlock(content, block);
  }
  // Re-join with the document's native EOL.
  if (usesCrlf) content = content.replace(/\n/g, eol);

  return {
    content,
    storiesAdded: stories.length,
    sectionCreated,
  };
}

/**
 * Inserts `storyBlocks` at the end of the section owned by the H2 `section`. The
 * section runs from the heading line to the line before the next REAL (non-fenced)
 * heading whose level is ≤ 2 (or EOF). New stories are placed after the section's
 * existing content, each separated by a blank line.
 *
 * `headings` is the fence-aware heading list (see {@link realHeadings}) so a
 * `## …`-looking line inside a fenced example never prematurely closes the section.
 */
function insertIntoSection(
  lines: string[],
  headings: MarkedHeading[],
  section: MarkedHeading,
  storyBlocks: string[],
): string[] {
  // Find where this section ends: the next heading at level ≤ 2.
  let sectionEnd = lines.length;
  let seenSelf = false;
  for (const h of headings) {
    if (h.lineIndex === section.lineIndex) {
      seenSelf = true;
      continue;
    }
    if (seenSelf && h.level <= 2) {
      sectionEnd = h.lineIndex;
      break;
    }
  }

  // Trim trailing blank lines inside the section so the inserted block sits one
  // blank line after the last non-blank section content.
  let insertAt = sectionEnd;
  while (insertAt > section.lineIndex + 1 && lines[insertAt - 1].trim().length === 0) {
    insertAt--;
  }

  const block = storyBlocks.join('\n\n');
  const inserted = ['', ...block.split('\n'), ''];
  return [...lines.slice(0, insertAt), ...inserted, ...lines.slice(insertAt)];
}

/**
 * The document's REAL headings: every parsed heading whose line is NOT inside a
 * fenced code block. The marker parser ({@link parseMarkedHeadings}) is fence-
 * UNAWARE by design (it is bookkeeping over a trusted heading set), so the builder
 * filters fenced lines out here to stay consistent with the fence-AWARE extractor
 * ({@link ../story-markers.extractTaggedTasks}) — otherwise a `## User Stories`
 * heading inside a fenced example would be mistaken for the real section.
 */
function realHeadings(lines: string[]): MarkedHeading[] {
  const fenced = computeFencedLines(lines);
  return parseMarkedHeadings(lines.join('\n')).filter((h) => !fenced.has(h.lineIndex));
}

/**
 * Renders a single story: the `### <title>` heading (always the SHORT title now),
 * then the structured body in {@link STORY_FORMAT} order, EACH section only when
 * it has content. Section labels + order come from the format module so the labels
 * never drift between the renderer and the extractor.
 *
 *   ### <title> <!-- sf:id <id> -->
 *
 *   As a <role>, I want <capability>, so that <benefit>   ← statement (prose)
 *
 *   <description paragraph>                                ← description (prose)
 *
 *   - Acceptance criteria:                                ← list
 *     - …
 *   - Open questions:                                     ← list (only if any)
 *     - …
 *   - Risks:                                              ← list (only if any)
 *     - …
 */
function renderStory(story: ProposedStory, id: string): string {
  const heading = renderHeadingWithMarker(3, headingTitle(story), id);
  const blocks: string[] = [heading];

  for (const section of STORY_FORMAT) {
    if (section.kind === 'prose') {
      const prose = proseSection(story, section.id);
      if (prose.length > 0) blocks.push(prose);
      continue;
    }
    const items = listSection(story, section.id);
    if (items.length === 0) continue;
    const list = [listLabelLine(section.label!), ...items.map((c) => `  - ${c}`)];
    blocks.push(list.join('\n'));
  }

  return blocks.join('\n\n');
}

/**
 * The story's `### ` heading text: ALWAYS the short `title` now (the "As a …"
 * statement lives in the body, not the heading). Falls back to the capability or a
 * placeholder so a heading is always non-empty.
 */
function headingTitle(story: ProposedStory): string {
  const title = (story.title ?? '').trim();
  if (title.length > 0) return title;
  return (story.capability ?? '').trim() || 'Untitled story';
}

/** Renders a prose section's text, or `''` when the section has no content. */
function proseSection(story: ProposedStory, id: StorySectionId): string {
  if (id === 'statement') return statementLine(story);
  if (id === 'description') return (story.description ?? '').trim();
  return '';
}

/**
 * The "As a <role>, I want <capability>, so that <benefit>" line — emitted ONLY
 * when role, capability, AND benefit are all present (a partial statement is
 * dropped rather than rendered half-formed).
 */
function statementLine(story: ProposedStory): string {
  const role = (story.role ?? '').trim();
  const capability = (story.capability ?? '').trim();
  const benefit = (story.benefit ?? '').trim();
  if (role && capability && benefit) {
    return `As a ${role}, I want ${capability}, so that ${benefit}`;
  }
  return '';
}

/** The trimmed, non-empty items of a list section in source order. */
function listSection(story: ProposedStory, id: StorySectionId): string[] {
  const raw =
    id === 'acceptanceCriteria'
      ? story.acceptanceCriteria
      : id === 'openQuestions'
        ? story.openQuestions
        : id === 'risks'
          ? story.risks
          : undefined;
  return (raw ?? []).map((c) => (c ?? '').trim()).filter((c) => c.length > 0);
}

/**
 * Appends `block` after `content` with exactly one blank line between them,
 * normalizing trailing whitespace on the existing content so blank lines never
 * stack. Ends with a trailing newline (the file convention).
 */
function appendBlock(content: string, block: string): string {
  const trimmed = content.replace(/\s+$/, '');
  if (trimmed.length === 0) return `${block}\n`;
  return `${trimmed}\n\n${block}\n`;
}
