/**
 * Pure vault-relative path and tree helpers shared by core services and the
 * sidebar features. Complements `path-utils.ts` (absolute-path comparison):
 * these convert between absolute paths and the forward-slash vault-relative
 * form used by the link/search index and the persisted UI settings.
 */
import { normalizePath, samePath } from './path-utils';
import type { FileNode } from './types';

/**
 * Converts `absPath` to a vault-relative path (forward slashes, original
 * casing — matching the DB's `files.rel_path` scheme). Returns `null` when
 * `absPath` does not live under `vaultPath`, so callers can refuse to persist
 * or query paths that belong to a different vault.
 */
export function toVaultRel(vaultPath: string, absPath: string): string | null {
  const root = normalizePath(vaultPath);
  const probe = normalizePath(absPath);
  if (probe !== root && !probe.startsWith(root + '/')) return null;
  const normAbs = absPath.replace(/\\/g, '/');
  return normAbs.slice(root.length).replace(/^\/+/, '');
}

/**
 * Rebuilds an absolute path from a vault-relative one, using the vault's
 * native separator (same scheme as the search panel's citation handling).
 */
export function fromVaultRel(vaultPath: string, relPath: string): string {
  const sep = vaultPath.includes('\\') && !vaultPath.includes('/') ? '\\' : '/';
  const root = vaultPath.replace(/[\\/]+$/, '');
  const segments = relPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0);
  return [root, ...segments].join(sep);
}

/**
 * True when a non-directory node with `absPath` exists anywhere in the tree
 * (`samePath` semantics: case-insensitive, separator-normalized).
 */
export function treeContainsFile(nodes: readonly FileNode[], absPath: string): boolean {
  for (const node of nodes) {
    if (node.isDirectory) {
      if (node.children && treeContainsFile(node.children, absPath)) return true;
    } else if (samePath(node.path, absPath)) {
      return true;
    }
  }
  return false;
}

/** Absolute paths of every directory node in the tree, depth-first. */
export function collectFolderPaths(nodes: readonly FileNode[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly FileNode[]): void => {
    for (const node of list) {
      if (!node.isDirectory) continue;
      out.push(node.path);
      if (node.children) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}
