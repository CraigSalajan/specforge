import { describe, expect, it } from 'vitest';
import {
  CRITERIA_MARKER_END,
  CRITERIA_MARKER_START,
  composeDescription,
  renderCriteriaChecklist,
} from '../../../electron/sync/linear/description';

/**
 * Unit tests for the Linear description composer (TER-21). The module is pure —
 * no transport, no I/O — so the suite calls the helpers directly across the
 * `electron/` boundary, exactly as the adapter spec does. It pins three things:
 * the rendered checklist is an unchecked, marker-bounded `- [ ]` block; criteria
 * fold into a body without clobbering it; and re-composing is idempotent so a
 * re-sync rebuilds the region in place rather than appending duplicates.
 */

/** Counts non-overlapping occurrences of a literal substring. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('renderCriteriaChecklist — TER-21', () => {
  it('renders one unchecked "- [ ]" line per criterion, marker-bounded', () => {
    const block = renderCriteriaChecklist(['First criterion', 'Second criterion']);

    expect(block).toBe(
      [
        CRITERIA_MARKER_START,
        '- [ ] First criterion',
        '- [ ] Second criterion',
        CRITERIA_MARKER_END,
      ].join('\n'),
    );
  });

  it('never emits a checked "- [x]" line', () => {
    const block = renderCriteriaChecklist(['done already', 'also done']);

    expect(block).not.toContain('- [x]');
    expect(block).not.toContain('- [X]');
  });

  it('drops empty and whitespace-only entries and trims the rest', () => {
    const block = renderCriteriaChecklist(['  keep me  ', '', '   ', '\t\n', 'and me']);

    expect(block).toBe(
      [CRITERIA_MARKER_START, '- [ ] keep me', '- [ ] and me', CRITERIA_MARKER_END].join('\n'),
    );
  });

  it('renders just the two markers when given no usable criteria', () => {
    expect(renderCriteriaChecklist([])).toBe(`${CRITERIA_MARKER_START}\n${CRITERIA_MARKER_END}`);
  });
});

describe('composeDescription — TER-21', () => {
  it('places the body before the marked checklist block', () => {
    const result = composeDescription('Some body text.', ['A criterion']);

    expect(result).toBe(
      `Some body text.\n\n${CRITERIA_MARKER_START}\n- [ ] A criterion\n${CRITERIA_MARKER_END}`,
    );
    // The body precedes the region.
    expect(result?.indexOf('Some body text.')).toBeLessThan(
      result?.indexOf(CRITERIA_MARKER_START) ?? -1,
    );
  });

  it('returns the block alone when there is no body', () => {
    const result = composeDescription(undefined, ['Only criterion']);

    expect(result).toBe(`${CRITERIA_MARKER_START}\n- [ ] Only criterion\n${CRITERIA_MARKER_END}`);
  });

  it('treats an empty-string body like no body (block alone)', () => {
    const result = composeDescription('', ['Only criterion']);

    expect(result).toBe(`${CRITERIA_MARKER_START}\n- [ ] Only criterion\n${CRITERIA_MARKER_END}`);
  });

  it('returns the body unchanged when criteria are absent', () => {
    expect(composeDescription('Just a body.', undefined)).toBe('Just a body.');
  });

  it('returns the body unchanged when criteria are all empty/whitespace', () => {
    expect(composeDescription('Just a body.', ['', '   ', '\n'])).toBe('Just a body.');
  });

  it('returns undefined when both body and criteria are absent', () => {
    expect(composeDescription(undefined, undefined)).toBeUndefined();
    expect(composeDescription(undefined, [])).toBeUndefined();
  });

  it('is idempotent: composing twice yields a byte-identical string', () => {
    const once = composeDescription('Body.', ['One', 'Two']);
    const twice = composeDescription(once, ['One', 'Two']);

    expect(twice).toBe(once);
    expect(occurrences(twice ?? '', CRITERIA_MARKER_START)).toBe(1);
    expect(occurrences(twice ?? '', CRITERIA_MARKER_END)).toBe(1);
  });

  it('replaces the region in place when criteria change (old gone, new present, one region)', () => {
    const first = composeDescription('Body.', ['Old one', 'Old two']);
    const second = composeDescription(first, ['New one']);

    expect(second).toContain('- [ ] New one');
    expect(second).not.toContain('Old one');
    expect(second).not.toContain('Old two');
    // Body survives the rebuild and exactly one region remains.
    expect(second).toContain('Body.');
    expect(occurrences(second ?? '', CRITERIA_MARKER_START)).toBe(1);
    expect(occurrences(second ?? '', CRITERIA_MARKER_END)).toBe(1);
    expect(second).toBe('Body.\n\n' + renderCriteriaChecklist(['New one']));
  });

  it('strips a stale marked region when all criteria are removed', () => {
    const withChecklist = composeDescription('Body.', ['Will be removed']);
    const cleared = composeDescription(withChecklist, []);

    expect(cleared).toBe('Body.');
    expect(cleared).not.toContain(CRITERIA_MARKER_START);
    expect(cleared).not.toContain(CRITERIA_MARKER_END);
    expect(cleared).not.toContain('Will be removed');
  });
});

/**
 * Adversarial idempotency guards for {@link composeDescription} (TER-21). These
 * pin the failure modes a naive region rebuild is prone to: a criterion whose
 * text contains a marker literal (which would let the region regex terminate
 * early and grow the block on every re-sync), bodies whose spacing differs from
 * the canonical `\n\n` separator, a body that is *only* a region (the realistic
 * re-sync input), multiple stale regions, and the no-op contract that a
 * region-free body must round-trip byte-identical so the field is unchanged from
 * before this ticket.
 */
