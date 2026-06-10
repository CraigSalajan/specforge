import { ipcMain, app, shell } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { getSetting } from '../db/repositories/settings.repo';
import {
  RESOURCE_EXTS,
  SKILL_FILE,
  parseFrontmatter,
  scanSkillsRoot,
  type SkillScannerHost,
} from './skill-scanner';
import { getActiveVaultRoot } from './watcher';

const Channels = {
  List: 'specforge:skills-list',
  ReadBody: 'specforge:skills-read-body',
  ReadResource: 'specforge:skills-read-resource',
  OpenFolder: 'specforge:skills-open-folder',
} as const;

type SkillOrigin = 'global' | 'local' | 'user';
type SkillScope = 'global' | 'local';

interface SkillMeta {
  name: string;
  description: string;
  origin: SkillOrigin;
  dir: string;
  resources: string[];
}

// ---------------------------------------------------------------------------
// Path sandboxing (generalized from vault.ts)
// ---------------------------------------------------------------------------

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

/**
 * Confines `target` to `root`, rejecting `..` escapes, absolute escapes, NUL
 * bytes, NTFS alternate data streams, and reserved Windows device names.
 * Mirrors vault.ts `assertWithinVault` but is parameterized on an arbitrary
 * root so it can guard either skills directory.
 */
function assertWithinDir(target: string, root: string): string {
  if (typeof target !== 'string' || target.length === 0) {
    throw new Error('Invalid path');
  }
  if (target.includes('\0')) {
    throw new Error('Path rejected (NUL byte)');
  }
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(root);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path escapes skill folder: ${target}`);
  }
  assertSafeSegments(rel);
  return resolvedTarget;
}

function assertResourceExt(p: string): void {
  const ext = path.extname(p).toLowerCase();
  if (!RESOURCE_EXTS.has(ext)) {
    throw new Error(`Unsupported skill resource type: ${path.basename(p)}`);
  }
}

// ---------------------------------------------------------------------------
// Directory resolvers
// ---------------------------------------------------------------------------

function globalSkillsRoot(): string {
  return path.join(app.getPath('userData'), 'skills');
}

function localSkillsRoot(vaultPath: string): string {
  return path.join(path.resolve(vaultPath), '.specforge', 'skills');
}

/**
 * User-configured skill directories from the `skills.directories` setting
 * (a JSON array of absolute paths persisted by the renderer). Read main-side
 * so the skills IPC signatures stay unchanged. Malformed or missing values
 * degrade to an empty list; entries are resolved and de-duplicated while
 * PRESERVING configured order (order defines collision precedence: later
 * directories win).
 */
function userSkillRoots(): string[] {
  let raw: string | null;
  try {
    raw = getSetting('skills.directories');
  } catch (err) {
    console.error('[skills] failed to read skills.directories setting', err);
    return [];
  }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const roots: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'string' || entry.trim().length === 0) continue;
      const resolved = path.resolve(entry.trim());
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      roots.push(resolved);
    }
    return roots;
  } catch {
    return [];
  }
}

/**
 * Resolves the active vault path: the explicit argument wins, otherwise fall
 * back to the watcher's active root. Returns null when neither is available.
 */
function resolveVaultPath(vaultPath?: string): string | null {
  if (typeof vaultPath === 'string' && vaultPath.length > 0) {
    return path.resolve(vaultPath);
  }
  return getActiveVaultRoot();
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Returns true if `dir` exists and is a directory. A missing or unreadable
 * root is a normal condition (skills are optional, user-configured directories
 * may be removed or on detached drives), so errors yield false (logged for
 * non-ENOENT) rather than failing the whole list.
 */
async function isDirectory(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[skills] skipping unreadable skills root ${dir}`, err);
    }
    return false;
  }
}

/** Production filesystem host for the pure scanner (Node fs + native paths). */
const scannerHost: SkillScannerHost = {
  readdir: async (dir) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
    }));
  },
  readFile: (filePath) => fs.readFile(filePath, 'utf-8'),
  join: (...segments) => path.join(...segments),
};

/**
 * Scans `root` (recursively, see skill-scanner.ts for the discovery rules) for
 * folders that contain a valid SKILL.md and returns their metadata stamped
 * with `origin`. Invalid folders are skipped, per-subtree read failures are
 * logged and tolerated, and a missing root yields an empty list.
 */
