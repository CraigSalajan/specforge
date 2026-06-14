/**
 * Pure, round-trip YAML frontmatter utilities shared by the main process and
 * the renderer. Deliberately free of any Electron / Node imports (the `yaml`
 * npm package is the only dependency) so it can be unit-tested under the
 * renderer's test runner as well as bundled into the main process. Mirrors the
 * testability pattern of `electron/ipc/skill-scanner.ts`.
 *
 * Two layers are provided:
 *  - {@link detectFrontmatter} works on the ORIGINAL string and never
 *    normalizes line endings, so its character offsets index directly into the
 *    input as given (the editor widget applies them against the live
 *    CodeMirror document).
 *  - {@link parseFrontmatter}, {@link setFrontmatterProperty},
 *    {@link removeFrontmatterProperty}, {@link renameFrontmatterProperty} and
 *    {@link flattenProperties} build on top of detection to read and round-trip
 *    the YAML payload. Round-tripping
 *    goes through `yaml.parseDocument` so comments, blank lines and key order
 *    survive edits. None of these helpers ever throw on malformed YAML.
 *  - {@link setFrontmatterPropertyIn}, {@link removeFrontmatterPropertyIn},
 *    {@link addFrontmatterListItem} and {@link renameFrontmatterPropertyIn} are
 *    path-based variants of the top-level helpers. A "path" is a
 *    `(string | number)[]` — string keys index into maps, number indices into
 *    list items — letting callers edit nested maps and individual list entries.
 *    They share the same `yaml.parseDocument` round-trip and never-throws
 *    discipline as their top-level counterparts.
 */

import { Document, isMap, isScalar, isSeq, parse, parseDocument, Scalar } from 'yaml';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * The location of a leading YAML frontmatter block within a document.
 *
 * Offsets index into the ORIGINAL input string (no CRLF normalization), so
 * callers holding the live document text can splice against them directly.
 */
export interface FrontmatterRegion {
  /** Whether a well-formed `---` … `---` block opens the document. */
  present: boolean;
  /** The full frontmatter block, including both `---` delimiters, sliced from the input. */
  raw: string;
  /** The YAML text between the delimiters (no delimiters, no surrounding newlines added). */
  yamlText: string;
  /**
   * Character offset in the INPUT just past the closing delimiter plus its one
   * trailing line break (if present). `0` when no frontmatter is present.
   */
  regionEnd: number;
}

const ABSENT_REGION: FrontmatterRegion = {
  present: false,
  raw: '',
  yamlText: '',
  regionEnd: 0,
};

/**
 * Detects a leading YAML frontmatter block in `text` without mutating line
 * endings. A region exists only when the text begins (index 0) with `---`
 * immediately followed by a line break (`\n` or `\r\n`). The first subsequent
 * line consisting solely of `---` closes the block; `regionEnd` consumes that
 * closing delimiter plus one following line break when present.
 *
 * Returns {@link ABSENT_REGION} (all-empty) when no such block is found.
 */
export function detectFrontmatter(text: string): FrontmatterRegion {
  // Opening delimiter must be the very first line: `---` then a line break.
  let openEnd: number;
  if (text.startsWith('---\n')) {
    openEnd = 4;
  } else if (text.startsWith('---\r\n')) {
    openEnd = 5;
  } else {
    return ABSENT_REGION;
  }

  // Scan line by line for a closing `---` line.
  let lineStart = openEnd;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart);
    const hasNewline = lineEnd !== -1;
    if (!hasNewline) lineEnd = text.length;

    // The line content excludes the trailing `\n` and a preceding `\r`.
    let contentEnd = lineEnd;
    if (contentEnd > lineStart && text.charCodeAt(contentEnd - 1) === 13 /* \r */) {
      contentEnd -= 1;
    }
    const line = text.slice(lineStart, contentEnd);

    if (line === '---') {
      const yamlText = text.slice(openEnd, lineStart);
      // regionEnd: past the closing delimiter plus one trailing line break.
      let regionEnd = contentEnd;
      if (hasNewline) {
        // `lineEnd` points at the `\n`; consume it (and any preceding `\r`).
        regionEnd = lineEnd + 1;
      }
      return {
        present: true,
        raw: text.slice(0, regionEnd),
        yamlText,
        regionEnd,
      };
    }

    if (!hasNewline) break;
    lineStart = lineEnd + 1;
  }

  return ABSENT_REGION;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** The parsed result of a document: its frontmatter data and remaining body. */
