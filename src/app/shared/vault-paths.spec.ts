import { describe, expect, it } from 'vitest';
import type { FileNode } from './types';
import { collectFolderPaths, fromVaultRel, toVaultRel, treeContainsFile } from './vault-paths';

describe('toVaultRel', () => {
  it('relativizes Windows paths with forward slashes, preserving casing', () => {
    expect(toVaultRel('C:\\Vault', 'C:\\Vault\\Specs\\Plan.md')).toBe('Specs/Plan.md');
  });

  it('tolerates separator, casing and trailing-slash drift', () => {
    expect(toVaultRel('c:/vault/', 'C:\\VAULT\\a.md')).toBe('a.md');
    expect(toVaultRel('C:\\Vault\\', 'c:/vault/notes/B.md')).toBe('notes/B.md');
  });

  it('handles POSIX paths', () => {
    expect(toVaultRel('/home/u/vault', '/home/u/vault/notes/a.md')).toBe('notes/a.md');
  });

  it('returns null for paths outside the vault', () => {
    expect(toVaultRel('C:/vault', 'C:/other/a.md')).toBeNull();
  });

  it('requires a path-segment boundary (no prefix false positives)', () => {
    expect(toVaultRel('C:/va', 'C:/vault/a.md')).toBeNull();
  });

  it('returns an empty string for the vault root itself', () => {
    expect(toVaultRel('C:/vault', 'C:\\vault\\')).toBe('');
  });
});

describe('fromVaultRel', () => {
  it('joins with the vault path separator style', () => {
    expect(fromVaultRel('C:\\Vault', 'specs/Plan.md')).toBe('C:\\Vault\\specs\\Plan.md');
    expect(fromVaultRel('/home/u/vault', 'specs/Plan.md')).toBe('/home/u/vault/specs/Plan.md');
  });

  it('strips trailing separators and collapses redundant slashes', () => {
    expect(fromVaultRel('C:\\Vault\\', '/specs//Plan.md')).toBe('C:\\Vault\\specs\\Plan.md');
  });
});

describe('tree helpers', () => {
  const tree: FileNode[] = [
    {
      name: 'specs',
      path: 'C:\\v\\specs',
      isDirectory: true,
      children: [
        {
          name: 'auth',
          path: 'C:\\v\\specs\\auth',
          isDirectory: true,
          children: [
            { name: 'login.md', path: 'C:\\v\\specs\\auth\\login.md', isDirectory: false },
          ],
        },
      ],
    },
    { name: 'plan.md', path: 'C:\\v\\plan.md', isDirectory: false },
  ];

  it('treeContainsFile matches files case-insensitively across separators', () => {
    expect(treeContainsFile(tree, 'c:/v/specs/auth/LOGIN.md')).toBe(true);
    expect(treeContainsFile(tree, 'C:\\v\\plan.md')).toBe(true);
  });

  it('treeContainsFile ignores directories and misses', () => {
    expect(treeContainsFile(tree, 'C:\\v\\specs')).toBe(false);
    expect(treeContainsFile(tree, 'C:\\v\\missing.md')).toBe(false);
    expect(treeContainsFile([], 'C:\\v\\plan.md')).toBe(false);
  });

  it('collectFolderPaths returns every directory depth-first', () => {
    expect(collectFolderPaths(tree)).toEqual(['C:\\v\\specs', 'C:\\v\\specs\\auth']);
  });
});
