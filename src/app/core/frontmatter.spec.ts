import { describe, expect, it } from 'vitest';
import {
  addFrontmatterListItem,
  detectFrontmatter,
  flattenProperties,
  parseFrontmatter,
  removeFrontmatterProperty,
  removeFrontmatterPropertyIn,
  renameFrontmatterProperty,
  renameFrontmatterPropertyIn,
  setFrontmatterProperty,
  setFrontmatterPropertyIn,
} from '../../../electron/frontmatter/frontmatter';

/**
 * Tests the pure, Electron-free YAML frontmatter module shared by the main
 * process and the renderer. Detection operates on the original (non-normalized)
 * string so its offsets index into the live document; the higher-level helpers
 * round-trip through `yaml.parseDocument`, preserving comments, blank lines and
 * key order, and must never throw on malformed input.
 */

describe('detectFrontmatter', () => {
  it('detects a leading LF frontmatter block and slices the region', () => {
    const text = '---\ntitle: A\n---\nthe body';
    const region = detectFrontmatter(text);

    expect(region.present).toBe(true);
    expect(region.yamlText).toBe('title: A\n');
    expect(region.raw).toBe('---\ntitle: A\n---\n');
    // regionEnd lands just past the closing delimiter's newline.
    expect(text.slice(region.regionEnd)).toBe('the body');
  });

  it('reports an absent block for plain markdown', () => {
    const region = detectFrontmatter('# Just markdown\nmore');

    expect(region).toEqual({ present: false, raw: '', yamlText: '', regionEnd: 0 });
  });

  it('only matches a block at the very start of the document', () => {
    const region = detectFrontmatter('intro\n---\ntitle: A\n---\nbody');

    expect(region.present).toBe(false);
  });

  it('is CRLF-aware and consumes the closing delimiter newline', () => {
    const text = '---\r\ntitle: A\r\n---\r\nthe body';
    const region = detectFrontmatter(text);

    expect(region.present).toBe(true);
    expect(region.yamlText).toBe('title: A\r\n');
    // Offsets index into the original CRLF string, so the body slices cleanly.
    expect(text.slice(region.regionEnd)).toBe('the body');
  });

  it('handles a closing delimiter with no trailing newline', () => {
    const text = '---\ntitle: A\n---';
    const region = detectFrontmatter(text);

    expect(region.present).toBe(true);
    expect(text.slice(region.regionEnd)).toBe('');
  });
});

describe('parseFrontmatter', () => {
  it('parses a present block and returns the trailing body', () => {
    const result = parseFrontmatter('---\ntitle: Hello\n---\nthe body');

    expect(result).toEqual({ data: { title: 'Hello' }, body: 'the body', present: true });
  });

  it('returns the full text as the body when absent', () => {
    const result = parseFrontmatter('# Just markdown\nmore');

    expect(result).toEqual({ data: {}, body: '# Just markdown\nmore', present: false });
  });

  it('never throws on malformed YAML and yields empty data', () => {
    const result = parseFrontmatter('---\nfoo: [unclosed\n---\nbody');

    expect(result).toEqual({ data: {}, body: 'body', present: true });
  });

  it('coerces a non-object YAML root to an empty mapping', () => {
    const result = parseFrontmatter('---\njust a scalar\n---\nbody');

    expect(result.data).toEqual({});
    expect(result.present).toBe(true);
  });

  it('normalizes CRLF before parsing', () => {
    const result = parseFrontmatter('---\r\ntitle: crlf\r\n---\r\nbody');

    expect(result.data).toEqual({ title: 'crlf' });
    expect(result.body).toBe('body');
  });

  it('parses list, numeric and boolean values', () => {
    const result = parseFrontmatter(
      '---\ntags:\n  - a\n  - b\ncount: 3\nflag: true\n---\nbody',
    );

    expect(result.data).toEqual({ tags: ['a', 'b'], count: 3, flag: true });
  });
});

describe('setFrontmatterProperty', () => {
  it('updates an existing key while preserving comments, blank lines and key order', () => {
    const text = '---\n# leading comment\ntitle: Hello\n\nstatus: draft\n---\nBODY';

    const result = setFrontmatterProperty(text, 'status', 'active');

    expect(result).toBe('---\n# leading comment\ntitle: Hello\n\nstatus: active\n---\nBODY');
  });

  it('appends a new key at the end of the block', () => {
    const text = '---\ntitle: Hello\n---\nBODY';

    const result = setFrontmatterProperty(text, 'status', 'draft');

    expect(result).toBe('---\ntitle: Hello\nstatus: draft\n---\nBODY');
  });

  it('creates a fresh block when none exists, preserving the body verbatim', () => {
    const text = '# Just markdown\nmore';

    const result = setFrontmatterProperty(text, 'title', 'New');

    expect(result).toBe('---\ntitle: New\n---\n\n# Just markdown\nmore');
  });

  it('treats malformed existing YAML as absent and prepends a fresh block', () => {
    const text = '---\nfoo: [unclosed\n---\nBODY';

    const result = setFrontmatterProperty(text, 'title', 'New');

    expect(result.startsWith('---\ntitle: New\n---\n\n')).toBe(true);
    expect(result.endsWith(text)).toBe(true);
  });
});

