import { fuzzyScore, rankItems } from './fuzzy-match';

/**
 * Tests the pure quick-switcher matcher: tier ordering (filename prefix >
 * filename substring > path substring > subsequence), in-tier tie-breaks,
 * case-insensitivity, and the deterministic ordering of rankItems.
 */
describe('fuzzyScore', () => {
  it('returns 0 for an empty or whitespace-only query (everything matches)', () => {
    expect(fuzzyScore('', 'readme.md', 'docs/readme.md')).toBe(0);
    expect(fuzzyScore('   ', 'readme.md')).toBe(0);
  });

  it('returns null when the query matches neither name nor path', () => {
    expect(fuzzyScore('zzz', 'readme.md', 'docs/readme.md')).toBeNull();
    expect(fuzzyScore('xq', 'plan.md', 'plans/plan.md')).toBeNull();
  });

  it('matches case-insensitively', () => {
    expect(fuzzyScore('README', 'readme.md')).toEqual(fuzzyScore('readme', 'readme.md'));
    expect(fuzzyScore('adr', 'ADR-001.md')).not.toBeNull();
  });

  it('ranks a filename prefix above a filename substring', () => {
    const prefix = fuzzyScore('plan', 'plan-v2.md')!;
    const substring = fuzzyScore('plan', 'master-plan.md')!;
    expect(prefix).toBeGreaterThan(substring);
  });

  it('ranks a filename substring above a path substring', () => {
    const nameContains = fuzzyScore('auth', 'oauth-notes.md', 'misc/oauth-notes.md')!;
    const pathContains = fuzzyScore('auth', 'tokens.md', 'auth/tokens.md')!;
    expect(nameContains).toBeGreaterThan(pathContains);
  });

  it('ranks a path substring above a filename subsequence', () => {
    const pathContains = fuzzyScore('auth', 'tokens.md', 'auth/tokens.md')!;
    const subsequence = fuzzyScore('auth', 'about-this.md', 'docs/about-this.md')!;
    expect(pathContains).toBeGreaterThan(subsequence);
  });

  it('ranks a filename subsequence above a path-only subsequence', () => {
    const nameSubsequence = fuzzyScore('adr', 'a-draft.md', 'notes/a-draft.md')!;
    const pathSubsequence = fuzzyScore('adr', 'notes.md', 'a/drafts/notes.md')!;
    expect(nameSubsequence).toBeGreaterThan(pathSubsequence);
  });

  it('prefers earlier substring matches within the same tier', () => {
    const early = fuzzyScore('spec', 'my-spec-notes.md')!;
    const late = fuzzyScore('spec', 'my-very-long-name-spec.md')!;
    expect(early).toBeGreaterThan(late);
  });

  it('prefers shorter candidates within the prefix tier', () => {
    const short = fuzzyScore('plan', 'plan.md')!;
    const long = fuzzyScore('plan', 'plan-for-the-quarter.md')!;
    expect(short).toBeGreaterThan(long);
  });

  it('prefers tighter subsequences within the same tier', () => {
    const tight = fuzzyScore('frs', 'firs.md')!;
    const spread = fuzzyScore('frs', 'feature-roadmaps.md')!;
    expect(tight).toBeGreaterThan(spread);
  });

  it('never lets in-tier bonuses overtake a stronger tier', () => {
    // Worst-case prefix (very long name) still beats best-case substring.
    const worstPrefix = fuzzyScore('a', 'a' + 'x'.repeat(500) + '.md')!;
    const bestSubstring = fuzzyScore('a', 'xa.md')!;
    expect(worstPrefix).toBeGreaterThan(bestSubstring);
  });
});

describe('rankItems', () => {
  interface Entry {
    name: string;
    relPath: string;
  }

  const files: Entry[] = [
    { name: 'roadmap.md', relPath: 'planning/roadmap.md' },
    { name: 'plan.md', relPath: 'planning/plan.md' },
    { name: 'master-plan.md', relPath: 'archive/master-plan.md' },
    { name: 'notes.md', relPath: 'plans/notes.md' },
    { name: 'unrelated.md', relPath: 'misc/unrelated.md' },
  ];

  const rank = (query: string): string[] =>
    rankItems(files, query, (f) => f.name, (f) => f.relPath).map((f) => f.name);

  it('filters out non-matching items', () => {
    expect(rank('plan')).not.toContain('unrelated.md');
  });

  it('orders results by tier: prefix, name substring, path substring', () => {
    // Within the path-substring tier, the shorter path (plans/notes.md)
    // outranks the longer one (planning/roadmap.md) at the same match index.
    expect(rank('plan')).toEqual(['plan.md', 'master-plan.md', 'notes.md', 'roadmap.md']);
  });

  it('breaks score ties alphabetically on the primary string', () => {
    // Identical tier, position, and length — only the alphabetical
    // tie-break separates them.
    const scoredTie: Entry[] = [
      { name: 'bb.md', relPath: '' },
      { name: 'ab.md', relPath: '' },
    ];
    expect(rankItems(scoredTie, 'b.md', (f) => f.name).map((f) => f.name)).toEqual([
      'ab.md',
      'bb.md',
    ]);
  });

  it('returns all items in original order for an empty query', () => {
    expect(rank('')).toEqual(files.map((f) => f.name));
  });
});
