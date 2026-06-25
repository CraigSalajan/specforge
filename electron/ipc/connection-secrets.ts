/**
 * IPC seam for per-connection PM credentials (TER-28).
 *
 * The renderer can *write*, *clear*, and *poll the presence of* a connection's
 * credential — but never read it back. `Set` returns `void`, `Status` returns a
 * bare boolean, and there is no get channel: the token is read main-side only
 * (the sync orchestrator's `connectionTokenSource`), so it never re-enters
 * renderer memory. Mirrors the validate-then-`ipcMain.handle` structure of
 * `./settings`.
 */

import { ipcMain } from 'electron';
import {
  createConnectionSecrets,
  type ConnectionSecretKind,
} from '../sync/connection-secrets';
import { secretSettingsStore } from './settings-secret-store';

const secrets = createConnectionSecrets(secretSettingsStore);

const Channels = {
  Set: 'specforge:connection-secret-set',
  Clear: 'specforge:connection-secret-clear',
  Status: 'specforge:connection-secret-status',
} as const;

function assertConnectionId(connectionId: unknown): asserts connectionId is string {
  if (typeof connectionId !== 'string' || connectionId.length === 0 || connectionId.length > 256) {
    throw new Error('Invalid connection id');
  }
}

function assertKind(kind: unknown): asserts kind is ConnectionSecretKind {
  if (kind !== 'pat' && kind !== 'refreshToken') {
    throw new Error('Invalid connection secret kind');
  }
}

function assertToken(token: unknown): asserts token is string {
  if (typeof token !== 'string') {
    throw new Error('Connection secret token must be a string');
  }
}

export function registerConnectionSecretHandlers(): void {
  ipcMain.handle(
    Channels.Set,
    async (_e, connectionId: string, kind: ConnectionSecretKind, token: string): Promise<void> => {
      assertConnectionId(connectionId);
      assertKind(kind);
      assertToken(token);
      // Persists encrypted; never echoes the token back to the renderer.
      secrets.setConnectionToken(connectionId, kind, token);
    },
  );

  ipcMain.handle(Channels.Clear, async (_e, connectionId: string): Promise<void> => {
    assertConnectionId(connectionId);
    secrets.deleteConnectionSecrets(connectionId);
  });

  ipcMain.handle(
    Channels.Status,
    async (_e, connectionId: string, kind: ConnectionSecretKind): Promise<boolean> => {
      assertConnectionId(connectionId);
      assertKind(kind);
      // Presence only — the credential value is never returned to the renderer.
      return secrets.hasConnectionToken(connectionId, kind);
    },
  );
}
