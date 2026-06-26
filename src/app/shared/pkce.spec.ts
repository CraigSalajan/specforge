import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  base64UrlEncode,
  deriveCodeChallenge,
  generateCodeVerifier,
  generateState,
} from '../../../electron/sync/linear/oauth/pkce';

/**
 * Unit tests for the PKCE helpers (TER-33). These run on Node (Vitest), so
 * `node:crypto` resolves directly — the module is main-only by construction, but
 * exercising it here proves the verifier/challenge/state derivation without any
 * Electron or DB dependency. The `auth.ts` constants module remains node-free; the
 * crypto lives only here, so the renderer's jsdom client spec is unaffected.
 */

/** base64url must contain only the URL-safe alphabet with no padding. */
const BASE64URL_RE = /^[A-Za-z0-9\-_]+$/;

describe('base64UrlEncode', () => {
  it('produces URL-safe base64 with no padding (+→-, /→_, no =)', () => {
    // 0xFB 0xFF 0xBF encodes to "+/+/" in standard base64 → "-_-_" in base64url.
    const encoded = base64UrlEncode(Buffer.from([0xfb, 0xff, 0xbf]));
    expect(encoded).toBe('-_-_');
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
  });
});

describe('generateCodeVerifier', () => {
  it('is base64url and the expected length for 32 random bytes (43 chars)', () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(BASE64URL_RE);
    // 32 bytes → ceil(32/3)*4 = 44 base64 chars, minus 1 stripped '=' pad = 43.
    expect(verifier).toHaveLength(43);
    // Within the RFC 7636 bound of 43–128 characters.
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('is unique across calls (high entropy)', () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });
});

describe('deriveCodeChallenge', () => {
  it('matches the RFC 7636 Appendix B S256 vector', () => {
    // The canonical PKCE example from RFC 7636: this exact verifier hashes to
    // this exact challenge under base64url(SHA-256(verifier)).
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = deriveCodeChallenge(verifier);
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('equals base64url(SHA-256(verifier)) for a generated verifier', () => {
    const verifier = generateCodeVerifier();
    const expected = base64UrlEncode(createHash('sha256').update(verifier).digest());
    expect(deriveCodeChallenge(verifier)).toBe(expected);
    expect(deriveCodeChallenge(verifier)).toMatch(BASE64URL_RE);
  });
});

describe('generateState', () => {
  it('is base64url and unique across calls', () => {
    const a = generateState();
    const b = generateState();
    expect(a).toMatch(BASE64URL_RE);
    expect(b).toMatch(BASE64URL_RE);
    expect(a).not.toBe(b);
  });
});
