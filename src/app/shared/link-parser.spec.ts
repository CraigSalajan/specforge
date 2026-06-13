import { describe, expect, it } from 'vitest';
import {
  extractWikiLinks,
  normalizeWikiTarget,
} from '../../../electron/indexing/link-parser';

/**
 * Tests the pure main-process wikilink extractor (mirroring the
 * skill-scanner testability pattern: electron-side pure functions exercised
 * from a renderer-side vitest spec).
 */
describe('normalizeWikiTarget', () => {
  it('returns the plain target unchanged', () => {
    expect(normalizeWikiTarget('Target')).toBe('Target');
  });

  it('strips the alias', () => {
    expect(normalizeWikiTarget('Target|My Alias')).toBe('Target');
  });

  it('strips the heading fragment', () => {
    expect(normalizeWikiTarget('Target#Heading')).toBe('Target');
  });

  it('strips alias and fragment together', () => {
    expect(normalizeWikiTarget('Target#Heading|alias')).toBe('Target');
    expect(normalizeWikiTarget('Target|alias#not-a-fragment')).toBe('Target');
  });

  it('trims whitespace and yields empty for same-file anchors', () => {
    expect(normalizeWikiTarget('  Target  ')).toBe('Target');
    expect(normalizeWikiTarget('#Heading')).toBe('');
  });
});

describe('extractWikiLinks', () => {
  it('extracts a basic wikilink with its 1-based line', () => {
    expect(extractWikiLinks('first\nsee [[Target]] here')).toEqual([
      { target: 'Target', line: 2 },
    ]);
  });

  it('extracts multiple links on the same line in order', () => {
    expect(extractWikiLinks('[[One]] and [[Two|alias]] and [[Three#Sec]]')).toEqual([
      { target: 'One', line: 1 },
      { target: 'Two', line: 1 },
      { target: 'Three', line: 1 },
    ]);
  });

  it('keeps folder-qualified targets intact', () => {
    expect(extractWikiLinks('[[folder/Target]]')).toEqual([
      { target: 'folder/Target', line: 1 },
    ]);
  });

  it('skips links with empty targets', () => {
    expect(extractWikiLinks('[[#Heading]] [[|alias]] [[   ]]')).toEqual([]);
  });

  it('skips links inside fenced code blocks', () => {
    const md = ['before [[A]]', '```', '[[Inside]]', '```', 'after [[B]]'].join('\n');
    expect(extractWikiLinks(md)).toEqual([
      { target: 'A', line: 1 },
      { target: 'B', line: 5 },
    ]);
  });

  it('handles tilde fences and does not close them with backticks', () => {
    const md = ['~~~', '[[Inside]]', '```', '[[StillInside]]', '~~~', '[[Out]]'].join('\n');
    expect(extractWikiLinks(md)).toEqual([{ target: 'Out', line: 6 }]);
  });

  it('skips links inside inline code spans', () => {
    expect(extractWikiLinks('use `[[NotALink]]` but [[Real]]')).toEqual([
      { target: 'Real', line: 1 },
    ]);
  });

  it('matches code spans only on equal-length backtick runs', () => {
    // ``…`…`` is one span (the single backtick inside does not close it).
    expect(extractWikiLinks('``code ` [[Hidden]]`` [[Shown]]')).toEqual([
      { target: 'Shown', line: 1 },
    ]);
  });

  it('treats an unclosed backtick run as literal text', () => {
    expect(extractWikiLinks('stray ` tick [[Link]]')).toEqual([
      { target: 'Link', line: 1 },
    ]);
  });

  it('counts lines correctly with CRLF endings', () => {
    expect(extractWikiLinks('a\r\nb\r\n[[Target]]')).toEqual([
      { target: 'Target', line: 3 },
    ]);
  });

  it('ignores unbalanced or empty brackets', () => {
    expect(extractWikiLinks('[[]] [not [[ a link] ]]')).toEqual([]);
  });
});
