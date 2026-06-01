/**
 * Pure markdown -> chunk splitter.
 *
 * Rules:
 *  - A chunk is bounded by ATX headings (`# … ######`).
 *  - When a new heading is encountered, the current chunk ends.
 *  - `heading_path` is the breadcrumb of ancestor headings + this heading,
 *    e.g. `"# Title > ## Section > ### Subsection"`.
 *  - Headings inside fenced code blocks are ignored.
 *  - Files with no headings produce one chunk with `headingPath = ''`,
 *    `level = 0`, containing the entire document.
 *  - Lines are 1-based; `endLine` is inclusive.
 */

export interface Chunk {
  headingPath: string;
  level: number;
  content: string;
  startLine: number;
  endLine: number;
}

interface HeadingInfo {
  level: number;
  text: string;
  line: number;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^(```|~~~)/;

function parseHeading(line: string): HeadingInfo | null {
  const m = HEADING_RE.exec(line);
  if (!m) return null;
  return {
    level: m[1].length,
    text: m[2].trim(),
    line: 0, // filled in by caller
  };
}

function formatHeadingSegment(h: HeadingInfo): string {
  return `${'#'.repeat(h.level)} ${h.text}`;
}

export function chunkMarkdown(source: string): Chunk[] {
  const lines = source.split(/\r?\n/);
  const chunks: Chunk[] = [];

  // Detect headings outside fenced code blocks.
  let inFence = false;
  let fenceMarker = '';
  const headings: HeadingInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE_RE.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1];
      } else if (line.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = '';
      }
      continue;
    }
    if (inFence) continue;
    const h = parseHeading(line);
    if (h) {
      h.line = i + 1; // 1-based
      headings.push(h);
    }
  }

  if (headings.length === 0) {
    const content = source;
    if (content.length === 0) return [];
    return [
      {
        headingPath: '',
        level: 0,
        content,
        startLine: 1,
        endLine: lines.length,
      },
    ];
  }

  // Optional preamble before first heading.
  if (headings[0].line > 1) {
    const preamble = lines.slice(0, headings[0].line - 1).join('\n');
    if (preamble.trim().length > 0) {
      chunks.push({
        headingPath: '',
        level: 0,
        content: preamble,
        startLine: 1,
        endLine: headings[0].line - 1,
      });
    }
  }

  // Maintain ancestor stack for breadcrumb.
  const stack: HeadingInfo[] = [];

  for (let h = 0; h < headings.length; h++) {
    const current = headings[h];
    while (stack.length > 0 && stack[stack.length - 1].level >= current.level) {
      stack.pop();
    }
    stack.push(current);

    const next = headings[h + 1];
    const startLine = current.line;
    const endLine = next ? next.line - 1 : lines.length;
    const content = lines.slice(startLine - 1, endLine).join('\n');

    const headingPath = stack.map(formatHeadingSegment).join(' > ');

    chunks.push({
      headingPath,
      level: current.level,
      content,
      startLine,
      endLine,
    });
  }

  return chunks;
}
