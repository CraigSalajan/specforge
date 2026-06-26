/**
 * The structured user-story format — the SINGLE source of truth (TER-37).
 *
 * A SpecForge user story is more than an "As a …" line: it has an ordered set of
 * sections (statement, description, acceptance criteria, open questions, risks).
 * This module owns that format in ONE place so the renderer
 * ({@link ./story-doc-builder.renderStory}) and the extractor
 * ({@link ./story-markers.extractTaggedTasks}) derive their doc labels and
 * section order from the same definition instead of hard-coding the strings
 * "Open questions" / "Risks" independently in two files (where they would drift).
 *
 * ## This is the per-vault-config seam
 * The format is HARD-CODED for now. A future story (per-vault configurable story
 * format) replaces this constant — and, where needed, the kind/label fields — with
 * a value resolved from vault settings. Everything downstream already reads the
 * format through {@link STORY_FORMAT} and the helpers below, so that future change
 * is localized HERE: callers do not hard-code labels or ordering of their own.
 *
 * Kept intentionally small: a definition array plus a couple of helpers, NOT a
 * template engine. The renderer still owns markdown mechanics (heading markers,
 * bullet indentation) and the extractor still owns fence-awareness; this module
 * only owns WHICH sections exist, in WHAT order, with WHICH label, and whether
 * each is a prose block or a bullet list.
 *
 * Pure + dependency-free so the renderer, the extractor, and the unit specs (jsdom)
 * can all import it.
 */

/** A section's payload shape: a prose paragraph vs. a nested bullet list. */
export type StorySectionKind = 'prose' | 'list';

/** The stable id of each story section (used by callers to address a section). */
export type StorySectionId =
  | 'statement'
  | 'description'
  | 'acceptanceCriteria'
  | 'openQuestions'
  | 'risks';

/** One section of the structured story format. */
export interface StorySectionDef {
  /** Stable identifier — callers switch on this, never on the label. */
  readonly id: StorySectionId;
  /** Whether the section renders as a prose block or a `- label:` + bullets list. */
  readonly kind: StorySectionKind;
  /**
   * The doc-facing label for a `list` section (the `- <label>:` line). `undefined`
   * for `prose` sections, which carry no label (the statement/description render
   * as bare paragraphs above the first labeled list).
   */
  readonly label?: string;
}

/**
 * The ordered story format. Sections render (and are extracted) in THIS order;
 * each renders only when it has content (see the renderer/extractor).
 *
 * - `statement` — the "As a <role>, I want <capability>, so that <benefit>" line.
 * - `description` — a short prose paragraph of additional detail.
 * - `acceptanceCriteria` — the testable items. Its label and `  - ` bullet style
 *   are deliberately unchanged from before this rework so BOTH the marker
 *   extractor ({@link ./story-markers}) AND the whole-vault converter
 *   ({@link ./spec-to-canonical-core}) keep parsing the same `- Acceptance
 *   criteria:` list.
 * - `openQuestions` / `risks` — listed only when genuinely identified.
 */
export const STORY_FORMAT: readonly StorySectionDef[] = [
  { id: 'statement', kind: 'prose' },
  { id: 'description', kind: 'prose' },
  { id: 'acceptanceCriteria', kind: 'list', label: 'Acceptance criteria' },
  { id: 'openQuestions', kind: 'list', label: 'Open questions' },
  { id: 'risks', kind: 'list', label: 'Risks' },
] as const;

/** The labeled-list sections, in format order — the only sections the extractor scans for. */
export const STORY_LIST_SECTIONS: readonly Required<StorySectionDef>[] = STORY_FORMAT.filter(
  (s): s is Required<StorySectionDef> => s.kind === 'list' && s.label !== undefined,
);

/** The acceptance-criteria section's doc label, sourced from the format definition. */
export const ACCEPTANCE_CRITERIA_LABEL = sectionLabel('acceptanceCriteria');

/**
 * Returns the doc label for a labeled-list section. Throws for a section that has
 * no label (a prose section or an unknown id), so a caller can never silently
 * render/parse the wrong section.
 */
export function sectionLabel(id: StorySectionId): string {
  const section = STORY_FORMAT.find((s) => s.id === id);
  if (!section || section.kind !== 'list' || section.label === undefined) {
    throw new Error(`Story section "${id}" has no list label`);
  }
  return section.label;
}

/**
 * Builds the canonical `- <label>:` opener line for a labeled-list section. The
 * renderer uses this so the exact label text lives only in {@link STORY_FORMAT}.
 */
export function listLabelLine(label: string): string {
  return `- ${label}:`;
}
