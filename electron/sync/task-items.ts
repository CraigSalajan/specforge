/**
 * Tagged-task → CanonicalItem builder — the PURE core (no `fs`, no `path`, no I/O).
 *
 * The per-file push (TER-37) is marker-driven, FLAT, and stories-only: it pushes
 * EXACTLY the AI-authored stories the doc carries an `sf:id` marker on — never the
 * epic, themes, "Background"/"Goals"/"Context" sections, or any other prose. This
 * is the deliberate divergence from the whole-vault Push button, which still parses
 * the entire heading structure via {@link ./spec-to-canonical-core.specToCanonicalItems}.
 *
 * Because every story's `localId` is its marker id (the same id the whole-vault
 * converter reads for a marked heading), the two paths never duplicate the same
 * story: re-running either updates the existing Linear issue.
 *
 * Pure + dependency-free (only {@link ./story-markers.extractTaggedTasks}) so the
 * RENDERER can call it for the in-memory combined-review preview without dragging
 * `node:fs` into the browser bundle, and the specs can import it under jsdom. The
 * impure file reader ({@link ./spec-to-canonical.buildTaskItemsForFile}) lives with
 * the other `fs`-backed readers.
 *
 * @see ./story-markers for {@link extractTaggedTasks} (the marker scan).
 * @see ./canonical-item for the output model.
 */

import type { CanonicalItem } from './canonical-item';
import { sectionLabel } from './story-format';
import { extractTaggedTasks, type TaggedTask } from './story-markers';

/**
 * PURE: build the FLAT, stories-only canonical items from a document's IN-MEMORY
 * content — the source for the per-file push's preview AND execute.
 *
 * Each tagged story becomes a single `level: 'story'` item whose `localId` is its
 * `sf:id` marker id (so idempotency anchors on the explicit id, not a derived
 * anchor), with no `parentLocalId` (flat — no epic/theme parent is created in
 * Linear). The structured story body maps onto the canonical model as:
 *   - `title`       = the short heading title.
 *   - `description` = the captured body prose (statement + description), then an
 *                     `**Open questions**` markdown list and a `**Risks**` list when
 *                     non-empty. Omitted entirely when there is no prose, no open
 *                     questions, and no risks.
 *   - `criteria`    = the acceptance criteria — UNCHANGED path, so the Linear
 *                     adapter keeps folding them into its idempotent `- [ ]`
 *                     checklist (see `./linear/description.composeDescription`).
 * Untagged headings and all background prose are ignored.
 *
 * `relPath` is accepted for signature parity with the converter's
 * `buildCanonicalItemsFromContent` (and call-site clarity), but is unused: a story's
 * identity is its marker id, never the file path.
 */
export function buildTaskItemsFromContent(_relPath: string, content: string): CanonicalItem[] {
  return extractTaggedTasks(content).map((task) => {
    const item: CanonicalItem = {
      localId: task.id,
      level: 'story',
      title: task.title,
    };
    const description = composeStoryDescription(task);
    if (description.length > 0) item.description = description;
    if (task.criteria.length > 0) item.criteria = task.criteria;
    return item;
  });
}

/**
 * Composes the Linear issue DESCRIPTION body for a story: the captured body prose
 * (statement + description), then a `**Open questions**` markdown list and a
 * `**Risks**` markdown list when non-empty — in {@link STORY_FORMAT} order, with
 * the labels sourced from the format module. Acceptance criteria are NOT included
 * here; the Linear adapter folds those into its own idempotent checklist. Returns
 * `''` when there is no prose, no open questions, and no risks (so the caller omits
 * the `description` field).
 */
function composeStoryDescription(task: TaggedTask): string {
  const blocks: string[] = [];
  const prose = task.statementAndDescription.trim();
  if (prose.length > 0) blocks.push(prose);
  blocks.push(...markdownListBlock('openQuestions', task.openQuestions));
  blocks.push(...markdownListBlock('risks', task.risks));
  return blocks.join('\n\n');
}

/**
 * A `**<Label>**` heading followed by a `- ` markdown list, or `[]` when the items
 * are empty (so the section is omitted). The label is the format's section label;
 * empty/whitespace items are dropped.
 */
function markdownListBlock(
  id: 'openQuestions' | 'risks',
  items: readonly string[],
): string[] {
  const cleaned = items.map((c) => c.trim()).filter((c) => c.length > 0);
  if (cleaned.length === 0) return [];
  const lines = [`**${sectionLabel(id)}**`, ...cleaned.map((c) => `- ${c}`)];
  return [lines.join('\n')];
}
