import { Injectable, inject } from '@angular/core';
import { IpcService } from './ipc.service';
import type { AiErrorInfo, SyncPreviewData } from '../shared/types';
import type { ProjectMetadata } from '../../../electron/sync/adapter';
import type { Connection } from '../../../electron/sync/connection';
import type { PushResult } from '../../../electron/sync/executor';

/**
 * Error thrown by {@link SyncService} when a sync action channel returns a
 * `{ ok: false, error }` envelope. It carries the structured {@link AiErrorInfo}
 * (`code`, `status?`, `retryable`, `message`) so callers can branch on the
 * classification — e.g. surface a retry affordance only when `retryable` — rather
 * than re-parsing a string.
 */
export class SyncError extends Error {
  constructor(readonly info: AiErrorInfo) {
    super(info.message);
    this.name = 'SyncError';
  }
}

/**
 * Renderer-facing domain service for the sync engine (TER-30).
 *
 * Wraps the {@link IpcService} sync wrappers with ergonomic methods that UNWRAP
 * the result envelope: each action resolves to its `data` on `ok` and throws a
 * {@link SyncError} carrying the structured error info on `!ok`. Only a
 * `connectionId`/`vaultPath` ever crosses the IPC boundary — credentials are
 * resolved main-side, so no method here accepts or returns a token.
 *
 * Connection *persistence* (save/delete) is deliberately NOT here: it lives in
 * the reactive `SettingsService`, which owns the `pm.connections` signal. This
 * service covers only the sync reads/actions.
 */
@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly ipc = inject(IpcService);

  /**
   * Test a connection by fetching its target project's metadata. Resolves the
   * non-secret {@link ProjectMetadata}, or throws {@link SyncError} on failure.
   */
  async testConnection(connectionId: string): Promise<ProjectMetadata> {
    const res = await this.ipc.syncTestConnection(connectionId);
    if (!res.ok) throw new SyncError(res.error);
    return res.data;
  }

  /**
   * Build the read-only push preview (the approval surface) for a connection.
   * Resolves `{ provider, preview }`, or throws {@link SyncError} on failure.
   */
  async buildPreview(connectionId: string): Promise<SyncPreviewData> {
    const res = await this.ipc.syncBuildPreview(connectionId);
    if (!res.ok) throw new SyncError(res.error);
    return res.data;
  }

  /**
   * Execute the push for a connection (the renderer preview is the approval gate).
   * Resolves the {@link PushResult}, or throws {@link SyncError} on failure.
   */
  async executePush(connectionId: string): Promise<PushResult> {
    const res = await this.ipc.syncExecutePush(connectionId);
    if (!res.ok) throw new SyncError(res.error);
    // `data` is `null` only when a gate declines; the renderer preview is the
    // gate here, so the default-approve path always yields a concrete result.
    if (res.data === null) {
      throw new SyncError({ code: 'unknown', message: 'Push was not executed', retryable: false });
    }
    return res.data;
  }

  /** List the persisted connections for a vault (a bare read, no envelope). */
  listConnections(vaultPath: string): Promise<Connection[]> {
    return this.ipc.syncConnectionList(vaultPath);
  }
}