describe('removeFrontmatterProperty', () => {
  it('removes a key while keeping the remaining block', () => {
    const text = '---\ntitle: T\nstatus: draft\n---\nBODY';

    const result = removeFrontmatterProperty(text, 'status');

    expect(result).toBe('---\ntitle: T\n---\nBODY');
  });

  it('drops the whole block when the last key is removed', () => {
    const text = '---\nonly: one\n---\nBODY';

    const result = removeFrontmatterProperty(text, 'only');

    expect(result).toBe('BODY');
  });

  it('returns the text unchanged when no frontmatter is present', () => {
    const text = '# Just markdown\n';

    expect(removeFrontmatterProperty(text, 'anything')).toBe(text);
  });

  it('never throws on malformed-but-parseable YAML with surviving keys', () => {
    // `bad: [unclosed` parses (errors collected on doc.errors, not thrown), and
    // removing it leaves the valid `good` key — which would force a re-serialize
    // and throw "Document with errors cannot be stringified". The module must
    // swallow that and leave the malformed block untouched.
    const text = '---\ngood: 1\nbad: [unclosed\n---\nBODY';

    expect(() => removeFrontmatterProperty(text, 'bad')).not.toThrow();
    expect(removeFrontmatterProperty(text, 'bad')).toBe(text);
  });

  it('never throws on malformed YAML when removing the only surviving key', () => {
    // Defensive: even when the deletion would empty the mapping, a malformed
    // doc must not reach doc.toString(); the guard returns the original text.
    const text = '---\nbad: [unclosed\n---\nBODY';

    expect(() => removeFrontmatterProperty(text, 'bad')).not.toThrow();
  });
});

describe('renameFrontmatterProperty', () => {
  it('renames a middle key in place, preserving its position among siblings and its value', () => {
    const text = '---\ntitle: T\nstatus: draft\nowner: alice\n---\nBODY';

    const result = renameFrontmatterProperty(text, 'status', 'state');

    // The renamed key keeps the middle slot (between title and owner) and value.
    expect(result).toBe('---\ntitle: T\nstate: draft\nowner: alice\n---\nBODY');
  });

  it('preserves a comment above the renamed key and its key order', () => {
    const text = '---\ntitle: T\n# the lifecycle\nstatus: draft\n---\nBODY';

    const result = renameFrontmatterProperty(text, 'status', 'state');

    expect(result).toBe('---\ntitle: T\n# the lifecycle\nstate: draft\n---\nBODY');
  });

  it('preserves an inline comment on the renamed key', () => {
    const text = '---\nstatus: draft # lifecycle\ntitle: T\n---\nBODY';

    const result = renameFrontmatterProperty(text, 'status', 'state');

    expect(result).toBe('---\nstate: draft # lifecycle\ntitle: T\n---\nBODY');
  });

  it('no-ops on an empty newKey', () => {
    const text = '---\nstatus: draft\n---\nBODY';

    expect(renameFrontmatterProperty(text, 'status', '')).toBe(text);
  });

  it('no-ops when newKey equals oldKey', () => {
    const text = '---\nstatus: draft\n---\nBODY';

    expect(renameFrontmatterProperty(text, 'status', 'status')).toBe(text);
  });

  it('no-ops when oldKey does not exist', () => {
    const text = '---\nstatus: draft\n---\nBODY';

    expect(renameFrontmatterProperty(text, 'missing', 'state')).toBe(text);
  });

  it('no-ops on a collision with an existing different key', () => {
    const text = '---\ntitle: T\nstatus: draft\n---\nBODY';

    // Renaming `status` to the existing `title` would duplicate the key: abort.
    expect(renameFrontmatterProperty(text, 'status', 'title')).toBe(text);
  });

  it('returns the text unchanged when no frontmatter is present', () => {
    const text = '# Just markdown\n';

    expect(renameFrontmatterProperty(text, 'status', 'state')).toBe(text);
  });

  it('never throws on malformed YAML and returns the text unchanged', () => {
    const text = '---\nfoo: [unclosed\n---\nBODY';

    expect(renameFrontmatterProperty(text, 'foo', 'bar')).toBe(text);
  });
});

