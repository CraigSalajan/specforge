/**
 * Absolute-path helpers shared across core services and features. (Vault-rel
 * path helpers used by the AI proposal pipeline live in
 * `features/ai/providers/path-utils.ts`.)
 */

/**
 * Case-insensitive, separator-normalized equality for absolute paths. Watcher
 * events, the vault tree and user navigation can each produce the same
 * Windows path with different casing and/or separators, so all absolute-path
 * comparisons must go through here rather than `===`.
 */
export function samePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
