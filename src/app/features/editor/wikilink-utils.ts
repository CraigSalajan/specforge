/**
 * Pure wikilink helpers for the editor: target parsing, heading lookup,
 * synchronous renderer-side resolvability checks, and `[[` completion
 * corpus building. Everything here is view-free and IPC-free so it can be
 * unit-tested directly (wikilink-utils.spec.ts).
 *
 * Resolution parity: authoritative resolution (click-to-navigate) goes
 * through the main process (`IpcService.linksResolve`, Obsidian-style
 * basename matching in electron/indexing/link-resolver.ts). The synchronous
 * check here exists for STYLING — marking unresolved links at decoration
 * build time — and mirrors the main resolver's matching rules exactly:
 * a target resolves iff it is a segment-aligned suffix (sans `.md`,
 * case-insensitive) of some vault rel path. It is built from VaultService's
 * file tree, which the watcher keeps fresh, so it cannot go stale the way a
 * `linksOutgoing` snapshot of the last indexed state can.
 */

import type { FileNode } from '../../shared/types';

/** A wikilink inner text split into its document target and heading part. */
export interface WikiTargetParts {
  /** Document target before any `#`, trimmed. `''` for same-file anchors. */
  target: string;
  /** Heading fragment after the first `#`, trimmed; null when absent/empty. */
  fragment: string | null;
}

/**
 * Splits raw wikilink inner text (`Target`, `Target#Heading`,
 * `Target#Heading|alias`) into target + fragment. The alias is dropped; the
 * fragment is kept so navigation can jump to the heading after resolving.
 */
export function splitWikiTarget(raw: string): WikiTargetParts {
  const inner = raw.split('|')[0];
  const hash = inner.indexOf('#');
  if (hash === -1) return { target: inner.trim(), fragment: null };
  const fragment = inner.slice(hash + 1).trim();
  return { target: inner.slice(0, hash).trim(), fragment: fragment === '' ? null : fragment };
}

/**
 * Finds the 1-based line of the first ATX heading whose text matches
 * `heading` case-insensitively. Trailing closing hashes (`## Title ##`) are
 * stripped before comparing, and heading-looking lines inside fenced code
 * blocks are skipped. Returns null when no heading matches.
 */
