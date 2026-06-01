import { ipcMain, app, shell } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { getActiveVaultRoot } from './watcher';

const Channels = {
  List: 'specforge:skills-list',
  ReadBody: 'specforge:skills-read-body',
  ReadResource: 'specforge:skills-read-resource',
  OpenFolder: 'specforge:skills-open-folder',
} as const;

type SkillOrigin = 'global' | 'local';
type SkillScope = 'global' | 'local';

interface SkillMeta {
  name: string;
  description: string;
  origin: SkillOrigin;
  dir: string;
  resources: string[];
}

interface ParsedSkill {
  name: string;
  description: string;
  body: string;
}

const SKILL_FILE = 'SKILL.md';
const RESOURCE_EXTS = new Set(['.md', '.txt', '.json']);

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

/**
 * Strips one layer of surrounding single/double quotes from a YAML scalar and
 * trims surrounding whitespace.
 */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Minimal frontmatter parser. Reads a leading `---\n ... \n---\n` block and
 * extracts the `name:` and `description:` keys; everything after the closing
 * `---` becomes the body. Files with no frontmatter return empty name/description
 * and the whole file as the body. No YAML dependency is used.
 */
function parseFrontmatter(raw: string): ParsedSkill {
  // Normalize CRLF so the delimiter regex behaves identically on Windows.
  const text = raw.replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) {
    return { name: '', description: '', body: text };
  }
  const [, frontmatter, body] = match;
  let name = '';
  let description = '';
  for (const line of frontmatter.split('\n')) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1);
    if (key === 'name') name = unquote(value);
    else if (key === 'description') description = unquote(value);
  }
  return { name, description, body };
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
 * Returns true if `dir` exists and is a directory. A missing root is a normal
 * condition (skills are optional), so ENOENT yields false rather than throwing.
 */
async function isDirectory(dir: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dir);
    return stat.isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Recursively collects forward-slash relative paths of `.md`/`.txt`/`.json`
 * files inside `skillDir`, excluding the top-level SKILL.md. Paths are relative
 * to `skillDir`.
 */
async function collectResources(skillDir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!RESOURCE_EXTS.has(ext)) continue;
      const rel = path.relative(skillDir, full).split(path.sep).join('/');
      // Skip the skill's own instruction file; only bundled references count.
      if (rel.toLowerCase() === SKILL_FILE.toLowerCase()) continue;
      out.push(rel);
    }
  }
  await walk(skillDir);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

/**
 * Scans `root` for immediate subdirectories that contain a valid SKILL.md and
 * returns their metadata. Invalid or SKILL.md-less folders are skipped. A
 * missing root yields an empty list.
 */
async function scanRoot(root: string, origin: SkillOrigin): Promise<SkillMeta[]> {
  if (!(await isDirectory(root))) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const skills: SkillMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(root, entry.name);
    let raw: string;
    try {
      raw = await fs.readFile(path.join(skillDir, SKILL_FILE), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    const parsed = parseFrontmatter(raw);
    // A blank name makes the skill unaddressable; skip it.
    if (!parsed.name) continue;
    // A single unreadable folder (e.g. EACCES on a subdir) must not sink the
    // whole list: degrade that one skill to "no bundled resources" instead.
    let resources: string[] = [];
    try {
      resources = await collectResources(skillDir);
    } catch (err) {
      console.error(`[skills] failed to enumerate resources for ${skillDir}`, err);
    }
    skills.push({
      name: parsed.name,
      description: parsed.description,
      origin,
      dir: skillDir,
      resources,
    });
  }
  return skills;
}

/**
 * Resolves a single skill folder by origin + name, returning the absolute
 * directory or null when no valid skill with that name exists in the origin.
 * Resolution reuses the same scan/validation as `skills-list` so the contract
 * stays consistent (local override is irrelevant here because origin is fixed).
 */
async function resolveSkillDir(
  origin: SkillOrigin,
  name: string,
  vaultPath?: string,
): Promise<string | null> {
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

    const vault = resolveVaultPath(vaultPath);
    const local = vault ? await scanRoot(localSkillsRoot(vault), 'local') : [];

    // Local overrides global on name clash: index global by name, then let
    // local entries replace matching names while appending new ones.
    const byName = new Map<string, SkillMeta>();
    for (const meta of global) byName.set(meta.name, meta);
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
