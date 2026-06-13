/**
 * Pure wikilink extractor for markdown.
 *
 * Rules:
 *  - Matches `[[Target]]`, `[[Target|alias]]`, `[[Target#Heading]]` and
 *    combinations; the stored target is the inner text before any `|` alias
 *    or `#` fragment, trimmed.
 *  - Links inside fenced code blocks (``` or ~~~) are ignored (fence handling
 *    mirrors `chunker.ts`).
 *  - Links inside inline code spans (`` `…` ``) are ignored. Spans follow the
 *    CommonMark rule: a run of N backticks closes at the next run of exactly
 *    N backticks on the same line.
 *  - Links with an empty target (e.g. `[[#Heading]]` same-file anchors or
 *    `[[|alias]]`) are skipped.
 *  - Lines are 1-based.
 */

export interface WikiLinkRef {
  /** Document target: inner text before any `|` alias or `#` fragment, trimmed. */
  target: string;
  /** 1-based line number where the link appears. */
  line: number;
}

const FENCE_RE = /^(```|~~~)/;
const WIKILINK_RE = /\[\[([^[\]]+?)\]\]/g;

/**
 * Reduces wikilink inner text to its document target: everything before the
 * first `|` (alias) and `#` (heading fragment), trimmed. Returns '' for
 * same-file anchors like `#Heading`.
 */
export function normalizeWikiTarget(inner: string): string {
  return inner.split('|')[0].split('#')[0].trim();
}

/**
 * Blanks out inline code spans so wikilinks inside them are not matched.
 * Unmatched backtick runs are left as-is (they do not open a span).
 */
function maskInlineCode(line: string): string {
  if (!line.includes('`')) return line;
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') {
      out += line[i];
      i++;
      continue;
    }
    // Opening backtick run.
    let j = i;
    while (j < line.length && line[j] === '`') j++;
    const openLen = j - i;
    // Find the next backtick run of exactly the same length.
    let closeStart = -1;
    let k = j;
    while (k < line.length) {
      if (line[k] !== '`') {
        k++;
        continue;
      }
      let m = k;
      while (m < line.length && line[m] === '`') m++;
      if (m - k === openLen) {
        closeStart = k;
        break;
      }
      k = m;
    }
    if (closeStart === -1) {
      // No closing run: not a code span, keep the backticks verbatim.
      out += line.slice(i, j);
      i = j;
    } else {
      const end = closeStart + openLen;
      out += ' '.repeat(end - i);
      i = end;
    }
  }
  return out;
}

/**
 * Extracts all wikilinks with 1-based line numbers from a markdown document.
 */
export function extractWikiLinks(source: string): WikiLinkRef[] {
  const lines = source.split(/\r?\n/);
  const out: WikiLinkRef[] = [];

  let inFence = false;
  let fenceMarker = '';

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

    const masked = maskInlineCode(line);
    WIKILINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKILINK_RE.exec(masked)) !== null) {
      const target = normalizeWikiTarget(m[1]);
      if (target.length === 0) continue;
      out.push({ target, line: i + 1 });
    }
  }

  return out;
}