describe('composeDescription — TER-21 idempotency guards', () => {
  it('stays idempotent when a criterion contains a marker literal', () => {
    const evil = `breaks ${CRITERIA_MARKER_END} the region ${CRITERIA_MARKER_START}`;
    const once = composeDescription('Body.', [evil]);
    const twice = composeDescription(once, [evil]);
    const thrice = composeDescription(twice, [evil]);

    // No growth across re-syncs, and exactly one real region survives.
    expect(twice).toBe(once);
    expect(thrice).toBe(once);
    expect(occurrences(once ?? '', CRITERIA_MARKER_START)).toBe(1);
    expect(occurrences(once ?? '', CRITERIA_MARKER_END)).toBe(1);
    // The neutralized marker still clears cleanly when criteria are removed.
    expect(composeDescription(once, [])).toBe('Body.');
  });

  it('normalizes a body with trailing whitespace to a single blank-line separator', () => {
    const once = composeDescription('Body with trailing.\n\n\n', ['One']);
    const twice = composeDescription(once, ['One']);

    expect(once).toBe(`Body with trailing.\n\n${renderCriteriaChecklist(['One'])}`);
    expect(twice).toBe(once);
  });

  it('collapses a region-only body to the bare block with no leading whitespace', () => {
    const regionOnly = renderCriteriaChecklist(['Old']);
    const rebuilt = composeDescription(regionOnly, ['New']);

    // No body text means the block stands alone — no leaked leading "\n\n".
    expect(rebuilt).toBe(renderCriteriaChecklist(['New']));
    expect(composeDescription(rebuilt, ['New'])).toBe(rebuilt);
  });

  it('strips every stale region, leaving exactly one when criteria are present', () => {
    const block = renderCriteriaChecklist(['Current']);
    const doubled = `Body.\n\n${renderCriteriaChecklist(['A'])}\n\n${renderCriteriaChecklist(['B'])}`;

    expect(composeDescription(doubled, ['Current'])).toBe(`Body.\n\n${block}`);
    expect(composeDescription(doubled, [])).toBe('Body.');
  });

  it('round-trips a region-free body byte-identical when criteria are absent (no-op)', () => {
    const trailingNewlines = 'Body text.\n\n';
    const trailingSpaces = 'Trailing spaces.   ';

    // Same reference / byte-identical: the pre-TER-21 description is untouched.
    expect(composeDescription(trailingNewlines, undefined)).toBe(trailingNewlines);
    expect(composeDescription(trailingSpaces, [])).toBe(trailingSpaces);
    expect(composeDescription('   \n  ', undefined)).toBe('   \n  ');
  });
});
