import { describe, expect, it } from 'vitest';
import { parseHeadings } from './heading-parser';

describe('parseHeadings', () => {
  it('parses ATX headings at every level with 1-based lines', () => {
    const md = '# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six';
    expect(parseHeadings(md)).toEqual([
      { level: 1, text: 'One', line: 1 },
      { level: 2, text: 'Two', line: 2 },
      { level: 3, text: 'Three', line: 3 },
      { level: 4, text: 'Four', line: 4 },
      { level: 5, text: 'Five', line: 5 },
      { level: 6, text: 'Six', line: 6 },
    ]);
  });

  it('returns an empty outline for empty or heading-less content', () => {
    expect(parseHeadings('')).toEqual([]);
    expect(parseHeadings('plain text\n\nmore text')).toEqual([]);
  });

  it('requires whitespace after the hashes', () => {
    expect(parseHeadings('#hashtag\n#5 bolt')).toEqual([]);
    expect(parseHeadings('#\theading')).toEqual([{ level: 1, text: 'heading', line: 1 }]);
  });

  it('treats bare hash runs as empty headings', () => {
    expect(parseHeadings('#\n##  ')).toEqual([
      { level: 1, text: '', line: 1 },
      { level: 2, text: '', line: 2 },
    ]);
  });

  it('ignores runs of more than six hashes', () => {
    expect(parseHeadings('####### Seven')).toEqual([]);
  });

  it('allows up to three spaces of indentation but not four', () => {
    expect(parseHeadings('   ### Indented\n    # Code block')).toEqual([
      { level: 3, text: 'Indented', line: 1 },
    ]);
  });

  it('strips closing hash sequences but keeps inline hashes', () => {
    expect(parseHeadings('## Title ##\n# C#\n# ###')).toEqual([
      { level: 2, text: 'Title', line: 1 },
      { level: 1, text: 'C#', line: 2 },
      { level: 1, text: '', line: 3 },
    ]);
  });

  it('skips headings inside backtick fences', () => {
    const md = '# Real\n```md\n# Fenced\n```\n## Also real';
    expect(parseHeadings(md)).toEqual([
      { level: 1, text: 'Real', line: 1 },
      { level: 2, text: 'Also real', line: 5 },
    ]);
  });

  it('skips headings inside tilde fences', () => {
    const md = '~~~\n# Fenced\n~~~\n# Real';
    expect(parseHeadings(md)).toEqual([{ level: 1, text: 'Real', line: 4 }]);
  });

  it('does not close a fence with a shorter or different-character run', () => {
    const md = '````\n# Fenced\n```\n# Still fenced\n~~~~\n# Still fenced too\n````\n# Real';
    expect(parseHeadings(md)).toEqual([{ level: 1, text: 'Real', line: 8 }]);
  });

  it('lets an unterminated fence swallow the rest of the document', () => {
    expect(parseHeadings('# Real\n```\n# Fenced forever')).toEqual([
      { level: 1, text: 'Real', line: 1 },
    ]);
  });

  it('ignores fence-like runs with trailing text when closing', () => {
    // ```js opens a fence; a "closer" with an info string is not a closer.
    const md = '```js\n# Fenced\n``` not a closer\n# Still fenced\n```\n# Real';
    expect(parseHeadings(md)).toEqual([{ level: 1, text: 'Real', line: 6 }]);
  });

  it('handles CRLF line endings', () => {
    expect(parseHeadings('# One\r\n## Two\r\n')).toEqual([
      { level: 1, text: 'One', line: 1 },
      { level: 2, text: 'Two', line: 2 },
    ]);
  });
});
