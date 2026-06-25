/**
 * Renderer-facing re-export of the pure ATX-heading parser.
 *
 * The implementation lives in `electron/markdown/heading-parser.ts` — a neutral,
 * dependency-free shared utility (mirroring `electron/frontmatter/frontmatter.ts`)
 * consumed by both the main process and the renderer. This module preserves the
 * `@app/shared/heading-parser` import path used by the outline panel and its spec
 * while keeping a single source of truth, so the cross-tree dependency flows
 * renderer → electron (the sanctioned direction).
 */

export { parseHeadings, type MarkdownHeading } from '../../../electron/markdown/heading-parser';