describe('setFrontmatterPropertyIn', () => {
  it('sets a nested leaf, preserving siblings, other keys and a comment', () => {
    const text =
      '---\ntitle: T\n# the author block\nauthor:\n  name: alice\n  email: a@x\n---\nBODY';

    const result = setFrontmatterPropertyIn(text, ['author', 'name'], 'bob');

    expect(result).toBe(
      '---\ntitle: T\n# the author block\nauthor:\n  name: bob\n  email: a@x\n---\nBODY',
    );
  });

  it('sets a list item by index, leaving the other items intact', () => {
    const text = '---\ntags:\n  - a\n  - b\n  - c\n---\nBODY';

    const result = setFrontmatterPropertyIn(text, ['tags', 1], 'B');

    expect(result).toBe('---\ntags:\n  - a\n  - B\n  - c\n---\nBODY');
  });

  it('no-ops on an empty path', () => {
    const text = '---\ntitle: T\n---\nBODY';

    expect(setFrontmatterPropertyIn(text, [], 'x')).toBe(text);
  });

  it('returns the text unchanged when no frontmatter is present', () => {
    const text = '# Just markdown\n';

    expect(setFrontmatterPropertyIn(text, ['author', 'name'], 'bob')).toBe(text);
  });

  it('never throws on malformed YAML and returns the text unchanged', () => {
    const text = '---\nfoo: [unclosed\n---\nBODY';

    expect(setFrontmatterPropertyIn(text, ['foo'], 'bar')).toBe(text);
  });
});

describe('removeFrontmatterPropertyIn', () => {
  it('removes a nested leaf while keeping its siblings', () => {
    const text = '---\nauthor:\n  name: alice\n  email: a@x\n---\nBODY';

    const result = removeFrontmatterPropertyIn(text, ['author', 'email']);

    expect(result).toBe('---\nauthor:\n  name: alice\n---\nBODY');
  });

  it('removes a list item by index, preserving the remaining order', () => {
    const text = '---\ntags:\n  - a\n  - b\n  - c\n---\nBODY';

    const result = removeFrontmatterPropertyIn(text, ['tags', 1]);

    expect(result).toBe('---\ntags:\n  - a\n  - c\n---\nBODY');
  });

  it('drops the whole block when the last root key is removed', () => {
    const text = '---\nonly: one\n---\nBODY';

    const result = removeFrontmatterPropertyIn(text, ['only']);

    expect(result).toBe('BODY');
  });

  it('no-ops on an empty path', () => {
    const text = '---\ntitle: T\n---\nBODY';

    expect(removeFrontmatterPropertyIn(text, [])).toBe(text);
  });

  it('returns the text unchanged when no frontmatter is present', () => {
    const text = '# Just markdown\n';

    expect(removeFrontmatterPropertyIn(text, ['title'])).toBe(text);
  });

  it('never throws on malformed YAML and returns the text unchanged', () => {
    const text = '---\nfoo: [unclosed\n---\nBODY';

    expect(removeFrontmatterPropertyIn(text, ['foo'])).toBe(text);
  });
});

describe('addFrontmatterListItem', () => {
  it('appends to an existing list, keeping order with the new item last', () => {
    const text = '---\ntags:\n  - a\n  - b\n---\nBODY';

    const result = addFrontmatterListItem(text, ['tags'], 'c');

    expect(result).toBe('---\ntags:\n  - a\n  - b\n  - c\n---\nBODY');
  });

  it('creates a new one-element list when the key is absent', () => {
    const text = '---\ntitle: T\n---\nBODY';

    const result = addFrontmatterListItem(text, ['tags'], 'a');

    expect(result).toBe('---\ntitle: T\ntags:\n  - a\n---\nBODY');
  });

  it('no-ops when the target exists but is not a list', () => {
    const text = '---\ntitle: T\n---\nBODY';

    expect(addFrontmatterListItem(text, ['title'], 'x')).toBe(text);
  });

  it('no-ops on an empty path', () => {
    const text = '---\ntags:\n  - a\n---\nBODY';

    expect(addFrontmatterListItem(text, [], 'x')).toBe(text);
  });

  it('returns the text unchanged when no frontmatter is present', () => {
    const text = '# Just markdown\n';

    expect(addFrontmatterListItem(text, ['tags'], 'a')).toBe(text);
  });

  it('never throws on malformed YAML and returns the text unchanged', () => {
    const text = '---\nfoo: [unclosed\n---\nBODY';

    expect(addFrontmatterListItem(text, ['foo'], 'bar')).toBe(text);
  });
});