export interface ParsedFrontmatter {
  /** The parsed YAML mapping (always a plain object; `{}` when absent or malformed). */
  data: Record<string, unknown>;
  /** Everything after the closing delimiter (CRLF-normalized to LF). */
  body: string;
  /** Whether a frontmatter block was present (even if its YAML was malformed). */
  present: boolean;
}

/**
 * Returns `value` when it is a plain object record, otherwise `{}`. A scalar or
 * array YAML root (e.g. `---\nfoo\n---`) is coerced to an empty mapping.
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * Normalizes CRLF to LF, detects a leading frontmatter block and parses its
 * YAML. Never throws: malformed YAML yields `{ data: {}, body, present: true }`.
 * When no frontmatter is present, `body` is the full (LF-normalized) text and
 * `present` is `false`. The closing-delimiter newline is consumed, matching the
 * legacy regex `^---\n([\s\S]*?)\n---\n?([\s\S]*)$`.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const normalized = text.replace(/\r\n/g, '\n');
  const region = detectFrontmatter(normalized);
  if (!region.present) {
    return { data: {}, body: normalized, present: false };
  }

  const body = normalized.slice(region.regionEnd);
  try {
    const parsed = parse(region.yamlText);
    return { data: asRecord(parsed), body, present: true };
  } catch {
    return { data: {}, body, present: true };
  }
}

// ---------------------------------------------------------------------------
// Round-trip mutation
// ---------------------------------------------------------------------------

/**
 * Sets (or adds) `key` to `value` in the document's frontmatter, preserving
 * existing comments, blank lines and key order via `yaml.parseDocument`. New
 * keys are appended at the end. When no (or unparseable) frontmatter exists, a
 * fresh leading block is created followed by a blank line, and the original
 * text is preserved verbatim as the body. Never throws.
 */
export function setFrontmatterProperty(text: string, key: string, value: unknown): string {
  const region = detectFrontmatter(text);
  if (region.present) {
    try {
      const doc = parseDocument(region.yamlText);
      doc.set(key, value);
      // `doc.toString()` ends with a trailing newline, so the block reads
      // `---\n<yaml>\n---\n`.
      return `---\n${doc.toString()}---\n` + text.slice(region.regionEnd);
    } catch {
      // Malformed existing YAML: fall through and prepend a fresh block.
    }
  }

  // `new Document()` (vs `parseDocument('{}')`) emits the new mapping in block
  // style (`key: value`) rather than flow style (`{ key: value }`).
  const doc = new Document();
  doc.set(key, value);
  return `---\n${doc.toString()}---\n\n` + text;
}

/**
 * Removes `key` from the document's frontmatter. If no keys remain afterwards
 * the entire frontmatter block is dropped, returning only the body. Comments,
 * blank lines and key order of surviving keys are preserved. When no (or
 * unparseable) frontmatter exists the text is returned unchanged. Never throws.
 */
export function removeFrontmatterProperty(text: string, key: string): string {
  const region = detectFrontmatter(text);
  if (!region.present) return text;

  let doc;
  try {
    doc = parseDocument(region.yamlText);
  } catch {
    return text;
  }
  // `parseDocument` collects syntax errors on `doc.errors` rather than throwing;
  // a later `doc.toString()` on such a document WOULD throw ("Document with
  // errors cannot be stringified") whenever surviving keys force a re-serialize.
  // Bail here — mirroring renameFrontmatterProperty — to keep the never-throws
  // contract and leave malformed YAML untouched.
  if (doc.errors.length > 0) return text;

  doc.delete(key);

  const body = text.slice(region.regionEnd);
  const remaining = asRecord(doc.toJSON());
  if (Object.keys(remaining).length === 0) {
    return body;
  }
  return `---\n${doc.toString()}---\n` + body;
}

