import { describe, expect, it } from 'vitest';
import { resolveLinkTarget } from '../../../electron/indexing/link-resolver';

/**
 * Tests the pure main-process Obsidian-style wikilink resolver against an
 * in-memory rel-path list (no database involved).
 */
describe('resolveLinkTarget', () => {
  const relPaths = [
    'Target.md',
    'specs/Target.md',
    'specs/auth/Login.md',
    'notes/login.md',
    'Plan.md',
  ];

  it('resolves a bare target by basename, case-insensitively', () => {
    expect(resolveLinkTarget('plan', relPaths)).toBe('Plan.md');
    expect(resolveLinkTarget('LOGIN', relPaths)).toBe('notes/login.md');
  });

  it('prefers the shortest rel_path when multiple basenames match', () => {
    expect(resolveLinkTarget('Target', relPaths)).toBe('Target.md');
  });

  it('resolves folder-qualified targets by rel_path suffix', () => {
    expect(resolveLinkTarget('specs/Target', relPaths)).toBe('specs/Target.md');
    expect(resolveLinkTarget('auth/Login', relPaths)).toBe('specs/auth/Login.md');
  });

  it('requires a path-segment boundary for suffix matches', () => {
    // "th/Login" is not a segment-aligned suffix of "specs/auth/Login.md".
    expect(resolveLinkTarget('th/Login', relPaths)).toBeNull();
  });

  it('tolerates an explicit .md extension on the target', () => {
    expect(resolveLinkTarget('Plan.md', relPaths)).toBe('Plan.md');
    expect(resolveLinkTarget('specs/Target.md', relPaths)).toBe('specs/Target.md');
  });

  it('normalizes backslashes and leading slashes', () => {
    expect(resolveLinkTarget('specs\\auth\\Login', relPaths)).toBe('specs/auth/Login.md');
    expect(resolveLinkTarget('/Plan', relPaths)).toBe('Plan.md');
  });

  it('returns null for unresolved or empty targets', () => {
    expect(resolveLinkTarget('Missing', relPaths)).toBeNull();
    expect(resolveLinkTarget('   ', relPaths)).toBeNull();
    expect(resolveLinkTarget('Target', [])).toBeNull();
  });

  it('breaks length ties deterministically (lexicographic)', () => {
    expect(resolveLinkTarget('note', ['b/note.md', 'a/note.md'])).toBe('a/note.md');
  });
});
