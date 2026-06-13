/**
 * Pure Obsidian-style wikilink target resolution against a list of vault
 * rel paths (forward-slash, as stored in the `files` table).
 *
 * Rules:
 *  - A bare target (no `/`) resolves to any file whose basename without the
 *    `.md` extension matches case-insensitively.
 *  - A target containing `/` matches by rel_path suffix on a path-segment
 *    boundary (e.g. `folder/Target` matches `a/folder/Target.md`).
 *  - A trailing `.md` on the target is tolerated and stripped.
 *  - Multiple matches: the shortest rel_path wins (lexicographic tiebreak for
 *    determinism).
 *  - No match: null.
 */

/** Normalizes a wikilink target for matching: slashes, trim, strip `.md`. */
function normalizeTarget(target: string): string {
  let t = target.replace(/\\/g, '/').trim();
  t = t.replace(/^\/+/, '').replace(/\/+$/, '');
  if (t.toLowerCase().endsWith('.md')) t = t.slice(0, -3);
  return t.toLowerCase();
}

/** Lowercased rel path without the trailing `.md` extension. */
function relPathStem(relPath: string): string {
  const lower = relPath.toLowerCase();
  return lower.endsWith('.md') ? lower.slice(0, -3) : lower;
}

export function resolveLinkTarget(
  target: string,
  relPaths: readonly string[],
): string | null {
  const normalized = normalizeTarget(target);
  if (normalized.length === 0) return null;

  const bySuffix = normalized.includes('/');
  const matches: string[] = [];

  for (const relPath of relPaths) {
    const stem = relPathStem(relPath);
    if (bySuffix) {
      if (stem === normalized || stem.endsWith('/' + normalized)) {
        matches.push(relPath);
      }
    } else {
      const slash = stem.lastIndexOf('/');
      const basename = slash === -1 ? stem : stem.slice(slash + 1);
      if (basename === normalized) {
        matches.push(relPath);
      }
    }
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return matches[0];
}
