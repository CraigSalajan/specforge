import { describe, expect, it } from 'vitest';
import {
  dedupeTags,
  normalizeLabelName,
} from '../../../electron/sync/linear/labels';

/**
 * Unit tests for the pure label-name helpers (TER-22). These functions own the
 * single definition of "the same Linear label" used by the adapter's seed/match
 * code, so the matching rules (trim + lowercase, de-dupe by normalized key, drop
 * empties, preserve first-seen order and original casing) are pinned here.
 */
describe('normalizeLabelName', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeLabelName('  bug  ')).toBe('bug');
  });

  it('lower-cases the name', () => {
    expect(normalizeLabelName('Bug')).toBe('bug');
    expect(normalizeLabelName('HIGH PRIORITY')).toBe('high priority');
  });

  it('trims and lower-cases together', () => {
    expect(normalizeLabelName('  In Progress  ')).toBe('in progress');
  });

  it('normalizes a whitespace-only name to an empty key', () => {
    expect(normalizeLabelName('   ')).toBe('');
  });
});

describe('dedupeTags', () => {
  it('drops entries whose normalized key has already been seen', () => {
    expect(dedupeTags(['bug', 'Bug', ' BUG '])).toEqual(['bug']);
  });

  it('preserves first-seen order and the first occurrence original casing', () => {
    expect(dedupeTags(['Bug', 'feature', 'bug', 'Feature'])).toEqual(['Bug', 'feature']);
  });

  it('drops empty and whitespace-only entries', () => {
    expect(dedupeTags(['', '   ', 'bug'])).toEqual(['bug']);
  });

  it('returns an empty array for an empty input', () => {
    expect(dedupeTags([])).toEqual([]);
  });

  it('keeps distinct tags untouched', () => {
    expect(dedupeTags(['alpha', 'beta', 'gamma'])).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('treats names differing only by surrounding whitespace as duplicates', () => {
    expect(dedupeTags(['  spike', 'spike  '])).toEqual(['  spike']);
  });
});
