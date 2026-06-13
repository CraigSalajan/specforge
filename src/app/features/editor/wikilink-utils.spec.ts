import { describe, expect, it } from 'vitest';
import type { FileNode } from '../../shared/types';
import {
  buildResolvableStems,
  buildWikiCompletionEntries,
  collectMarkdownFiles,
  findAtxHeadingLine,
  isTargetResolvable,
  joinVaultPath,
  parentDir,
  splitWikiTarget,
  toRelPath,
} from './wikilink-utils';

describe('splitWikiTarget', () => {
  it('returns a plain target with no fragment', () => {
    expect(splitWikiTarget('Target')).toEqual({ target: 'Target', fragment: null });
  });

  it('splits off a heading fragment', () => {
    expect(splitWikiTarget('Target#My Heading')).toEqual({
      target: 'Target',
      fragment: 'My Heading',
    });
  });

  it('drops an alias while keeping the fragment', () => {
    expect(splitWikiTarget('Target#Heading|shown text')).toEqual({
      target: 'Target',
      fragment: 'Heading',
    });
  });

  it('handles same-file anchors ([[#Heading]])', () => {
    expect(splitWikiTarget('#Heading')).toEqual({ target: '', fragment: 'Heading' });
  });

  it('treats an empty fragment as absent and trims whitespace', () => {
    expect(splitWikiTarget(' Target # ')).toEqual({ target: 'Target', fragment: null });
  });
});

describe('findAtxHeadingLine', () => {
  const doc = [
    'intro text',
    '# Title',
    '',
    'body',
    '## Setup Guide',
    'more body',
    '### Deep Dive ##',
  ].join('\n');

  it('finds a heading line (1-based), case-insensitively', () => {
    expect(findAtxHeadingLine(doc, 'title')).toBe(2);
    expect(findAtxHeadingLine(doc, 'SETUP GUIDE')).toBe(5);
  });

  it('strips ATX closing hashes before comparing', () => {
    expect(findAtxHeadingLine(doc, 'Deep Dive')).toBe(7);
  });

  it('returns null when no heading matches', () => {
    expect(findAtxHeadingLine(doc, 'Missing')).toBeNull();
    expect(findAtxHeadingLine(doc, '')).toBeNull();
  });

  it('does not match heading-looking lines inside fenced code', () => {
    const fenced = ['```', '# Not A Heading', '```', '# Real Heading'].join('\n');
    expect(findAtxHeadingLine(fenced, 'Not A Heading')).toBeNull();
    expect(findAtxHeadingLine(fenced, 'Real Heading')).toBe(4);
  });

  it('requires whitespace after the hashes', () => {
    expect(findAtxHeadingLine('#NotAHeading', 'NotAHeading')).toBeNull();
  });
});

describe('buildResolvableStems / isTargetResolvable', () => {
  const stems = buildResolvableStems([
    'Target.md',
    'specs/Target.md',
    'specs/auth/Login.md',
    'Plan.md',
  ]);

  it('resolves bare targets by basename, case-insensitively', () => {
    expect(isTargetResolvable('plan', stems)).toBe(true);
    expect(isTargetResolvable('LOGIN', stems)).toBe(true);
    expect(isTargetResolvable('Target', stems)).toBe(true);
  });

  it('resolves folder-qualified targets on segment boundaries only', () => {
    expect(isTargetResolvable('auth/Login', stems)).toBe(true);
    expect(isTargetResolvable('specs/auth/Login', stems)).toBe(true);
    // Not segment-aligned — mirrors the main-process resolver.
    expect(isTargetResolvable('th/Login', stems)).toBe(false);
  });

  it('tolerates an explicit .md extension and slash/backslash noise', () => {
    expect(isTargetResolvable('Plan.md', stems)).toBe(true);
    expect(isTargetResolvable('specs\\auth\\Login', stems)).toBe(true);
    expect(isTargetResolvable('/Plan', stems)).toBe(true);
  });

  it('rejects unknown and empty targets', () => {
    expect(isTargetResolvable('Missing', stems)).toBe(false);
    expect(isTargetResolvable('   ', stems)).toBe(false);
    expect(isTargetResolvable('Target', buildResolvableStems([]))).toBe(false);
  });
});

describe('collectMarkdownFiles / toRelPath', () => {
  const vaultPath = 'C:\\vault';
  const tree: FileNode[] = [
    {
      name: 'specs',
      path: 'C:\\vault\\specs',
      isDirectory: true,
      children: [
        { name: 'Login.md', path: 'C:\\vault\\specs\\Login.md', isDirectory: false },
        { name: 'notes.txt', path: 'C:\\vault\\specs\\notes.txt', isDirectory: false },
      ],
    },
    { name: 'Plan.md', path: 'C:\\vault\\Plan.md', isDirectory: false },
  ];

  it('flattens nested markdown files with forward-slash rel paths', () => {
    expect(collectMarkdownFiles(tree, vaultPath)).toEqual([
      { name: 'Login.md', relPath: 'specs/Login.md', absPath: 'C:\\vault\\specs\\Login.md' },
      { name: 'Plan.md', relPath: 'Plan.md', absPath: 'C:\\vault\\Plan.md' },
    ]);
  });

  it('strips the vault prefix case-insensitively, keeping remainder casing', () => {
    expect(toRelPath('c:\\Vault\\Specs\\Login.md', 'C:\\vault')).toBe('Specs/Login.md');
    expect(toRelPath('/vault/notes/Plan.md', '/vault/')).toBe('notes/Plan.md');
  });
});

describe('buildWikiCompletionEntries', () => {
  it('labels by basename and details by relPath, sorted by label', () => {
    const entries = buildWikiCompletionEntries([
      { name: 'Plan.md', relPath: 'Plan.md', absPath: '/v/Plan.md' },
      { name: 'Auth.md', relPath: 'specs/Auth.md', absPath: '/v/specs/Auth.md' },
    ]);
    expect(entries).toEqual([
      { label: 'Auth', detail: 'specs/Auth.md', insert: 'Auth' },
      { label: 'Plan', detail: 'Plan.md', insert: 'Plan' },
    ]);
  });

  it('disambiguates duplicate basenames with the relPath stem', () => {
    const entries = buildWikiCompletionEntries([
      { name: 'Target.md', relPath: 'Target.md', absPath: '/v/Target.md' },
      { name: 'target.md', relPath: 'specs/target.md', absPath: '/v/specs/target.md' },
      { name: 'Plan.md', relPath: 'Plan.md', absPath: '/v/Plan.md' },
    ]);
    expect(entries).toEqual([
      { label: 'Plan', detail: 'Plan.md', insert: 'Plan' },
      { label: 'target', detail: 'specs/target.md', insert: 'specs/target' },
      { label: 'Target', detail: 'Target.md', insert: 'Target' },
    ]);
  });
});

describe('joinVaultPath / parentDir', () => {
  it('joins with the separator style of the parent', () => {
    expect(joinVaultPath('C:\\vault', 'specs/Login.md')).toBe('C:\\vault\\specs\\Login.md');
    expect(joinVaultPath('/vault/', 'specs/Login.md')).toBe('/vault/specs/Login.md');
  });

  it('returns the directory portion of an absolute path', () => {
    expect(parentDir('C:\\vault\\specs\\Login.md')).toBe('C:\\vault\\specs');
    expect(parentDir('/vault/Plan.md')).toBe('/vault');
  });
});