async function scanRoot(root: string, origin: SkillOrigin): Promise<SkillMeta[]> {
  if (!(await isDirectory(root))) return [];
  const scanned = await scanSkillsRoot(scannerHost, root, {
    onError: (p, err) => console.error(`[skills] failed to scan ${p}`, err),
  });
  return scanned.map((s) => ({ ...s, origin }));
}

/**
 * Resolves a single skill folder by origin + name, returning the absolute
 * directory or null when no valid skill with that name exists in the origin.
 * Resolution reuses the same scan/validation as `skills-list` so the contract
 * stays consistent. For the `user` origin all configured directories are
 * scanned with the same later-directory-wins precedence as the list merge.
 */
async function resolveSkillDir(
  origin: SkillOrigin,
  name: string,
  vaultPath?: string,
): Promise<string | null> {
  if (origin === 'user') {
    let match: string | null = null;
    for (const root of userSkillRoots()) {
      const skills = await scanRoot(root, 'user');
      const found = skills.find((s) => s.name === name);
      if (found) match = found.dir;
    }
    return match;
  }
  let root: string;
  if (origin === 'local') {
    const vault = resolveVaultPath(vaultPath);
    if (!vault) return null;
    root = localSkillsRoot(vault);
  } else {
    root = globalSkillsRoot();
  }
  const skills = await scanRoot(root, origin);
  const match = skills.find((s) => s.name === name);
  return match ? match.dir : null;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function registerSkillsHandlers(): void {
  ipcMain.handle(Channels.List, async (_e, vaultPath?: string): Promise<SkillMeta[]> => {
    const global = await scanRoot(globalSkillsRoot(), 'global');

    const user: SkillMeta[] = [];
    for (const root of userSkillRoots()) {
      user.push(...(await scanRoot(root, 'user')));
    }

    const vault = resolveVaultPath(vaultPath);
    const local = vault ? await scanRoot(localSkillsRoot(vault), 'local') : [];

    // Precedence on name clash: local (vault) > user directories (a later
    // configured directory wins over an earlier one) > global. Implemented by
    // insertion order: later `set` calls replace matching names while
    // appending new ones.
    const byName = new Map<string, SkillMeta>();
    for (const meta of global) byName.set(meta.name, meta);
    for (const meta of user) byName.set(meta.name, meta);
    for (const meta of local) byName.set(meta.name, meta);
    return [...byName.values()];
  });

  ipcMain.handle(
    Channels.ReadBody,
    async (_e, origin: SkillOrigin, name: string, vaultPath?: string): Promise<string> => {
      const skillDir = await resolveSkillDir(origin, name, vaultPath);
      if (!skillDir) {
        throw new Error(`Skill not found (${origin}): ${name}`);
      }
      const raw = await fs.readFile(path.join(skillDir, SKILL_FILE), 'utf-8');
      return parseFrontmatter(raw).body;
    },
  );

  ipcMain.handle(
    Channels.ReadResource,
    async (
      _e,
      origin: SkillOrigin,
      name: string,
      resourceRelPath: string,
      vaultPath?: string,
    ): Promise<string> => {
      const skillDir = await resolveSkillDir(origin, name, vaultPath);
      if (!skillDir) {
        throw new Error(`Skill not found (${origin}): ${name}`);
      }
      if (typeof resourceRelPath !== 'string' || resourceRelPath.length === 0) {
        throw new Error('Invalid resource path');
      }
      const safe = assertWithinDir(path.join(skillDir, resourceRelPath), skillDir);
      assertResourceExt(safe);
      return fs.readFile(safe, 'utf-8');
    },
  );

  ipcMain.handle(
    Channels.OpenFolder,
    async (_e, scope: SkillScope, vaultPath?: string): Promise<void> => {
      let root: string;
      if (scope === 'local') {
        const vault = resolveVaultPath(vaultPath);
        if (!vault) {
          throw new Error('No active vault. Local skills require an open vault.');
        }
        root = localSkillsRoot(vault);
      } else {
        root = globalSkillsRoot();
      }
      await fs.mkdir(root, { recursive: true });
      await shell.openPath(root);
    },
  );
}