/** The string form of a YAML key node (scalar key nodes carry the value on `.value`). */
function keyString(key: unknown): string {
  return String(isScalar(key) ? key.value : key);
}

/**
 * Renames `oldKey` to `newKey` in the document's frontmatter IN PLACE, leaving
 * the key's position among its siblings, its value and any comments untouched.
 * Unlike a remove + re-add (which would move the key to the end) this mutates
 * the existing `Pair`'s key node: a scalar key keeps its node — and therefore
 * its position and key comment — by reassigning `.value`; a non-scalar key is
 * swapped for a fresh `Scalar`. Comparison is by the keys' string form so scalar
 * key nodes match correctly.
 *
 * Returns `text` unchanged when there is nothing safe to do: an empty or
 * unchanged `newKey`, no (or unparseable) frontmatter, a missing `oldKey`, or a
 * `newKey` that already exists as a DIFFERENT key (a collision is aborted rather
 * than producing a duplicate). Never throws.
 */
export function renameFrontmatterProperty(text: string, oldKey: string, newKey: string): string {
  if (newKey === '' || newKey === oldKey) return text;

  const region = detectFrontmatter(text);
  if (!region.present) return text;

  let doc;
  try {
    doc = parseDocument(region.yamlText);
  } catch {
    return text;
  }
  // `parseDocument` collects syntax errors on `doc.errors` rather than throwing;
  // a later `doc.toString()` on such a document WOULD throw, so bail here to keep
  // the never-throws contract and leave malformed YAML untouched.
  if (doc.errors.length > 0) return text;

  const root = doc.contents;
  if (!isMap(root)) return text;

  let target: (typeof root.items)[number] | undefined;
  for (const pair of root.items) {
    const name = keyString(pair.key);
    // A pre-existing `newKey` on a different pair is a collision: abort.
    if (name === newKey) return text;
    if (name === oldKey) target = pair;
  }
  if (target === undefined) return text;

  // Rename in place. A scalar key node keeps its position and any attached key
  // comment when we just reassign its value; otherwise swap in a fresh Scalar.
  // `parseDocument` types the pair's key as a parsed node (one with a defined
  // `range` and resolve method); a freshly built Scalar has neither, so the
  // non-scalar replacement is cast through `unknown` — the serializer only reads
  // the key's `.value`, so the parsed-only members are irrelevant. (A non-scalar
  // key is exotic; the typed-control widget never produces one.)
  if (isScalar(target.key)) {
    target.key.value = newKey;
  } else {
    target.key = new Scalar(newKey) as unknown as typeof target.key;
  }

  return `---\n${doc.toString()}---\n` + text.slice(region.regionEnd);
}

// ---------------------------------------------------------------------------
// Path-based round-trip mutation
// ---------------------------------------------------------------------------

/**
 * Shared reconstruction for the path-based helpers. Detects the frontmatter
 * block, parses it, hands the live `Document` to `mutate`, then re-serializes
 * the block ahead of the untouched body. Centralizes the never-throws
 * discipline so the public helpers stay free of copy-pasted guards:
 *
 *  - no (or unparseable) frontmatter → returns `text` unchanged;
 *  - `doc.errors.length > 0` (syntax errors collected, not thrown) → returns
 *    `text`, since a later `doc.toString()` WOULD throw ("Document with errors
 *    cannot be stringified");
 *  - `mutate` may return `false` to signal a no-op (e.g. a precondition failed),
 *    in which case `text` is returned unchanged WITHOUT re-serializing;
 *  - `mutate` may return a string to short-circuit and return that body
 *    directly (used to drop an emptied block);
 *  - any throw from `mutate` or the final `doc.toString()` → returns `text`.
 */
function reconstructIn(
  text: string,
  mutate: (doc: Document, region: FrontmatterRegion) => boolean | string,
): string {
  const region = detectFrontmatter(text);
  if (!region.present) return text;

  let doc: Document;
  try {
    doc = parseDocument(region.yamlText);
  } catch {
    return text;
  }
  if (doc.errors.length > 0) return text;

  try {
    const outcome = mutate(doc, region);
    if (outcome === false) return text;
    if (typeof outcome === 'string') return outcome;
    return `---\n${doc.toString()}---\n` + text.slice(region.regionEnd);
  } catch {
    // A `doc.toString()` re-serialize (or any internal throw) failed: leave the
    // block untouched to honour the never-throws contract.
    return text;
  }
}

