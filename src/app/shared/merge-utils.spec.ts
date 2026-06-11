import { computeMinimalChange, threeWayMerge } from './merge-utils';

describe('threeWayMerge', () => {
  const base = [
    'line1',
    'line2',
    'line3',
    'line4',
    'line5',
    'line6',
    'line7',
    'line8',
    'line9',
    'line10',
  ].join('\n');

  it('merges disjoint edits from both sides cleanly', () => {
    const mine = base.replace('line1', 'line1-mine');
    const theirs = base.replace('line10', 'line10-theirs');

    const result = threeWayMerge(base, mine, theirs);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain('line1-mine');
      expect(result.text).toContain('line10-theirs');
      expect(result.text).not.toContain('line1\n');
      expect(result.text.endsWith('line10-theirs')).toBe(true);
    }
  });

  it('reports a conflict when both sides edit the same line differently', () => {
    const mine = base.replace('line5', 'line5-mine');
    const theirs = base.replace('line5', 'line5-theirs');

    expect(threeWayMerge(base, mine, theirs)).toEqual({ ok: false });
  });

  it('treats identical edits on both sides as a clean merge', () => {
    const both = base.replace('line5', 'line5-same');

    expect(threeWayMerge(base, both, both)).toEqual({ ok: true, text: both });
  });

  it('returns theirs when mine is unchanged from base', () => {
    const theirs = base.replace('line3', 'line3-theirs');

    expect(threeWayMerge(base, base, theirs)).toEqual({ ok: true, text: theirs });
  });

  it('returns mine when theirs is unchanged from base', () => {
    const mine = base.replace('line3', 'line3-mine');

    expect(threeWayMerge(base, mine, base)).toEqual({ ok: true, text: mine });
  });

  it('reports a conflict when both sides diverged from an empty base', () => {
    // Two sides independently creating content (or one side clearing the
    // buffer while the other edits) always needs user arbitration.
    expect(threeWayMerge('', 'mine-content', 'theirs-content')).toEqual({ ok: false });
    expect(threeWayMerge('line1\nline2', '', 'line1\nline2-theirs')).toEqual({ ok: false });
  });

  it('merges an addition in theirs into an edited mine when regions are disjoint', () => {
    const mine = base.replace('line2', 'line2-mine');
    const theirs = base + '\nline11-theirs';

    const result = threeWayMerge(base, mine, theirs);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toContain('line2-mine');
      expect(result.text).toContain('line11-theirs');
    }
  });
});

describe('computeMinimalChange', () => {
  it('returns null when the texts are identical', () => {
    expect(computeMinimalChange('same', 'same')).toBeNull();
    expect(computeMinimalChange('', '')).toBeNull();
  });

  it('computes an insertion between a shared prefix and suffix', () => {
    const change = computeMinimalChange('hello world', 'hello brave world');

    expect(change).toEqual({ from: 6, to: 6, insert: 'brave ' });
  });

  it('computes a mid-document replacement excluding prefix and suffix', () => {
    const change = computeMinimalChange('aaa MIDDLE zzz', 'aaa CENTER zzz');

    expect(change).toEqual({ from: 4, to: 10, insert: 'CENTER' });
  });

  it('does not let prefix and suffix overlap on repeated characters', () => {
    // Naive prefix+suffix scans would each claim both "a"s of the new text.
    const change = computeMinimalChange('aaa', 'aa');

    expect(change).toEqual({ from: 2, to: 3, insert: '' });
  });

  it('handles a full replacement with no common edges', () => {
    expect(computeMinimalChange('abc', 'xyz')).toEqual({ from: 0, to: 3, insert: 'xyz' });
  });

  it('handles growth from empty and shrink to empty', () => {
    expect(computeMinimalChange('', 'new')).toEqual({ from: 0, to: 0, insert: 'new' });
    expect(computeMinimalChange('old', '')).toEqual({ from: 0, to: 3, insert: '' });
  });

  it('produces a change that reconstructs the new text', () => {
    const cases: Array<[string, string]> = [
      ['line1\nline2\nline3', 'line1\nline2-edited\nline3'],
      ['# Title\n\nBody.', '# Title\n\nIntro.\n\nBody.'],
      ['aaaa', 'aabaa'],
    ];
    for (const [oldText, newText] of cases) {
      const change = computeMinimalChange(oldText, newText);
      expect(change).not.toBeNull();
      if (change) {
        const applied = oldText.slice(0, change.from) + change.insert + oldText.slice(change.to);
        expect(applied).toBe(newText);
      }
    }
  });
});
