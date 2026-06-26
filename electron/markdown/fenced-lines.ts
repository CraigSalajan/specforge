/**
 * Pure helper: the set of line indices that fall *inside* a fenced code block.
 *
 * Lives under `electron/markdown/` as a neutral, dependency-free shared utility
 * (mirroring `./heading-parser` and `electron/frontmatter/frontmatter.ts`): both
 * the main process (the spec → canonical converter, the marker scanner) and the
 * renderer (the in-memory decompose-and-push preview / doc builder) consume it,
 * so the single source of truth lives here and the cross-tree dependency flows in
 * the sanctioned renderer → `electron/` direction.
 *
 * Fence detection MUST be identical everywhere a markdown document is parsed:
 * heading outline ({@link ./heading-parser.parseHeadings}), `sf:id` marker /
 * acceptance-criteria scanning (`electron/sync/story-markers.ts`), the whole-vault
 * converter (`electron/sync/spec-to-canonical-core.ts`), and the story-doc builder
 * (`electron/sync/story-doc-builder.ts`). A divergence is exactly the class of bug
 * TER-37 hit: a `## User Stories` heading inside a fenced example was treated as the
 * real section by a fence-UNAWARE builder while the fence-AWARE extractor ignored
 * it, so new stories were spliced into the code fence and never pushed.
 */

/** Code-fence opener: up to 3 spaces of indentation, then ``` or ~~~ (3+). */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** Code-fence closer: same shape as the opener but nothing after the run. */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** Strips a trailing CR so CRLF content parses identically to LF. */
function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Returns the indices of `lines` that fall inside a fenced code block (the fence
 * delimiter lines themselves included). A closing fence must use the same fence
 * character as its opener and be at least as long. An unterminated fence swallows
 * the rest of the document, matching CommonMark and {@link parseHeadings}.
 * CRLF-safe: a trailing CR is stripped before matching.
 */
export function computeFencedLines(lines: readonly string[]): Set<number> {
  const fenced = new Set<number>();
  let fence: { marker: string; length: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = stripCr(lines[i]);
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
