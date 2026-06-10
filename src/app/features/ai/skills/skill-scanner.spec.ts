import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MAX_DEPTH,
  parseFrontmatter,
  scanSkillsRoot,
  type ScannerEntry,
  type SkillScannerHost,
} from '../../../../../electron/ipc/skill-scanner';

/**
 * Tests the pure, filesystem-agnostic skill scanner used by the main-process
 * skills IPC handlers. An in-memory directory tree stands in for the real
 * filesystem (mirroring the tool-call-accumulator testability pattern), so the
 * nesting / pruning / depth-cap / ignore rules are exercised without touching
 * disk.
 */

/** Nested object = directory; string = file content. */
interface FileTree {
  [name: string]: string | FileTree;
}

const ROOT = '/skills';

function fsError(code: string, p: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${p}`), { code });
}

function makeHost(tree: FileTree, failDirs: readonly string[] = []): SkillScannerHost {
  const failing = new Set(failDirs);

  function lookup(p: string): string | FileTree | undefined {
    if (p !== ROOT && !p.startsWith(`${ROOT}/`)) return undefined;
    let node: string | FileTree = tree;
    for (const seg of p.slice(ROOT.length).split('/').filter(Boolean)) {
      if (typeof node === 'string') return undefined;
      const next: string | FileTree | undefined = node[seg];
      if (next === undefined) return undefined;
      node = next;
    }
    return node;
  }

  return {
    async readdir(dir: string): Promise<ScannerEntry[]> {
      if (failing.has(dir)) throw fsError('EACCES', dir);
      const node = lookup(dir);
      if (node === undefined || typeof node === 'string') throw fsError('ENOENT', dir);
      return Object.entries(node).map(([name, value]) => ({
        name,
        isDirectory: typeof value !== 'string',
        isFile: typeof value === 'string',
      }));
    },
    async readFile(filePath: string): Promise<string> {
      const node = lookup(filePath);
      if (typeof node !== 'string') throw fsError('ENOENT', filePath);
      return node;
    },
    join: (...segments: string[]) => segments.join('/'),
  };
}

function skillMd(name: string, description = `${name} description`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}\n`;
}

