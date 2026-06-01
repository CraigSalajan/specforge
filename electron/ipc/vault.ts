import { ipcMain } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { getActiveVaultRoot } from './watcher';

const Channels = {
  ListFiles: 'specforge:list-files',
  ReadFile: 'specforge:read-file',
  WriteFile: 'specforge:write-file',
  CreateFile: 'specforge:create-file',
  CreateFolder: 'specforge:create-folder',
  RenameFile: 'specforge:rename-file',
  DeleteFile: 'specforge:delete-file',
  DeleteFolder: 'specforge:delete-folder',
} as const;

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.specforge', '.obsidian', '.vscode', 'dist', 'out']);

function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith('.md');
}

async function listDirRecursive(dir: string): Promise<FileNode[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const nodes: FileNode[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') && IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const children = await listDirRecursive(full);
      nodes.push({ name: entry.name, path: full, isDirectory: true, children });
    } else if (entry.isFile() && isMarkdown(entry.name)) {
      nodes.push({ name: entry.name, path: full, isDirectory: false });
    }
  }
  nodes.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function assertSafeSegments(target: string): void {
  for (const seg of target.split(/[\\/]/)) {
    if (!seg || seg === '.' || seg === '..') continue;
    if (seg.includes(':')) {
      throw new Error(`Path rejected (NTFS alternate data stream): ${seg}`);
    }
    if (WINDOWS_RESERVED.test(seg)) {
      throw new Error(`Path rejected (reserved Windows device name): ${seg}`);
    }
  }
}

function assertWithinVault(target: string, vaultRoot: string): string {
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(vaultRoot);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes vault root: ${target}`);
  }
  assertSafeSegments(rel);
  return resolvedTarget;
}

function requireVaultRoot(): string {
  const root = getActiveVaultRoot();
  if (!root) {
    throw new Error('No active vault. Call watchVault first or pick a vault.');
  }
  return root;
}

function safePath(target: string, vaultRootHint?: string): string {
  if (typeof target !== 'string' || target.length === 0) {
    throw new Error('Invalid path');
  }
  if (target.includes('\0')) {
    throw new Error('Path rejected (NUL byte)');
  }
  const root = vaultRootHint ?? requireVaultRoot();
  return assertWithinVault(target, root);
}

function assertMarkdown(p: string): void {
  if (!isMarkdown(path.basename(p))) {
    throw new Error('Only .md files are supported in Phase 1');
  }
}

/**
 * Throws `${label} already exists` if `target` is present on disk.
 * Any error other than ENOENT (e.g. EACCES, ENOTDIR) is re-thrown so real
 * filesystem failures are never swallowed.
 */
async function assertDoesNotExist(target: string, label: string): Promise<void> {
  try {
    await fs.access(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  throw new Error(`${label} already exists`);
}

/**
 * True when both paths resolve to the same underlying file (same device +
 * inode). Used to detect case-only renames on case-insensitive filesystems
 * (Windows/macOS), where `safeNew !== safeOld` as strings yet they refer to
 * the same file. Returns false if either path is missing.
 */
async function isSameFile(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

export function registerVaultHandlers(): void {
  ipcMain.handle(Channels.ListFiles, async (_e, vaultPath: string): Promise<FileNode[]> => {
    if (typeof vaultPath !== 'string' || vaultPath.length === 0) {
      throw new Error('Invalid vault path');
    }
    const resolved = path.resolve(vaultPath);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) throw new Error('Vault path is not a directory');
    return listDirRecursive(resolved);
  });

  ipcMain.handle(Channels.ReadFile, async (_e, filePath: string): Promise<string> => {
    const safe = safePath(filePath);
    assertMarkdown(safe);
    return fs.readFile(safe, 'utf-8');
  });

  ipcMain.handle(Channels.WriteFile, async (_e, filePath: string, content: string): Promise<void> => {
    if (typeof content !== 'string') throw new Error('Invalid content');
    const safe = safePath(filePath);
    assertMarkdown(safe);
    await fs.mkdir(path.dirname(safe), { recursive: true });
    await fs.writeFile(safe, content, 'utf-8');
  });

  ipcMain.handle(Channels.CreateFile, async (_e, filePath: string): Promise<void> => {
    const safe = safePath(filePath);
    assertMarkdown(safe);
    await fs.mkdir(path.dirname(safe), { recursive: true });
    await assertDoesNotExist(safe, 'File');
    await fs.writeFile(safe, '', 'utf-8');
  });

  ipcMain.handle(Channels.CreateFolder, async (_e, folderPath: string): Promise<void> => {
    const safe = safePath(folderPath);
    await assertDoesNotExist(safe, 'Folder');
    await fs.mkdir(safe, { recursive: true });
  });

  ipcMain.handle(Channels.RenameFile, async (_e, oldPath: string, newPath: string): Promise<void> => {
    const safeOld = safePath(oldPath);
    const safeNew = safePath(newPath);
    assertMarkdown(safeOld);
    assertMarkdown(safeNew);
    await fs.mkdir(path.dirname(safeNew), { recursive: true });
    // Only guard against clobbering when the destination is a genuinely
    // different file. A case-only rename (e.g. `Foo.md` -> `foo.md`) resolves
    // to a different string but the same file on case-insensitive filesystems,
    // so skip the guard in that case to avoid breaking legitimate renames.
    if (safeNew !== safeOld && !(await isSameFile(safeOld, safeNew))) {
      await assertDoesNotExist(safeNew, 'File');
    }
    await fs.rename(safeOld, safeNew);
  });

  ipcMain.handle(Channels.DeleteFile, async (_e, filePath: string): Promise<void> => {
    const safe = safePath(filePath);
    assertMarkdown(safe);
    await fs.unlink(safe);
  });

  ipcMain.handle(Channels.DeleteFolder, async (_e, folderPath: string): Promise<void> => {
    const safe = safePath(folderPath);
    // Never allow deleting the vault root itself.
    if (path.resolve(safe) === path.resolve(requireVaultRoot())) {
      throw new Error('Refusing to delete the vault root');
    }
    await fs.rm(safe, { recursive: true, force: false });
  });
}