/**
 * Sets the value at `path` within the document's frontmatter via `doc.setIn`,
 * preserving comments, blank lines and key order elsewhere. A path is a
 * `(string | number)[]`: string segments index map keys, number segments index
 * list items (e.g. `['author', 'name']` or `['tags', 1]`).
 *
 * Behaviour for missing intermediate containers: only the ROOT is required to
 * exist (it always does for a present block — a non-map root is coerced by
 * `setIn` as needed). `yaml.setIn` happily creates any missing intermediate
 * maps/seqs along the path, and we deliberately allow that — it keeps the helper
 * simple and predictable (the value always lands at `path`). No-op (returns
 * `text` unchanged) when `path.length === 0`. When no (or unparseable)
 * frontmatter exists the text is returned unchanged. Never throws.
 */
export function setFrontmatterPropertyIn(
  text: string,
  path: (string | number)[],
  value: unknown,
): string {
  if (path.length === 0) return text;
  return reconstructIn(text, (doc) => {
    doc.setIn(path, value);
    return true;
  });
}

/**
 * Removes the node at `path` from the document's frontmatter via
 * `doc.deleteIn`. A number segment removes a list item by index; a string
 * segment removes a map key. After deletion, if the ROOT map is now empty the
 * whole frontmatter block is dropped and only the body is returned (mirroring
 * {@link removeFrontmatterProperty}'s last-key behaviour). Intermediate
 * maps/seqs that become empty are NOT cleaned up — that is intentionally out of
 * scope. No-op (returns `text`) when `path.length === 0`. When no (or
 * unparseable) frontmatter exists the text is returned unchanged. Never throws.
 */
export function removeFrontmatterPropertyIn(text: string, path: (string | number)[]): string {
  if (path.length === 0) return text;
  return reconstructIn(text, (doc, region) => {
    doc.deleteIn(path);
    const remaining = asRecord(doc.toJSON());
    if (Object.keys(remaining).length === 0) {
      // Mirror removeFrontmatterProperty: drop the block, return just the body.
      return text.slice(region.regionEnd);
    }
    return true;
  });
}

/**
 * Appends `value` to the list at `path` within the document's frontmatter:
 *
 *  - node at `path` is a sequence → `doc.addIn(path, value)` (append last);
 *  - node at `path` is absent → create it as a one-element sequence
 *    (`doc.setIn(path, [value])`);
 *  - node at `path` exists but is NOT a sequence → no-op (returns `text`).
 *
 * No-op (returns `text`) when `path.length === 0`. When no (or unparseable)
 * frontmatter exists the text is returned unchanged. Never throws.
 */
export function addFrontmatterListItem(
  text: string,
  path: (string | number)[],
  value: unknown,
): string {
  if (path.length === 0) return text;
  return reconstructIn(text, (doc) => {
    const node = doc.getIn(path, true);
    if (node === undefined) {
      doc.setIn(path, [value]);
      return true;
    }
    if (isSeq(node)) {
      doc.addIn(path, value);
      return true;
    }
    // Exists but isn't a list: refuse to coerce it.
    return false;
  });
}

/**
 * Renames `oldKey` to `newKey` IN PLACE within the map at `parentPath`, leaving
 * the key's position among its siblings, its value and any comments untouched.
 * `parentPath === []` targets the ROOT map, making it equivalent to
 * {@link renameFrontmatterProperty}. Like that helper, a scalar key keeps its
 * node (and therefore its position and key comment) by reassigning `.value`; a
 * non-scalar key is swapped for a fresh `Scalar`.
 *
 * Returns `text` unchanged (no-op) when there is nothing safe to do: an empty or
 * unchanged `newKey`, the node at `parentPath` is not a map, `oldKey` is absent,
 * or `newKey` collides with a DIFFERENT existing key in that map. When no (or
 * unparseable) frontmatter exists the text is returned unchanged. Never throws.
 */
