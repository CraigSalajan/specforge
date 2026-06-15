import * as crypto from 'node:crypto';

/**
 * SHA-256 hex digest of a UTF-8 string. Shared content-hash helper used by the
 * indexer (file content hashing) and the PM-integration push path
 * (SyncLink.lastPushedHash — "changed since last push" detection).
 */
export function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
