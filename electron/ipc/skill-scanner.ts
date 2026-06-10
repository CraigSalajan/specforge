/**
 * Pure skill-discovery scanner shared by the main-process skills IPC handlers.
 * Deliberately free of any Electron / Node imports (filesystem access is
 * injected via {@link SkillScannerHost}) so it can be unit-tested under the
 * renderer's test runner as well as bundled into the main process. Mirrors the
 * testability pattern of `tool-call-accumulator.ts`.
 *
 * Discovery rules:
 *  - A "skill folder" is any directory containing a SKILL.md, found either as
 *    an immediate child of the root (`<root>/skill-name/SKILL.md`) or nested
 *    (`<root>/any/child/path/skill-name/SKILL.md`) up to {@link DEFAULT_MAX_DEPTH}
 *    levels below the root.
 *  - Once a directory contains SKILL.md, descent is PRUNED: its subdirectories
 *    are bundled resources, never further skills. This also applies to invalid
 *    skill folders (blank frontmatter name) so a broken SKILL.md never leaks
 *    its internals as skills.
 *  - Dot-prefixed folders and {@link IGNORED_SCAN_DIRS} are never entered
 *    (mirrors the vault file-tree IGNORED_DIRS pattern).
 *  - Name collisions within one root resolve to the SHALLOWEST skill, with
 *    ties broken by lexicographic path order (the scan is breadth-first with
 *    alphabetically sorted siblings). Cross-root precedence is the caller's
 *    concern.
 */

export const SKILL_FILE = 'SKILL.md';
export const RESOURCE_EXTS: ReadonlySet<string> = new Set(['.md', '.txt', '.json']);
export const DEFAULT_MAX_DEPTH = 5;

/**
 * Directory names never entered during discovery or resource collection.
 * Dot-prefixed folders (.git, .specforge, .obsidian, …) are excluded by the
 * dot rule in {@link isIgnoredDir}, so only non-dot names are listed here.
 */
export const IGNORED_SCAN_DIRS: ReadonlySet<string> = new Set(['node_modules', 'dist', 'out']);

/** Minimal dirent shape so hosts don't need Node's `fs.Dirent`. */
export interface ScannerEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

/**
 * Injected filesystem facade. The production host wraps `node:fs/promises` +
 * `node:path`; tests supply an in-memory tree.
 */
export interface SkillScannerHost {
  readdir(dir: string): Promise<ScannerEntry[]>;
  readFile(filePath: string): Promise<string>;
  join(...segments: string[]): string;
}

/** A discovered skill, origin-agnostic (the caller stamps the origin). */
export interface ScannedSkill {
  name: string;
  description: string;
  /** Absolute path of the skill folder (joined via the host's `join`). */
  dir: string;
  /** Forward-slash relative paths of bundled resource files, sorted. */
  resources: string[];
}

export interface ParsedSkill {
  name: string;
  description: string;
  body: string;
}

export interface ScanSkillsOptions {
  /** Max directory depth below the root at which a skill folder may sit. */
  maxDepth?: number;
  /** Invoked for unreadable directories/files; the scan continues regardless. */
  onError?: (path: string, err: unknown) => void;
}

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
export function parseFrontmatter(raw: string): ParsedSkill {
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
// Helpers
// ---------------------------------------------------------------------------

function isIgnoredDir(name: string): boolean {
  return name.startsWith('.') || IGNORED_SCAN_DIRS.has(name);
}

/** Pure stand-in for `path.extname(...).toLowerCase()` (dotfiles have no ext). */
function extnameLower(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return '';
  return name.slice(idx).toLowerCase();
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT'
  );
}

const noop = (): void => undefined;

// ---------------------------------------------------------------------------
// Resource collection
// ---------------------------------------------------------------------------

/**
 * Recursively collects forward-slash relative paths of `.md`/`.txt`/`.json`
 * files inside `skillDir`, excluding the top-level SKILL.md and ignored
 * directories. A single unreadable subtree is reported via `onError` and
 * skipped rather than sinking the whole skill.
 */
async function collectResources(
  host: SkillScannerHost,
  skillDir: string,
  onError: (path: string, err: unknown) => void,
): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string, relPrefix: string): Promise<void> {
    let entries: ScannerEntry[];
    try {
      entries = await host.readdir(dir);
    } catch (err) {
      onError(dir, err);
      return;
    }
    for (const entry of entries) {
      const rel = relPrefix.length > 0 ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (isIgnoredDir(entry.name)) continue;
        await walk(host.join(dir, entry.name), rel);
        continue;
      }
      if (!entry.isFile) continue;
      if (!RESOURCE_EXTS.has(extnameLower(entry.name))) continue;
      // Skip the skill's own instruction file; only bundled references count.
      if (rel.toLowerCase() === SKILL_FILE.toLowerCase()) continue;
      out.push(rel);
    }
  }

  await walk(skillDir, '');
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/**
 * Outcome of probing one directory for a SKILL.md:
 *  - a {@link ScannedSkill} when it holds a valid skill,
 *  - 'not-a-skill' when SKILL.md is absent (descend further),
 *  - 'invalid' when SKILL.md exists but is unusable (prune, don't descend).
 */
type ProbeResult = ScannedSkill | 'not-a-skill' | 'invalid';

async function probeSkillDir(
  host: SkillScannerHost,
  dir: string,
  onError: (path: string, err: unknown) => void,
): Promise<ProbeResult> {
  const skillFile = host.join(dir, SKILL_FILE);
  let raw: string;
  try {
    raw = await host.readFile(skillFile);
  } catch (err) {
    if (isNotFound(err)) return 'not-a-skill';
    onError(skillFile, err);
    return 'invalid';
  }
  const parsed = parseFrontmatter(raw);
  // A blank name makes the skill unaddressable; skip it (but still prune).
  if (!parsed.name) return 'invalid';
  return {
    name: parsed.name,
    description: parsed.description,
    dir,
    resources: await collectResources(host, dir, onError),
  };
}

/**
 * Breadth-first scan of `root` for skill folders (see module doc for the
 * discovery rules). A missing or unreadable root yields an empty list (the
 * error is reported through `onError`); per-subtree failures are likewise
 * reported and skipped so one bad folder never fails the whole scan.
 */
export async function scanSkillsRoot(
  host: SkillScannerHost,
  root: string,
  options: ScanSkillsOptions = {},
): Promise<ScannedSkill[]> {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const onError = options.onError ?? noop;

  const skills: ScannedSkill[] = [];
  const seenNames = new Set<string>();

  // `frontier` holds directories whose children sit at depth `depth`.
  let frontier: string[] = [root];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of frontier) {
      let entries: ScannerEntry[];
      try {
        entries = await host.readdir(dir);
      } catch (err) {
        onError(dir, err);
        continue;
      }
      const subdirs = entries
        .filter((e) => e.isDirectory && !isIgnoredDir(e.name))
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const sub of subdirs) {
        const subPath = host.join(dir, sub.name);
        const probed = await probeSkillDir(host, subPath, onError);
        if (probed === 'not-a-skill') {
          next.push(subPath);
          continue;
        }
        if (probed === 'invalid') continue; // pruned
        // Shallowest-first wins on name collision (BFS guarantees order).
        if (!seenNames.has(probed.name)) {
          seenNames.add(probed.name);
          skills.push(probed);
        }
      }
    }
    frontier = next;
  }
  return skills;
}
