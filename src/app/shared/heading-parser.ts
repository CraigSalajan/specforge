/**
 * Pure markdown ATX-heading parser behind the outline panel. Operates on raw
 * file content (disk truth) so consumers never couple to the editor buffer.
 *
 * Scope (v1): ATX headings (`#`…`######`) outside fenced code blocks.
 * Setext headings (`===` / `---` underlines) and fences nested inside
 * indented code blocks are intentionally out of scope.
 */

export interface MarkdownHeading {
  /** Heading depth: 1 (`#`) through 6 (`######`). */
  level: number;
  /** Heading text without hash markers; empty for bare `#` lines. */
  text: string;
  /** 1-based source line of the heading. */
  line: number;
}

/**
 * ATX heading per CommonMark: up to 3 spaces of indentation, 1–6 hashes,
 * then whitespace (or end of line) before the text. `#hashtag` is not a
 * heading; 4+ spaces of indentation is an indented code block.
 */
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?[ \t]*$/;

/** Code-fence opener: up to 3 spaces of indentation, then ``` or ~~~ (3+). */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/** Code-fence closer: same shape as the opener but nothing after the run. */
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Extracts the outline of ATX headings from markdown `content`, skipping
 * anything inside fenced code blocks (an unterminated fence swallows the
 * rest of the document, matching CommonMark). Handles LF and CRLF input.
 */
export function parseHeadings(content: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const lines = content.split('\n');
  /** Open fence we are inside of, if any. */
  let fence: { marker: string; length: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      // A closing fence must use the same character and be at least as long.
      if (close && close[1][0] === fence.marker && close[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }

    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = { marker: open[1][0], length: open[1].length };
      continue;
    }

    const match = ATX_HEADING.exec(line);
    if (!match) continue;
    headings.push({
      level: match[1].length,
      text: cleanHeadingText(match[2] ?? ''),
      line: i + 1,
    });
  }

  return headings;
}

/**
 * Strips the optional ATX closing sequence: `## Title ##` → `Title`,
 * `# ###` → `` (all-hash remainder is a bare closing sequence). Hashes not
 * preceded by whitespace stay part of the text (`# C#` → `C#`).
 */
function cleanHeadingText(raw: string): string {
  const text = raw.trim();
  if (/^#+$/.test(text)) return '';
  return text.replace(/[ \t]+#+$/, '');
}
