/**
 * Pure path helpers used by the proposal pipeline. Kept renderer-side so the
 * proposal modal can validate before any IPC round-trip.
 */

export const FORBIDDEN_FILENAME_CHARS = /[:"<>|*?]/g;

/**
 * Filesystem-safe filename on Windows + macOS + Linux. Phase 3 policy:
 *  - strip Windows-illegal characters ` : " < > | * ? `
 *  - replace consecutive whitespace with `-`
 *  - trim trailing spaces and dots (Windows trims these silently)
 *  - lowercase the extension and ensure `.md`
 */
export function sanitizeFilename(name: string): string {
  let out = name.trim().replace(FORBIDDEN_FILENAME_CHARS, '');
  out = out.replace(/\s+/g, '-');
  out = out.replace(/[\.\s]+$/g, '');
  if (out.length === 0) out = 'untitled';
  if (!out.toLowerCase().endsWith('.md')) {
    out = out.replace(/\.[a-z0-9]+$/i, '');
    out = out + '.md';
  } else {
    out = out.slice(0, -3) + '.md';
  }
  return out;
}

/**
 * Joins a vault-relative folder + filename into a single rel-path normalized
 * with forward slashes.
 */
export function joinRel(folder: string, filename: string): string {
  const f = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const cleanFile = sanitizeFilename(filename);
  return f.length === 0 ? cleanFile : `${f}/${cleanFile}`;
}

/**
 * True if relPath stays inside the vault root: no `..` segments, not
 * absolute, no Windows drive letters. The main process re-validates before
 * any write, but checking here surfaces errors in the modal immediately.
 */
export function isSafeRelPath(relPath: string): boolean {
  if (typeof relPath !== 'string' || relPath.length === 0) return false;
  // Reject ANY Windows drive prefix — including the drive-relative `C:foo` form
  // (no separator after the colon), which still escapes the vault when resolved.
  if (/^[a-zA-Z]:/.test(relPath)) return false;
  if (relPath.startsWith('/') || relPath.startsWith('\\')) return false;
  const normalized = relPath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '..' || seg === '.') return false;
  }
  return true;
}

export function relToAbs(vaultPath: string, relPath: string): string {
  const sep = vaultPath.includes('\\') && !vaultPath.includes('/') ? '\\' : '/';
  const cleanRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = cleanRel.split('/');
  const root = vaultPath.replace(/[\\/]$/, '');
  return [root, ...segments].join(sep);
}

/**
 * Canonicalizes a vault-relative path for use in `ContextScope` and SQL
 * filters. The DB stores `files.rel_path` with forward slashes and original
 * casing (see `electron/indexing/indexer.ts` -> `toRelPath`), so this helper
 * preserves casing deliberately — it must NOT lowercase.
 *
 *  - converts backslashes to forward slashes
 *  - strips leading/trailing slashes
 *  - collapses repeated slashes
 *  - rejects `..` (and bare `.`) segments by returning `null`
 *
 * Returns `null` for any input that cannot be safely canonicalized so callers
 * can drop it rather than silently widen the scope.
 */
export function canonicalRelPath(input: string): string | null {
  if (typeof input !== 'string') return null;
  const normalized = input.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (normalized.length === 0) return null;
  const segments = normalized.split('/').filter((s) => s.length > 0);
  for (const seg of segments) {
    if (seg === '..' || seg === '.') return null;
  }
  if (segments.length === 0) return null;
  return segments.join('/');
}

export function absToRel(vaultPath: string, absPath: string): string {
  const normVault = vaultPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const normAbs = absPath.replace(/\\/g, '/');
  if (!normAbs.toLowerCase().startsWith(normVault.toLowerCase())) {
    return normAbs;
  }
  return normAbs.slice(normVault.length).replace(/^\/+/, '');
}

/** Minimal shape of a vault tree node (mirrors `FileNode` from shared/types). */
interface TreeNode {
  path: string;
  isDirectory: boolean;
  children?: TreeNode[];
}

/**
 * Depth-first flattens a vault `FileNode[]` tree into vault-relative paths of
 * all non-directory files, relativizing each node's absolute `path` against
 * the vault root. Directory nodes contribute their children but not themselves.
 */
export function flattenTreeToRelPaths(vaultPath: string, nodes: readonly TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly TreeNode[]): void => {
    for (const node of list) {
      if (node.isDirectory) {
        if (node.children && node.children.length > 0) walk(node.children);
      } else {
        out.push(absToRel(vaultPath, node.path));
      }
    }
  };
  walk(nodes);
  return out;
}
