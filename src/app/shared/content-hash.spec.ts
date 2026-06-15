import { describe, expect, it } from 'vitest';
import { sha256 } from '../../../electron/util/hash';

describe('sha256', () => {
  it('matches known SHA-256 vectors', () => {
    expect(sha256('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('is deterministic for the same input', () => {
    expect(sha256('the quick brown fox')).toBe(sha256('the quick brown fox'));
  });

  it('produces different digests for different inputs', () => {
    expect(sha256('a')).not.toBe(sha256('b'));
  });

  it('returns a 64-char lowercase hex string', () => {
    expect(sha256('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});
