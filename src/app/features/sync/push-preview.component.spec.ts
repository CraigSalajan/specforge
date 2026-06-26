import { describe, expect, it, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';

import { PushPreviewComponent } from './push-preview.component';
import { SettingsService } from '../../core/settings.service';
import { VaultService } from '../../core/vault.service';
import { SyncService, SyncError } from '../../core/sync.service';
import { IpcService } from '../../core/ipc.service';
import { UiStateService } from '../../core/ui-state.service';
import { DEFAULT_SETTINGS, type Settings, type SyncPreviewData } from '../../shared/types';
import type { LinearConnection } from '../../../../electron/sync/connection';
import type { PushPreviewTree, PreviewNode } from '../../../../electron/sync/preview';
import type { PushResult } from '../../../../electron/sync/executor';

const VAULT = '/vault';

const CONNECTION: LinearConnection = {
  connectionId: 'linear-abc123',
  provider: 'linear',
  enabled: true,
  authMode: 'pat',
  teamId: 'team-1',
};

function node(partial: Partial<PreviewNode> & Pick<PreviewNode, 'localId' | 'decision'>): PreviewNode {
  return {
    level: 'story',
    provider: 'linear',
    nativeType: 'Issue',
    representation: 'item',
    title: partial.localId,
    summary: { hasDescription: false, criteriaCount: 0, tagCount: 0 },
    inCycle: false,
    children: [],
    ...partial,
  };
}

/** A two-level tree: one create epic with a child create story and a sibling update. */
const PREVIEW_TREE: PushPreviewTree = {
  roots: [
    node({
      localId: 'epic-1',
      decision: 'create',
      level: 'epic',
      nativeType: 'Project',
      title: 'Checkout revamp',
      summary: { hasDescription: true, criteriaCount: 2, tagCount: 1 },
      children: [
        node({ localId: 'story-1', decision: 'create', title: 'Cart page' }),
      ],
    }),
    node({
      localId: 'story-2',
      decision: 'update',
      title: 'Existing story',
      externalId: 'LIN-9',
      externalUrl: 'https://linear.app/acme/issue/LIN-9',
    }),
  ],
  counts: { create: 2, update: 1, skip: 0, total: 3 },
  cycles: [],
};

const PREVIEW: SyncPreviewData = { provider: 'linear', preview: PREVIEW_TREE };

const EMPTY_TREE: PushPreviewTree = {
  roots: [],
  counts: { create: 0, update: 0, skip: 0, total: 0 },
  cycles: [],
};

const NOOP_TREE: PushPreviewTree = {
  roots: [node({ localId: 'story-1', decision: 'skip', title: 'Unchanged' })],
  counts: { create: 0, update: 0, skip: 1, total: 1 },
  cycles: [],
};

const PUSH_RESULT: PushResult = {
  results: [
    {
      localId: 'epic-1',
      decision: 'create',
      status: 'created',
      externalId: 'LIN-10',
      externalUrl: 'https://linear.app/acme/issue/LIN-10',
      linked: true,
    },
    {
      localId: 'story-1',
      decision: 'create',
      status: 'failed',
      error: 'rate limited',
    },
    {
      localId: 'story-2',
      decision: 'update',
      status: 'updated',
      externalId: 'LIN-9',
      externalUrl: 'https://linear.app/acme/issue/LIN-9',
    },
  ],
  created: 1,
  updated: 1,
  skipped: 0,
  failed: 1,
};

class FakeSettingsService {
  private readonly _settings = signal<Settings>({
    ...DEFAULT_SETTINGS,
    'pm.connections': { [VAULT]: [CONNECTION] },
  });
  readonly settings = this._settings.asReadonly();

  connectionsForVault(vaultPath: string) {
    return this._settings()['pm.connections'][vaultPath] ?? [];
  }

  setConnections(vaultPath: string, conns: LinearConnection[]): void {
    this._settings.update((s) => ({
      ...s,
      'pm.connections': { ...s['pm.connections'], [vaultPath]: conns },
    }));
  }
}

class FakeVaultService {
  readonly vaultPath = signal<string | null>(VAULT);
  readonly hasVault = signal(true);
}

function makeSync() {
  return {
    buildPreview: vi.fn(async (): Promise<SyncPreviewData> => PREVIEW),
    executePush: vi.fn(async (): Promise<PushResult> => PUSH_RESULT),
  };
}

function makeIpc() {
  return {
    isAvailable: true,
    openExternal: vi.fn(async () => undefined),
  };
}

function setup(overrides?: {
  sync?: ReturnType<typeof makeSync>;
  ipc?: ReturnType<typeof makeIpc>;
}) {
  const settings = new FakeSettingsService();
  const vault = new FakeVaultService();
  const sync = overrides?.sync ?? makeSync();
  const ipc = overrides?.ipc ?? makeIpc();
  const pushPreviewOpen = signal(false);

  TestBed.configureTestingModule({
    providers: [
      { provide: SettingsService, useValue: settings },
      { provide: VaultService, useValue: vault },
      { provide: SyncService, useValue: sync },
      { provide: IpcService, useValue: ipc },
      {
        provide: UiStateService,
        useValue: { pushPreviewOpen, openPushPreview: vi.fn(), closePushPreview: vi.fn() },
      },
    ],
  });

  const fixture = TestBed.createComponent(PushPreviewComponent);
  const component = fixture.componentInstance;
  // Settle the constructor effects (vault-change reset) while the modal is closed.
  fixture.detectChanges();
  return { component, fixture, settings, vault, sync, ipc, pushPreviewOpen };
}

/** Lets queued microtasks (awaited sync promises) settle. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Opens the modal and runs the buildPreview path to completion. */
async function open(
  ctx: ReturnType<typeof setup>,
): Promise<void> {
  ctx.pushPreviewOpen.set(true);
  ctx.fixture.detectChanges();
  await flushMicrotasks();
  ctx.fixture.detectChanges();
}

function text(fixture: ReturnType<typeof setup>['fixture']): string {
  return (fixture.nativeElement as HTMLElement).textContent ?? '';
}

describe('PushPreviewComponent (TER-32)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  describe('preview', () => {
    it('builds the preview on open and renders the tree + counts', async () => {
      const ctx = setup();
      await open(ctx);

      expect(ctx.sync.buildPreview).toHaveBeenCalledWith(CONNECTION.connectionId);
      expect(ctx.component.phase()).toBe('preview');
      const out = text(ctx.fixture);
      // Counts roll-up.
      expect(out).toContain('create');
      expect(out).toContain('update');
      expect(out).toContain('total');
      // Tree titles (root + nested child + sibling).
      expect(out).toContain('Checkout revamp');
      expect(out).toContain('Cart page');
      expect(out).toContain('Existing story');
      // Change summary parts surfaced for the rich node.
      expect(out).toContain('description');
      expect(out).toContain('2 criteria');
      expect(out).toContain('1 tag');
    });

    it('enables Approve when there is something to push', async () => {
      const ctx = setup();
      await open(ctx);
      expect(ctx.component.canApprove()).toBe(true);
    });
  });

  describe('no-op states', () => {
    it('shows the truly-empty message and disables Approve when total is 0', async () => {
      const sync = makeSync();
      sync.buildPreview.mockResolvedValueOnce({ provider: 'linear', preview: EMPTY_TREE });
      const ctx = setup({ sync });
      await open(ctx);

      expect(ctx.component.isEmpty()).toBe(true);
      expect(ctx.component.canApprove()).toBe(false);
      expect(text(ctx.fixture)).toContain('Nothing to sync');
    });

    it('shows the up-to-date message and disables Approve when all SKIP', async () => {
      const sync = makeSync();
      sync.buildPreview.mockResolvedValueOnce({ provider: 'linear', preview: NOOP_TREE });
      const ctx = setup({ sync });
      await open(ctx);

      expect(ctx.component.isNoop()).toBe(true);
      expect(ctx.component.canApprove()).toBe(false);
      expect(text(ctx.fixture)).toContain('already up to date');
    });
  });

  describe('preview error', () => {
    it('surfaces the message and offers Retry for a retryable failure', async () => {
      const sync = makeSync();
      sync.buildPreview.mockRejectedValueOnce(
        new SyncError({ code: 'network', message: 'Network unreachable', retryable: true }),
      );
      const ctx = setup({ sync });
      await open(ctx);

      expect(ctx.component.phase()).toBe('error');
      expect(ctx.component.errorMessage()).toBe('Network unreachable');
      expect(ctx.component.canRetry()).toBe(true);
      expect(text(ctx.fixture)).toContain('Network unreachable');

      // Retry re-runs buildPreview (which now resolves) and lands on preview.
      ctx.component.retry();
      await flushMicrotasks();
      ctx.fixture.detectChanges();
      expect(ctx.sync.buildPreview).toHaveBeenCalledTimes(2);
      expect(ctx.component.phase()).toBe('preview');
    });

    it('does not offer Retry for a non-retryable failure', async () => {
      const sync = makeSync();
      sync.buildPreview.mockRejectedValueOnce(
        new SyncError({ code: 'auth', message: 'Unauthorized', retryable: false }),
      );
      const ctx = setup({ sync });
      await open(ctx);

      expect(ctx.component.phase()).toBe('error');
      expect(ctx.component.canRetry()).toBe(false);
    });
  });

  describe('approve → execute', () => {
    it('executes the push and renders per-item results including a partial failure', async () => {
      const ctx = setup();
      await open(ctx);

      await ctx.component.approve();
      ctx.fixture.detectChanges();

      expect(ctx.sync.executePush).toHaveBeenCalledWith(CONNECTION.connectionId);
      expect(ctx.component.phase()).toBe('done');

      // Rows joined back to preview titles, in plan order, with a mixed result.
      const rows = ctx.component.resultRows();
      expect(rows.map((r) => r.title)).toEqual(['Checkout revamp', 'Cart page', 'Existing story']);
      expect(rows.map((r) => r.result.status)).toEqual(['created', 'failed', 'updated']);

      const out = text(ctx.fixture);
      expect(out).toContain('1 created');
      expect(out).toContain('1 failed');
      // The failed item's error is surfaced.
      expect(out).toContain('rate limited');
    });

    it('shows the error state with Retry when the whole push fails', async () => {
      const sync = makeSync();
      sync.executePush.mockRejectedValueOnce(
        new SyncError({ code: 'server', message: 'Push was not executed', retryable: true }),
      );
      const ctx = setup({ sync });
      await open(ctx);

      await ctx.component.approve();
      ctx.fixture.detectChanges();

      expect(ctx.component.phase()).toBe('error');
      expect(ctx.component.errorMessage()).toBe('Push was not executed');
      expect(ctx.component.canRetry()).toBe(true);
    });
  });

  describe('external links (AC#4)', () => {
    it('opens a created item link via IpcService.openExternal', async () => {
      const ctx = setup();
      await open(ctx);
      await ctx.component.approve();
      ctx.fixture.detectChanges();

      const url = 'https://linear.app/acme/issue/LIN-10';
      ctx.component.openExternal(url);
      expect(ctx.ipc.openExternal).toHaveBeenCalledWith(url);
    });
  });

  describe('no connection', () => {
    it('stays idle and never builds a preview when no enabled connection exists', async () => {
      const ctx = setup();
      ctx.settings.setConnections(VAULT, []);
      await open(ctx);

      expect(ctx.sync.buildPreview).not.toHaveBeenCalled();
      expect(ctx.component.phase()).toBe('idle');
      expect(text(ctx.fixture)).toContain('No enabled Linear connection');
    });
  });

  describe('stale-async guard', () => {
    it('discards a buildPreview that resolves after the modal closes', async () => {
      const sync = makeSync();
      // A preview request we can resolve on demand, after the close.
      let resolvePreview!: (data: SyncPreviewData) => void;
      sync.buildPreview.mockReturnValueOnce(
        new Promise<SyncPreviewData>((resolve) => {
          resolvePreview = resolve;
        }),
      );
      const ctx = setup({ sync });

      // Open: buildPreview is now in flight (still loading).
      ctx.pushPreviewOpen.set(true);
      ctx.fixture.detectChanges();
      await flushMicrotasks();
      expect(ctx.component.phase()).toBe('loading');

      // Close before it resolves, then let the stale promise resolve.
      ctx.pushPreviewOpen.set(false);
      ctx.fixture.detectChanges();
      resolvePreview(PREVIEW);
      await flushMicrotasks();

      // The late resolve must NOT restore a preview — state stays reset to idle.
      expect(ctx.component.phase()).toBe('idle');
      expect(ctx.component.previewTree()).toBeNull();
    });

    it('discards a buildPreview from a previous vault after the vault changes', async () => {
      const sync = makeSync();
      let resolvePreview!: (data: SyncPreviewData) => void;
      sync.buildPreview.mockReturnValueOnce(
        new Promise<SyncPreviewData>((resolve) => {
          resolvePreview = resolve;
        }),
      );
      const ctx = setup({ sync });

      ctx.pushPreviewOpen.set(true);
      ctx.fixture.detectChanges();
      await flushMicrotasks();
      expect(ctx.component.phase()).toBe('loading');

      // Switch vault while the first vault's preview is still in flight.
      ctx.vault.vaultPath.set('/other-vault');
      ctx.fixture.detectChanges();
      resolvePreview(PREVIEW);
      await flushMicrotasks();
      ctx.fixture.detectChanges();

      // The first vault's preview must not leak into the new vault's state.
      expect(ctx.component.previewTree()).toBeNull();
    });
  });
});