describe('scanSkillsRoot', () => {
  it('discovers a skill folder that is an immediate child of the root', async () => {
    const host = makeHost({ 'my-skill': { 'SKILL.md': skillMd('my-skill') } });

    const skills = await scanSkillsRoot(host, ROOT);

    expect(skills).toEqual([
      {
        name: 'my-skill',
        description: 'my-skill description',
        dir: `${ROOT}/my-skill`,
        resources: [],
      },
    ]);
  });

  it('discovers nested skill folders under intermediate child paths', async () => {
    const host = makeHost({
      team: { nested: { 'my-skill': { 'SKILL.md': skillMd('my-skill') } } },
    });

    const skills = await scanSkillsRoot(host, ROOT);

    expect(skills.map((s) => s.dir)).toEqual([`${ROOT}/team/nested/my-skill`]);
  });

  it('prunes descent inside a skill folder: nested SKILL.md dirs become resources', async () => {
    const host = makeHost({
      outer: {
        'SKILL.md': skillMd('outer'),
        inner: { 'SKILL.md': skillMd('inner'), 'notes.md': 'notes' },
      },
    });

    const skills = await scanSkillsRoot(host, ROOT);

    expect(skills.map((s) => s.name)).toEqual(['outer']);
    // localeCompare collation is case-insensitive first, so notes < SKILL.
    expect(skills[0].resources).toEqual(['inner/notes.md', 'inner/SKILL.md']);
  });

  it('caps discovery at maxDepth levels below the root', async () => {
    const host = makeHost({
      a: { s1: { 'SKILL.md': skillMd('s1') } }, // depth 2
      b: { c: { s2: { 'SKILL.md': skillMd('s2') } } }, // depth 3
    });

    const skills = await scanSkillsRoot(host, ROOT, { maxDepth: 2 });

    expect(skills.map((s) => s.name)).toEqual(['s1']);
  });

  it('finds skills at the default depth cap but not below it', async () => {
    const host = makeHost({
      l1: { l2: { l3: { l4: { deep: { 'SKILL.md': skillMd('deep') } } } } }, // depth 5
      m1: { m2: { m3: { m4: { m5: { toodeep: { 'SKILL.md': skillMd('toodeep') } } } } } }, // depth 6
    });

    const skills = await scanSkillsRoot(host, ROOT);

    expect(DEFAULT_MAX_DEPTH).toBe(5);
    expect(skills.map((s) => s.name)).toEqual(['deep']);
  });

  it('never enters dot-folders or ignored directories', async () => {
    const host = makeHost({
      node_modules: { pkg: { 'SKILL.md': skillMd('from-node-modules') } },
      '.git': { hooks: { 'SKILL.md': skillMd('from-git') } },
      '.hidden': { 'SKILL.md': skillMd('hidden-skill') },
      ok: { 'SKILL.md': skillMd('ok') },
    });

    const skills = await scanSkillsRoot(host, ROOT);

    expect(skills.map((s) => s.name)).toEqual(['ok']);
  });

  it('resolves name collisions to the shallowest skill', async () => {
    const host = makeHost({
      shallow: { 'SKILL.md': skillMd('dupe', 'shallow copy') },
      z: { deep: { 'SKILL.md': skillMd('dupe', 'deep copy') } },
    });

    const skills = await scanSkillsRoot(host, ROOT);

    expect(skills).toHaveLength(1);
    expect(skills[0].dir).toBe(`${ROOT}/shallow`);
    expect(skills[0].description).toBe('shallow copy');
  });

  it('breaks equal-depth collisions by lexicographic path order', async () => {
    const host = makeHost({
      b: { 'SKILL.md': skillMd('tie', 'from b') },
      a: { 'SKILL.md': skillMd('tie', 'from a') },
    });

    const skills = await scanSkillsRoot(host, ROOT);

    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe('from a');
  });

  it('skips skills with a blank frontmatter name and still prunes their subtree', async () => {
    const host = makeHost({
      broken: {
        'SKILL.md': '---\ndescription: no name\n---\nbody',
        child: { 'SKILL.md': skillMd('child-skill') },
      },
    });

    const skills = await scanSkillsRoot(host, ROOT);

    expect(skills).toEqual([]);
  });

  it('collects only .md/.txt/.json resources, recursively, sorted, excluding SKILL.md and ignored dirs', async () => {
    const host = makeHost({
      rich: {
        'SKILL.md': skillMd('rich'),
        'guide.md': 'guide',
        'data.json': '{}',
        'notes.txt': 'notes',
        'image.png': 'binary',
        refs: { 'deep.md': 'deep' },
        node_modules: { 'dep.md': 'dep' },
      },
    });

    const skills = await scanSkillsRoot(host, ROOT);

    expect(skills[0].resources).toEqual(['data.json', 'guide.md', 'notes.txt', 'refs/deep.md']);
  });

  it('tolerates an unreadable subdirectory: reports it and keeps scanning', async () => {
    const onError = vi.fn();
    const host = makeHost(
      {
        locked: { secret: { 'SKILL.md': skillMd('secret') } },
        ok: { 'SKILL.md': skillMd('ok') },
      },
      [`${ROOT}/locked`],
    );

    const skills = await scanSkillsRoot(host, ROOT, { onError });

    expect(skills.map((s) => s.name)).toEqual(['ok']);
    expect(onError).toHaveBeenCalledWith(`${ROOT}/locked`, expect.any(Error));
  });

  it('returns an empty list for a missing root without throwing', async () => {
    const host = makeHost({});

    await expect(scanSkillsRoot(host, '/elsewhere')).resolves.toEqual([]);
  });
});

describe('parseFrontmatter', () => {
  it('extracts name/description, stripping surrounding quotes', async () => {
    const parsed = parseFrontmatter('---\nname: "quoted"\ndescription: \'desc\'\n---\nthe body');

    expect(parsed).toEqual({ name: 'quoted', description: 'desc', body: 'the body' });
  });

  it('treats a file without frontmatter as all body with blank metadata', async () => {
    const parsed = parseFrontmatter('# Just markdown\n');

    expect(parsed).toEqual({ name: '', description: '', body: '# Just markdown\n' });
  });

  it('normalizes CRLF line endings before parsing', async () => {
    const parsed = parseFrontmatter('---\r\nname: crlf\r\n---\r\nbody');

    expect(parsed.name).toBe('crlf');
    expect(parsed.body).toBe('body');
  });
});