export function findAtxHeadingLine(content: string, heading: string): number | null {
  const wanted = heading.trim().toLowerCase();
  if (wanted === '') return null;
  const lines = content.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Minimal fence tracking: a line opening/closing a ``` or ~~~ fence.
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*$/.exec(line);
    if (!m) continue;
    const text = m[1].replace(/[ \t]+#+$/, '');
    if (text.trim().toLowerCase() === wanted) return i + 1;
  }
  return null;
}

/**
 * Builds the set of segment-aligned stems a wikilink target can resolve to.
 * For `specs/auth/Login.md` the stems are `specs/auth/login`, `auth/login`
 * and `login` — exactly the suffixes the main-process resolver matches — so
 * `isTargetResolvable` is a single Set lookup.
 */
export function buildResolvableStems(relPaths: readonly string[]): Set<string> {
  const stems = new Set<string>();
  for (const relPath of relPaths) {
    let stem = relPath.replace(/\\/g, '/').toLowerCase();
    if (stem.endsWith('.md')) stem = stem.slice(0, -3);
    const segments = stem.split('/').filter((s) => s.length > 0);
    for (let i = 0; i < segments.length; i++) {
      stems.add(segments.slice(i).join('/'));
    }
  }
  return stems;
}

/**
 * Synchronous mirror of the main-process resolver's MATCHING rule (existence
 * only — the main process additionally picks the shortest path among
 * multiple matches, which styling does not need). Target normalization is
 * identical: slashes, trim, strip leading/trailing `/` and a trailing `.md`,
 * lowercase.
 */
export function isTargetResolvable(target: string, stems: ReadonlySet<string>): boolean {
  let t = target.replace(/\\/g, '/').trim();
  t = t.replace(/^\/+/, '').replace(/\/+$/, '');
  if (t.toLowerCase().endsWith('.md')) t = t.slice(0, -3);
  t = t.toLowerCase();
  if (t.length === 0) return false;
  return stems.has(t);
}

/** A markdown file flattened out of the vault tree. */
export interface VaultMarkdownFile {
  /** File name including the `.md` extension. */
  name: string;
  /** Vault-relative forward-slash path. */
  relPath: string;
  /** Absolute path as reported by the tree. */
  absPath: string;
}

/**
 * Depth-first flatten of the vault tree into markdown file entries with
 * vault-relative forward-slash paths. This is the corpus for both the
 * resolvability stems and the `[[` completion list.
 */
export function collectMarkdownFiles(
  nodes: readonly FileNode[],
  vaultPath: string,
): VaultMarkdownFile[] {
  const out: VaultMarkdownFile[] = [];
  collectInto(nodes, vaultPath, out);
  return out;
}

function collectInto(nodes: readonly FileNode[], vaultPath: string, out: VaultMarkdownFile[]): void {
  for (const node of nodes) {
    if (node.isDirectory) {
      if (node.children) collectInto(node.children, vaultPath, out);
    } else if (node.name.toLowerCase().endsWith('.md')) {
      out.push({ name: node.name, relPath: toRelPath(node.path, vaultPath), absPath: node.path });
    }
  }
}

/**
 * Vault-relative forward-slash path for an absolute tree path. Prefix
 * comparison is case-insensitive (Windows paths arrive with varying casing);
 * the remainder keeps its original casing.
 */
export function toRelPath(absPath: string, vaultPath: string): string {
  const abs = absPath.replace(/\\/g, '/');
  const vault = vaultPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (abs.toLowerCase().startsWith(vault.toLowerCase() + '/')) {
    return abs.slice(vault.length + 1);
  }
  return abs;
}

/** One `[[` completion option. */
export interface WikiCompletionEntry {
  /** Basename without `.md` — what the popup shows. */
  label: string;
  /** Vault-relative path — dimmed detail in the popup. */
  detail: string;
  /**
   * Text inserted into the link. Normally the basename; when several files
   * share a basename (case-insensitive), the relPath-without-extension form
   * so the inserted link resolves unambiguously.
   */
  insert: string;
}

/**
 * Builds the completion corpus from the vault's markdown files. Entries are
 * sorted by label (case-insensitive, relPath tiebreak) for a stable popup order.
 */
export function buildWikiCompletionEntries(
  files: readonly VaultMarkdownFile[],
): WikiCompletionEntry[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const key = stripMdExtension(file.name).toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return files
    .map((file) => {
      const label = stripMdExtension(file.name);
      const duplicate = (counts.get(label.toLowerCase()) ?? 0) > 1;
      return {
        label,
        detail: file.relPath,
        insert: duplicate ? stripMdExtension(file.relPath) : label,
      };
    })
    .sort((a, b) =>
      a.label.toLowerCase().localeCompare(b.label.toLowerCase()) ||
      a.detail.localeCompare(b.detail)
    );
}

function stripMdExtension(name: string): string {
  return name.toLowerCase().endsWith('.md') ? name.slice(0, -3) : name;
}

/**
 * Joins a vault-relative (forward-slash) child onto an absolute parent path,
 * matching the separator style the parent already uses (same convention as
 * VaultFileOpsService's joinPath).
 */
export function joinVaultPath(parent: string, rel: string): string {
  const sep = parent.includes('\\') ? '\\' : '/';
  const trimmedParent = parent.replace(/[\\/]+$/, '');
  return `${trimmedParent}${sep}${rel.replace(/\//g, sep)}`;
}

/** Directory portion of an absolute path (up to the last separator). */
export function parentDir(absPath: string): string {
  const idx = Math.max(absPath.lastIndexOf('/'), absPath.lastIndexOf('\\'));
  return idx > 0 ? absPath.slice(0, idx) : absPath;
}
