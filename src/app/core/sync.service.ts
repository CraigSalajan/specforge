import { Injectable, inject } from '@angular/core';
import { IpcService } from './ipc.service';
import type { AiErrorInfo, LinearOAuthBeginData, SyncPreviewData } from '../shared/types';
import type {
  LinearProject,
  LinearTeam,
  ProjectMetadata,
} from '../../../electron/sync/adapter';
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

  /**
   * Discover the teams a PAT can see (TER-31) — validates the PAT as a side
   * effect (an invalid/unauthorized token throws {@link SyncError} with an
   * `auth` code). Resolves the {@link LinearTeam}[] on success.
   *
   * SECURITY: the PAT crosses IPC for discovery only and is never logged,
   * persisted, or returned by the main-side handler — see `IpcService.syncListTeams`.
   */
  async listTeams(pat: string): Promise<LinearTeam[]> {
    const res = await this.ipc.syncListTeams(pat);
    if (!res.ok) throw new SyncError(res.error);
    return res.data;
  }

  /**
   * Discover the projects under a team for a PAT (TER-31). Resolves the
   * {@link LinearProject}[] on success, or throws {@link SyncError} on failure.
   */
  async listProjects(pat: string, teamId: string): Promise<LinearProject[]> {
    const res = await this.ipc.syncListProjects(pat, teamId);
    if (!res.ok) throw new SyncError(res.error);
    return res.data;
  }

  /**
   * Begin the Linear OAuth2 (auth-code + PKCE) flow (TER-33): opens the system
   * browser, captures the redirect main-side, exchanges the code, and discovers
   * teams. Resolves `{ sessionId, teams }` — NO token crosses the boundary —
   * or throws {@link SyncError} on failure (including a user-denied/timed-out flow).
   */
  async oauthBegin(): Promise<LinearOAuthBeginData> {
    const res = await this.ipc.linearOAuthBegin();
    if (!res.ok) throw new SyncError(res.error);
    return res.data;
  }

  /**
   * Discover the projects under a team for an in-flight OAuth session (TER-33).
   * Mirrors {@link listProjects} but authenticates from the pending session's
   * access token main-side instead of a PAT.
   */
  async oauthListProjects(sessionId: string, teamId: string): Promise<LinearProject[]> {
    const res = await this.ipc.linearOAuthListProjects(sessionId, teamId);
    if (!res.ok) throw new SyncError(res.error);
    return res.data;
  }

  /**
   * Complete the OAuth flow by binding the session's refresh token to a
   * `connectionId` (persisted + cached main-side). Resolves on success or throws
   * {@link SyncError} on failure.
   */
  async oauthComplete(sessionId: string, connectionId: string): Promise<void> {
    const res = await this.ipc.linearOAuthComplete(sessionId, connectionId);
    if (!res.ok) throw new SyncError(res.error);
  }

  /**
   * Revoke the stored refresh token for an OAuth connection (TER-33), called
   * before clearing the secret on disconnect. Resolves on success or throws
   * {@link SyncError} on failure.
   */
  async oauthRevoke(connectionId: string): Promise<void> {
    const res = await this.ipc.linearOAuthRevoke(connectionId);
    if (!res.ok) throw new SyncError(res.error);
  }
}
