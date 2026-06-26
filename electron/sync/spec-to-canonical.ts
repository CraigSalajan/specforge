/**
 * Spec → CanonicalItem converter — the IMPURE readers + the public surface.
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
 * The parsing/derivation logic lives in the PURE, dependency-free
 * {@link ./spec-to-canonical-core} (no `fs`/`path`/network — so the renderer can
 * import {@link specToCanonicalItems} / {@link buildCanonicalItemsFromContent}
 * for the in-memory decompose-and-push preview without dragging `node:fs` into the
 * browser bundle). This module is the thin IMPURE reader layer on top: it walks
 * `<root>/prd`, reads files, and hands the docs to the pure core. `root` is passed
 * in explicitly — this module never resolves the active vault itself (the TER-29
 * orchestrator owns that and injects it). Everything the pure core exports is
 * re-exported here so existing main-side imports are unchanged.
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
 * Parsing is fence-aware throughout: heading detection and story /
 * acceptance-criteria scanning both ignore lines inside fenced code blocks.
 *
 * ## tags
 * Read from frontmatter `data['tags']` (a string[] — a single string is coerced
 * to a one-element array; absent / non-string entries are ignored) and attached
 * to that file's **epic** item.
 *
 * ## localId (stable, unique, deterministic — AC #2)
 * Ids must be STABLE across re-runs on identical input, UNIQUE within the batch,
 * and DETERMINISTIC. They are NOT derived from content (a body edit would orphan
 * the SyncLink) nor from line numbers (they shift on edits).
 *
 * **Marker id wins (TER-37).** When a heading line carries an inline `sf:id`
 * marker (`# Title <!-- sf:id <id> -->`; see `./story-markers`), THAT id IS the
 * `localId` for that epic / feature / story — and the marker is stripped out of
 * the emitted `title`. This makes the id rename- and reorder-proof: the AI authors
 * the structured story list, those stories are saved into the doc tagged with
 * stable marker ids, and the push (idempotency keyed on `sync_links.specItemId`)
 * anchors on those explicit ids, not on heading-derived anchors.
 *
 * **Fallback derivation (unmarked headings; whole-vault backward-compat).** When a
 * heading has no marker, the original derivation is used unchanged:
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
 * CAVEAT (fallback path only): without a marker (and, for the epic, without a
 * frontmatter `id:`), the derived id embeds the `relPath` and heading text, so
 * RENAMING a file or EDITING a heading changes the derived id — the next push sees
 * a new item (re-create), not an update of the old one. Tag the heading with an
 * `sf:id` marker (or set epic `id:` in frontmatter) to pin identity across edits.
 *
 * ## ordering (deterministic — AC #4)
 * {@link collectSpecDocs} sorts docs by `relPath`. Within a doc, items are
 * emitted in source order: epic, then each feature in heading order, then that
 * feature's stories in source order. We never rely on `fs.readdir` order.
 *
 * @see ./spec-to-canonical-core for the PURE conversion (no I/O).
 * @see ./canonical-item for the output model.
 * @see ./sync-engine for the downstream `planPush`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { CanonicalItem } from './canonical-item';
import { specToCanonicalItems, type SpecDoc } from './spec-to-canonical-core';
import { buildTaskItemsFromContent } from './task-items';

// Re-export the pure core's surface so existing main-side imports of these names
// from this module keep working unchanged.
export {
  specToCanonicalItems,
  buildCanonicalItemsFromContent,
  type SpecDoc,
} from './spec-to-canonical-core';

// Re-export the FLAT, stories-only per-file task builder (TER-37) so main-side
// imports can reach it from the same module the converter lives in.
export { buildTaskItemsFromContent } from './task-items';

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

/**
 * IMPURE: build the FLAT, stories-only canonical items for a SINGLE markdown file
 * (TER-37 — push one file rather than the whole vault). The file may live in any
 * vault folder; the AI does the decomposition, so the source location is irrelevant.
 *
 * Reads `<root>/<relPath>` and extracts ONLY its AI-tagged stories (headings
 * carrying an `sf:id` marker) via {@link buildTaskItemsFromContent} — NOT a heading
 * parse. The epic, themes, "Background"/"Goals"/"Context" sections, and any other
 * untagged prose stay in the doc and are never pushed: a doc with `# Epic`, prose,
 * and three tagged stories yields EXACTLY three flat issues.
 *
 * ## Idempotency
 * Each story's `localId` is its `sf:id` marker id, so the items are independent of
 * the file path — a re-run UPDATES the matching Linear issue rather than
 * duplicating it. (Because the marker id is what the whole-vault converter reads
 * for a marked heading too, the per-file and whole-vault paths never duplicate the
 * same story even though only the per-file path is flat/stories-only.)
 *
 * Returns `[]` if the file is missing/unreadable or carries no tagged stories,
 * never throwing — same tolerance as the vault walker.
 */
export function buildTaskItemsForFile(root: string, relPath: string): CanonicalItem[] {
  // Resolve the (possibly forward-slashed) rel against root using the platform
  // separator, then re-relativize for a stable vault-rel string (unused by the
  // flat builder, but kept for parity with the converter's reader).
  const abs = path.resolve(root, relPath.split('/').join(path.sep));
  let content: string;
  try {
    content = readFileSync(abs, 'utf-8');
  } catch {
    return []; // missing/unreadable → no items, never throw
  }
  return buildTaskItemsFromContent(toRelPath(root, abs), content);
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
