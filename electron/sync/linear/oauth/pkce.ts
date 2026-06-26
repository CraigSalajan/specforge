/**
 * PKCE (Proof Key for Code Exchange) helpers for the Linear OAuth2
 * authorization-code flow (TER-33).
 *
 * Linear is a **public** desktop client, so it authenticates with PKCE rather
 * than a client secret: the app generates a high-entropy `code_verifier`, sends
 * its SHA-256 hash (`code_challenge`, method `S256`) on the authorize request,
 * and proves possession by replaying the original verifier on the token
 * exchange. An attacker who intercepts the authorization `code` cannot exchange
 * it without the verifier, which never leaves the app.
 *
 * ## Main-only by construction
 * This module imports `node:crypto`, so it is main-process only and is NEVER
 * imported by the renderer's jsdom spec bundle. The electron-free `auth.ts`
 * keeps holding only string constants; all crypto lives here. The functions are
 * small and deterministic-where-possible (the base64url encoder is pure and is
 * exported so the unit test can pin it to a known SHA-256 vector).
 */

import { createHash, randomBytes } from 'node:crypto';

/** Bytes of entropy for the code verifier — 32 bytes → 43-char base64url string. */
const VERIFIER_BYTES = 32;

/** Bytes of entropy for the CSRF `state` parameter. */
const STATE_BYTES = 32;

/**
 * Encodes a buffer as **base64url** (RFC 4648 §5): standard base64 with `+`→`-`,
 * `/`→`_`, and the `=` padding stripped. This is the encoding OAuth/PKCE
 * mandates for both the verifier and the challenge. Pure and exported so tests
 * can assert it against a known vector.
 */
export function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generates a cryptographically-random PKCE `code_verifier`: 32 random bytes
 * encoded as base64url (a 43-character string, comfortably within the
 * spec's 43–128 char bound). Keep the returned value in memory only for the
 * duration of the flow; it is the secret PKCE proves possession of.
 */
export function generateCodeVerifier(): string {
  return base64UrlEncode(randomBytes(VERIFIER_BYTES));
}

/**
 * Derives the `code_challenge` from a `code_verifier` using the `S256` method:
 * `base64url(SHA-256(verifier))`. The challenge is the value sent on the
 * authorize request; the verifier is replayed (unhashed) on the token exchange.
 */
export function deriveCodeChallenge(verifier: string): string {
  return base64UrlEncode(createHash('sha256').update(verifier).digest());
}

/**
 * Generates a random, single-use CSRF `state` value. It is sent on the
 * authorize request and compared against the value returned to the loopback
 * redirect; a mismatch means the callback did not originate from our request and
 * is rejected.
 */
export function generateState(): string {
  return base64UrlEncode(randomBytes(STATE_BYTES));
}