describe('renameFrontmatterPropertyIn', () => {
  it("renames a nested map's child key in place, preserving order, value and comment", () => {
    const text =
      '---\nauthor:\n  name: alice\n  # primary contact\n  email: a@x\n---\nBODY';

    const result = renameFrontmatterPropertyIn(text, ['author'], 'email', 'contact');

    expect(result).toBe(
      '---\nauthor:\n  name: alice\n  # primary contact\n  contact: a@x\n---\nBODY',
    );
  });

  it('renames at the root when parentPath is empty, like renameFrontmatterProperty', () => {
    const text = '---\ntitle: T\nstatus: draft\nowner: alice\n---\nBODY';

    const viaPath = renameFrontmatterPropertyIn(text, [], 'status', 'state');
    const viaTopLevel = renameFrontmatterProperty(text, 'status', 'state');

    expect(viaPath).toBe('---\ntitle: T\nstate: draft\nowner: alice\n---\nBODY');
    expect(viaPath).toBe(viaTopLevel);
  });

  it('no-ops on an empty newKey', () => {
    const text = '---\nauthor:\n  name: alice\n---\nBODY';

    expect(renameFrontmatterPropertyIn(text, ['author'], 'name', '')).toBe(text);
  });

  it('no-ops when newKey equals oldKey', () => {
    const text = '---\nauthor:\n  name: alice\n---\nBODY';

    expect(renameFrontmatterPropertyIn(text, ['author'], 'name', 'name')).toBe(text);
  });

  it('no-ops when oldKey does not exist in the target map', () => {
    const text = '---\nauthor:\n  name: alice\n---\nBODY';

    expect(renameFrontmatterPropertyIn(text, ['author'], 'missing', 'x')).toBe(text);
  });

  it('no-ops on a collision with an existing different key in the target map', () => {
    const text = '---\nauthor:\n  name: alice\n  email: a@x\n---\nBODY';

    // Renaming `email` to the existing `name` would duplicate the key: abort.
    expect(renameFrontmatterPropertyIn(text, ['author'], 'email', 'name')).toBe(text);
  });

  it('no-ops when the node at parentPath is not a map', () => {
    const text = '---\ntags:\n  - a\n  - b\n---\nBODY';

    expect(renameFrontmatterPropertyIn(text, ['tags'], 'a', 'z')).toBe(text);
  });

  it('returns the text unchanged when no frontmatter is present', () => {
    const text = '# Just markdown\n';

    expect(renameFrontmatterPropertyIn(text, ['author'], 'name', 'x')).toBe(text);
  });

  it('never throws on malformed YAML and returns the text unchanged', () => {
    const text = '---\nfoo: [unclosed\n---\nBODY';

    expect(renameFrontmatterPropertyIn(text, [], 'foo', 'bar')).toBe(text);
  });
});

describe('flattenProperties', () => {
  it('flattens a scalar string to a single row', () => {
    expect(flattenProperties({ title: 'Hello' })).toEqual([
      { key: 'title', value: 'Hello', idx: 0 },
    ]);
  });

  it('expands arrays to one row per element preserving order via idx', () => {
    expect(flattenProperties({ tags: ['a', 'b', 'c'] })).toEqual([
      { key: 'tags', value: 'a', idx: 0 },
      { key: 'tags', value: 'b', idx: 1 },
      { key: 'tags', value: 'c', idx: 2 },
    ]);
  });

  it('stringifies numbers and booleans', () => {
    expect(flattenProperties({ count: 3, flag: true })).toEqual([
      { key: 'count', value: '3', idx: 0 },
      { key: 'flag', value: 'true', idx: 0 },
    ]);
  });

  it('renders null/undefined as empty and recurses nested objects with dotted keys', () => {
    expect(flattenProperties({ none: null, nested: { x: 1 } })).toEqual([
      { key: 'none', value: '', idx: 0 },
      { key: 'nested.x', value: '1', idx: 0 },
    ]);
  });

  it('recurses nested objects to arbitrary depth with dotted keys', () => {
    expect(
      flattenProperties({ author: { name: 'alice', contact: { email: 'a@x' } } }),
    ).toEqual([
      { key: 'author.name', value: 'alice', idx: 0 },
      { key: 'author.contact.email', value: 'a@x', idx: 0 },
    ]);
  });

  it('recurses arrays of objects with dotted+indexed keys, keeping scalar list rows per item', () => {
    expect(
      flattenProperties({
        tags: ['a', 'b'],
        authors: [{ name: 'alice' }, { name: 'bob' }],
      }),
    ).toEqual([
      { key: 'tags', value: 'a', idx: 0 },
      { key: 'tags', value: 'b', idx: 1 },
      { key: 'authors.0.name', value: 'alice', idx: 0 },
      { key: 'authors.1.name', value: 'bob', idx: 0 },
    ]);
  });
});
