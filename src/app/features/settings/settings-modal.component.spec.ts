import { describe, expect, it, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';

import { SettingsModalComponent } from './settings-modal.component';
import { SettingsService } from '../../core/settings.service';
import { IpcService } from '../../core/ipc.service';
import { SyncService, SyncError } from '../../core/sync.service';
import { VaultService } from '../../core/vault.service';
import { UiStateService } from '../../core/ui-state.service';
import { IndexService } from '../../core/index.service';
import { EmbeddingIndexerService } from '../ai/providers/indexing.service';
import { ToolRegistryService } from '../ai/tools/tool-registry.service';
import { SkillRegistryService } from '../ai/skills/skill-registry.service';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/types';
import type { LinearTeam, LinearProject } from '../../shared/types';
import type { ProjectMetadata } from '../../../../electron/sync/adapter';
import {
  makeConnectionId,
  type Connection,
  type LinearConnection,
} from '../../../../electron/sync/connection';

const VAULT = '/vault';

const TEAMS: LinearTeam[] = [
  { id: 'team-1', key: 'ENG', name: 'Engineering' },
  { id: 'team-2', key: 'DES', name: 'Design' },
];

const PROJECTS: LinearProject[] = [
  { id: 'proj-1', name: 'Platform' },
  { id: 'proj-2', name: 'Mobile' },
];

const METADATA: ProjectMetadata = {
  provider: 'linear',
  projectId: 'proj-1',
  projectName: 'Platform',
  supportedLevels: ['epic', 'feature', 'story', 'criterion'],
  labels: [
    { id: 'label-1', name: 'feature', isGroup: false },
    { id: 'group-1', name: 'Theme', isGroup: true },
  ],
};

/**
 * A reactive fake SettingsService backed by an in-memory `pm.connections` map,
 * mirroring the real save/remove semantics (including the immediate secret clear
 * on remove, which we record).
 */
class FakeSettingsService {
  private readonly _settings = signal<Settings>({ ...DEFAULT_SETTINGS });
  readonly settings = this._settings.asReadonly();
  readonly saving = signal(false).asReadonly();
  readonly vaultPath = signal<string | null>(VAULT);

  readonly saveConnection = vi.fn(async (vaultPath: string, conn: Connection) => {
    const map = this._settings()['pm.connections'];
    const current = map[vaultPath] ?? [];
    const exists = current.some((c) => c.connectionId === conn.connectionId);
    const nextList = exists
      ? current.map((c) => (c.connectionId === conn.connectionId ? conn : c))
      : [...current, conn];
    this._settings.update((s) => ({
      ...s,
      'pm.connections': { ...map, [vaultPath]: nextList },
    }));
  });

  readonly removeConnection = vi.fn(async (vaultPath: string, connectionId: string) => {
    const map = this._settings()['pm.connections'];
    const current = map[vaultPath] ?? [];
    const nextList = current.filter((c) => c.connectionId !== connectionId);
    const next = { ...map };
    if (nextList.length > 0) next[vaultPath] = nextList;
    else delete next[vaultPath];
    this._settings.update((s) => ({ ...s, 'pm.connections': next }));
  });

  connectionsForVault(vaultPath: string): Connection[] {
    return this._settings()['pm.connections'][vaultPath] ?? [];
  }

  /** Test helper to seed a connection without going through saveConnection. */
  seedConnection(vaultPath: string, conn: Connection): void {
    this._settings.update((s) => ({
      ...s,
      'pm.connections': { ...s['pm.connections'], [vaultPath]: [conn] },
    }));
  }
}

class FakeVaultService {
  readonly vaultPath = signal<string | null>(VAULT);
  readonly hasVault = signal(true);
}

function makeIpc() {
  return {
    isAvailable: true,
    connectionSecretSet: vi.fn(async () => undefined),
    connectionSecretClear: vi.fn(async () => undefined),
    connectionSecretStatus: vi.fn(async () => false),
  };
}

function makeSync() {
  return {
    listTeams: vi.fn(async () => TEAMS),
    listProjects: vi.fn(async () => PROJECTS),
    testConnection: vi.fn(async () => METADATA),
  };
}

function setup(overrides?: { ipc?: ReturnType<typeof makeIpc>; sync?: ReturnType<typeof makeSync> }) {
  const settings = new FakeSettingsService();
  const vault = new FakeVaultService();
  const ipc = overrides?.ipc ?? makeIpc();
  const sync = overrides?.sync ?? makeSync();

  TestBed.configureTestingModule({
    providers: [
      { provide: SettingsService, useValue: settings },
      { provide: VaultService, useValue: vault },
      { provide: IpcService, useValue: ipc },
      { provide: SyncService, useValue: sync },
      { provide: UiStateService, useValue: { settingsOpen: signal(false), closeSettings: vi.fn() } },
      {
        provide: IndexService,
        useValue: { status: signal({ indexedFiles: 0, totalChunks: 0, lastIndexedAt: null }), isIndexing: signal(false) },
      },
      {
        provide: EmbeddingIndexerService,
        useValue: { progress: signal({ status: 'idle', processed: 0, total: 0 }), isRunning: signal(false) },
      },
      { provide: ToolRegistryService, useValue: { list: () => [] } },
      { provide: SkillRegistryService, useValue: { skills: signal([]), reload: vi.fn(async () => undefined) } },
    ],
  });

  const fixture = TestBed.createComponent(SettingsModalComponent);
  const component = fixture.componentInstance;
  // Flush the constructor effects (vault-switch reload) so the initial transient
  // state settles before the test drives the component. The modal is closed
  // (settingsOpen=false), so the open-reset block does not run.
  fixture.detectChanges();
  return { component, fixture, settings, vault, ipc, sync };
}

/** Lets queued microtasks (awaited IPC/sync promises) settle. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('SettingsModalComponent — Integrations (TER-31)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  describe('connectLinear', () => {
    it('populates teams and sets status connected on success', async () => {
      const { component, sync } = setup();
      // Set the PAT via the public input handler.
      component.onPatInput('lin_api_token');

      await component.connectLinear();

      expect(sync.listTeams).toHaveBeenCalledWith('lin_api_token');
      expect(component.teams()).toEqual(TEAMS);
      expect(component.intStatus()).toBe('connected');
      expect(component.intError()).toBeNull();
    });

    it('sets status error and message on failure', async () => {
      const sync = makeSync();
      sync.listTeams.mockRejectedValueOnce(
        new SyncError({ code: 'auth', message: 'Unauthorized', retryable: false }),
      );
      const { component } = setup({ sync });
      component.onPatInput('bad-token');

      await component.connectLinear();

      expect(component.intStatus()).toBe('error');
      expect(component.intError()).toBe('Unauthorized');
      expect(component.teams()).toEqual([]);
    });

    it('does nothing when the PAT is empty', async () => {
      const { component, sync } = setup();
      await component.connectLinear();
      expect(sync.listTeams).not.toHaveBeenCalled();
    });
  });

  describe('onSelectTeam', () => {
    it('discovers projects when a PAT is present', async () => {
      const { component, sync } = setup();
      component.onPatInput('lin_api_token');

      await component.onSelectTeam('team-1');

      expect(sync.listProjects).toHaveBeenCalledWith('lin_api_token', 'team-1');
      expect(component.projects()).toEqual(PROJECTS);
      expect(component.intForm().teamId).toBe('team-1');
    });
  });

  describe('saveLinear', () => {
    it('computes the connectionId and calls saveConnection + connectionSecretSet + testConnection, then populates labels', async () => {
      const { component, settings, ipc, sync } = setup();
      component.onPatInput('lin_api_token');
      await component.connectLinear();
      await component.onSelectTeam('team-1');
      component.onSelectProject('proj-1');

      await component.saveLinear();

      const expectedId = makeConnectionId({
        vaultPath: VAULT,
        provider: 'linear',
        teamId: 'team-1',
        projectId: 'proj-1',
      });

      // saveConnection persisted the right connection.
      expect(settings.saveConnection).toHaveBeenCalledTimes(1);
      const savedConn = settings.saveConnection.mock.calls[0][1] as LinearConnection;
      expect(savedConn.connectionId).toBe(expectedId);
      expect(savedConn.teamId).toBe('team-1');
      expect(savedConn.projectId).toBe('proj-1');
      expect(savedConn.enabled).toBe(true);
      expect(savedConn.authMode).toBe('pat');

      // The PAT was stored under that id.
      expect(ipc.connectionSecretSet).toHaveBeenCalledWith(expectedId, 'pat', 'lin_api_token');
      // And testConnection validated the same id.
      expect(sync.testConnection).toHaveBeenCalledWith(expectedId);

      // Labels populated, label GROUPS filtered out.
      expect(component.labels().map((l) => l.id)).toEqual(['label-1']);
      expect(component.intStatus()).toBe('connected');
    });

    it('aborts a brand-new save when no PAT is entered (no credential-less connection)', async () => {
      const { component, settings, ipc, sync } = setup();
      // A team is selected but the PAT field is left empty and none is configured.
      await component.onSelectTeam('team-1');

      await component.saveLinear();

      // Nothing was persisted and validation never ran.
      expect(settings.saveConnection).not.toHaveBeenCalled();
      expect(ipc.connectionSecretSet).not.toHaveBeenCalled();
      expect(sync.testConnection).not.toHaveBeenCalled();
      expect(component.intStatus()).toBe('error');
      expect(component.intError()).toContain('Personal Access Token');
    });

    it('aborts an identity change when no fresh PAT is entered (keeps the old connection)', async () => {
      const ipc = makeIpc();
      // The existing connection has a stored token, but the id is about to churn.
      ipc.connectionSecretStatus.mockResolvedValue(true);
      const { component, settings, sync } = setup({ ipc });
      const oldId = makeConnectionId({ vaultPath: VAULT, provider: 'linear', teamId: 'team-1' });
      settings.seedConnection(VAULT, {
        connectionId: oldId,
        provider: 'linear',
        enabled: true,
        authMode: 'pat',
        teamId: 'team-1',
      });

      // Switch teams (churns the id) WITHOUT entering a new PAT.
      await component.onSelectTeam('team-2');
      await component.saveLinear();

      // The old connection must NOT be removed and no new one saved, since the
      // write-only token can't be carried to the new id.
      expect(settings.removeConnection).not.toHaveBeenCalled();
      expect(settings.saveConnection).not.toHaveBeenCalled();
      expect(sync.testConnection).not.toHaveBeenCalled();
      expect(component.intStatus()).toBe('error');
    });

    it('removes the old connection (clearing its secret) when the teamId changes', async () => {
      const { component, settings } = setup();
      // Seed an existing connection for team-1 / no project.
      const oldId = makeConnectionId({ vaultPath: VAULT, provider: 'linear', teamId: 'team-1' });
      settings.seedConnection(VAULT, {
        connectionId: oldId,
        provider: 'linear',
        enabled: true,
        authMode: 'pat',
        teamId: 'team-1',
      });

      component.onPatInput('lin_api_token');
      // Switch to team-2.
      await component.onSelectTeam('team-2');
      await component.saveLinear();

      const newId = makeConnectionId({ vaultPath: VAULT, provider: 'linear', teamId: 'team-2' });
      expect(newId).not.toBe(oldId);
      // The old connection was removed (which clears its stored secret).
      expect(settings.removeConnection).toHaveBeenCalledWith(VAULT, oldId);
      // The new connection was saved.
      const savedConn = settings.saveConnection.mock.calls.at(-1)?.[1] as LinearConnection;
      expect(savedConn.connectionId).toBe(newId);
    });
  });

  describe('disconnectLinear', () => {
    it('removes the active connection and resets the sub-draft', async () => {
      const { component, settings } = setup();
      const id = makeConnectionId({ vaultPath: VAULT, provider: 'linear', teamId: 'team-1' });
      settings.seedConnection(VAULT, {
        connectionId: id,
        provider: 'linear',
        enabled: true,
        authMode: 'pat',
        teamId: 'team-1',
      });

      await component.disconnectLinear();

      expect(settings.removeConnection).toHaveBeenCalledWith(VAULT, id);
      expect(component.intForm().teamId).toBe('');
      expect(component.intStatus()).toBe('idle');
      expect(component.teams()).toEqual([]);
    });
  });

  describe('OAuth button', () => {
    it('renders the OAuth Connect button disabled with a coming-soon caption', () => {
      const settings = new FakeSettingsService();
      const vault = new FakeVaultService();
      const settingsOpen = signal(true);
      TestBed.configureTestingModule({
        providers: [
          { provide: SettingsService, useValue: settings },
          { provide: VaultService, useValue: vault },
          { provide: IpcService, useValue: makeIpc() },
          { provide: SyncService, useValue: makeSync() },
          { provide: UiStateService, useValue: { settingsOpen, closeSettings: vi.fn() } },
          {
            provide: IndexService,
            useValue: { status: signal({ indexedFiles: 0, totalChunks: 0, lastIndexedAt: null }), isIndexing: signal(false) },
          },
          {
            provide: EmbeddingIndexerService,
            useValue: { progress: signal({ status: 'idle', processed: 0, total: 0 }), isRunning: signal(false) },
          },
          { provide: ToolRegistryService, useValue: { list: () => [] } },
          { provide: SkillRegistryService, useValue: { skills: signal([]), reload: vi.fn(async () => undefined) } },
        ],
      });

      const fixture = TestBed.createComponent(SettingsModalComponent);
      // First detect: the open effect runs and forces the active section to
      // 'workspace'. Switch to 'integrations' after, then re-render.
      fixture.detectChanges();
      fixture.componentInstance.activeSection.set('integrations');
      fixture.detectChanges();

      const buttons = Array.from(
        fixture.nativeElement.querySelectorAll('button'),
      ) as HTMLButtonElement[];
      const oauthBtn = buttons.find((b) => /OAuth/i.test(b.textContent ?? ''));
      expect(oauthBtn).toBeDefined();
      expect(oauthBtn?.disabled).toBe(true);

      const text = (fixture.nativeElement.textContent ?? '') as string;
      expect(text).toContain('OAuth — coming soon (TER-33)');
    });
  });

  describe('vault switch', () => {
    it('reloads the visible connection and resets transient state when the vault changes', async () => {
      const ipc = makeIpc();
      ipc.connectionSecretStatus.mockResolvedValue(true);
      const { component, settings, vault } = setup({ ipc });

      // Seed a connection only for a second vault.
      const otherVault = '/other-vault';
      const otherId = makeConnectionId({ vaultPath: otherVault, provider: 'linear', teamId: 'team-9' });
      settings.seedConnection(otherVault, {
        connectionId: otherId,
        provider: 'linear',
        enabled: true,
        authMode: 'pat',
        teamId: 'team-9',
        projectId: 'proj-9',
      });

      // Put transient state on the first vault, then switch.
      component.onPatInput('stale');
      vault.vaultPath.set(otherVault);
      // Flush the vault-switch effect, then let async loadIntegrationConnection
      // (connectionSecretStatus) settle.
      TestBed.tick();
      await flushMicrotasks();

      // PAT input reset on switch; the other vault's connection is now visible.
      expect(component.pat()).toBe('');
      expect(component.intForm().teamId).toBe('team-9');
      expect(component.intForm().projectId).toBe('proj-9');
      expect(component.patConfigured()).toBe(true);
    });
  });
});
