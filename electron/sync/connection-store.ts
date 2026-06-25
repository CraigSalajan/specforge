/**
 * Main-process read API for persisted PM connections — the seam the sync
 * orchestrator (TER-29) uses to discover *where* a vault syncs to.
 *
 * Connections are stored as the `pm.connections` setting (a JSON object keyed by
 * vault path → {@link Connection}[]), written by the renderer's
 * `settings.service.ts`. Because a connection is **non-secret** (target/config
 * only — see {@link ./connection}), reading it through the plain `settings.repo`
 * path is correct here; credentials, by contrast, travel the encrypted IPC path
 * added in TER-28 and are never read from this module.
 *
 * This module is intentionally main-only (it imports the DB repo). The pure,
 * renderer-safe pieces (the {@link Connection} model, validators, id/config
 * helpers) live in {@link ./connection}.
 *
 * @see ./connection for the connection model and {@link parseConnectionsMap}.
 */

import { getSetting } from '../db/repositories/settings.repo';
import { parseConnectionsMap, type Connection } from './connection';

const PM_CONNECTIONS_KEY = 'pm.connections';

/**
 * Reads the persisted, validated connections for `vaultPath`. Returns `[]` when
 * the setting is unset, fails to parse, or holds no valid connection for the
 * vault — defensive in the same spirit as {@link parseConnectionsMap}, so a
 * malformed store never throws into the orchestrator.
 */
export function readConnectionsForVault(vaultPath: string): Connection[] {
  const raw = getSetting(PM_CONNECTIONS_KEY);
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  return parseConnectionsMap(parsed)[vaultPath] ?? [];
}

/**
 * Finds a single connection by `connectionId` within `vaultPath`, or `undefined`
 * when no connection with that id is configured for the vault.
 */
export function readConnection(
  vaultPath: string,
  connectionId: string,
): Connection | undefined {
  return readConnectionsForVault(vaultPath).find((c) => c.connectionId === connectionId);
}