export function renameFrontmatterPropertyIn(
  text: string,
  parentPath: (string | number)[],
  oldKey: string,
  newKey: string,
): string {
  if (newKey === '' || newKey === oldKey) return text;
  return reconstructIn(text, (doc) => {
    const parent = parentPath.length === 0 ? doc.contents : doc.getIn(parentPath, true);
    if (!isMap(parent)) return false;

    let target: (typeof parent.items)[number] | undefined;
    for (const pair of parent.items) {
      const name = keyString(pair.key);
      // A pre-existing `newKey` on a different pair is a collision: abort.
      if (name === newKey) return false;
      if (name === oldKey) target = pair;
    }
    if (target === undefined) return false;

    // Rename in place. A scalar key node keeps its position and any attached key
    // comment when we just reassign its value; otherwise swap in a fresh Scalar.
    // (See renameFrontmatterProperty for the cast rationale.)
    if (isScalar(target.key)) {
      target.key.value = newKey;
    } else {
      target.key = new Scalar(newKey) as unknown as typeof target.key;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

/** A single flattened frontmatter property suitable for tabular display. */
export interface FlatProperty {
  key: string;
  value: string;
  /** Array element index (`0` for scalars and single values). */
  idx: number;
}

/**
 * Renders a YAML scalar value as a display string. `null`/`undefined` become
 * the empty string, `Date`s become an ISO date (`YYYY-MM-DD`), plain objects
 * become compact JSON, and everything else is `String`-coerced. Used for leaf
 * scalars; {@link flattenProperties} recurses into objects/arrays before
 * reaching this, so the JSON fallback only fires for unexpected non-plain
 * objects.
 */
function toStringValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Whether `value` is a leaf for flattening purposes: a scalar
 * (string/number/boolean), `null`/`undefined`, or a `Date` (handled specially
 * by {@link toStringValue}). Plain objects and arrays are containers that get
 * recursed into instead.
 */
function isLeafValue(value: unknown): boolean {
  return value === null || typeof value !== 'object' || value instanceof Date;
}

/**
 * Recursively flattens `value` (reached under dotted `key`) into `out`,
 * appending one {@link FlatProperty} row per leaf scalar. See
 * {@link flattenProperties} for the row semantics.
 */
function flattenValue(out: FlatProperty[], key: string, value: unknown, idx: number): void {
  if (isLeafValue(value)) {
    out.push({ key, value: toStringValue(value), idx });
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((element, elementIdx) => {
      if (isLeafValue(element)) {
        // Scalar array element: keep the per-item row so list values (e.g. tags)
        // stay individually queryable, with `idx` = the element index.
        out.push({ key, value: toStringValue(element), idx: elementIdx });
        return;
      }
      // Non-scalar element (object/array): recurse with a dotted+indexed key
      // (`key.0.subkey`) so nested list entries remain addressable.
      flattenValue(out, `${key}.${elementIdx}`, element, 0);
    });
    return;
  }

  // Plain nested object (map): recurse, prefixing child keys with dotted
  // notation (`parent.child`), to arbitrary depth.
  const nested = value as Record<string, unknown>;
  for (const childKey of Object.keys(nested)) {
    flattenValue(out, `${key}.${childKey}`, nested[childKey], 0);
  }
}

/**
 * Flattens a frontmatter mapping into {@link FlatProperty} rows, recursing into
 * nested data so it is fully queryable:
 *
 *  - scalars (string/number/boolean, `null`/`undefined`, `Date`) → one row
 *    (`idx: 0`; `null`/`undefined` render as the empty string);
 *  - nested objects (maps) → recursed with dotted child keys (`author.name`), to
 *    arbitrary depth;
 *  - arrays → one row per element: a scalar element keeps the per-item row with
 *    `idx` = the element index (so tags etc. stay individually queryable), while
 *    a non-scalar element is recursed under a dotted+indexed key (`key.0.subkey`,
 *    `idx: 0`).
 *
 * The `{ key, value, idx }` shape is unchanged — the indexer maps it directly.
 */
export function flattenProperties(data: Record<string, unknown>): FlatProperty[] {
  const out: FlatProperty[] = [];
  for (const key of Object.keys(data)) {
    flattenValue(out, key, data[key], 0);
  }
  return out;
}
