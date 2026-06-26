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
import type { PushResult, ItemProgressEvent } from '../../../../electron/sync/executor';

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

type ProgressCb = (ev: ItemProgressEvent) => void;

function makeSync() {
  return {
    buildPreview: vi.fn(async (_conn: string, _file?: string): Promise<SyncPreviewData> => PREVIEW),
    buildPreviewFromItems: vi.fn(
      async (_conn: string, _items: unknown): Promise<SyncPreviewData> => PREVIEW,
    ),
    executePush: vi.fn(
      async (_conn: string, _file?: string, _onProgress?: ProgressCb): Promise<PushResult> =>
        PUSH_RESULT,
    ),
    executePushFromItems: vi.fn(
      async (_conn: string, _items: unknown, _onProgress?: ProgressCb): Promise<PushResult> =>
        PUSH_RESULT,
    ),
  };
}

function makeIpc() {
  return {
    isAvailable: true,
    openExternal: vi.fn(() => Promise.resolve()),
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
  const pushPreviewFilePath = signal<string | null>(null);
  const combinedPushRequest = signal<unknown>(null);
  const uiState = {
    pushPreviewOpen,
    pushPreviewFilePath,
    combinedPushRequest,
    openPushPreview: vi.fn(),
    openPushPreviewForFile: vi.fn(),
    openCombinedPushReview: vi.fn(),
    closePushPreview: vi.fn(),
  };

  TestBed.configureTestingModule({
    providers: [
      { provide: SettingsService, useValue: settings },
      { provide: VaultService, useValue: vault },
      { provide: SyncService, useValue: sync },
      { provide: IpcService, useValue: ipc },
      { provide: UiStateService, useValue: uiState },
    ],
  });

  const fixture = TestBed.createComponent(PushPreviewComponent);
  const component = fixture.componentInstance;
  // Settle the constructor effects (vault-change reset) while the modal is closed.
  fixture.detectChanges();
  return {
    component,
    fixture,
    settings,
    vault,
    sync,
    ipc,
    uiState,
    pushPreviewOpen,
    pushPreviewFilePath,
    combinedPushRequest,
  };
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

      expect(ctx.sync.buildPreview).toHaveBeenCalledWith(CONNECTION.connectionId, undefined);
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

      expect(ctx.sync.executePush).toHaveBeenCalledWith(
        CONNECTION.connectionId,
        undefined,
        expect.any(Function),
      );
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

  describe('close guard while pushing', () => {
    it('blocks close() while a push is in flight and keeps the modal open', async () => {
      const sync = makeSync();
      // A push that never resolves, holding the component in the `pushing` phase.
      sync.executePush.mockReturnValueOnce(new Promise<PushResult>(() => {}));
      const ctx = setup({ sync });
      await open(ctx);

      // Kick off the push but don't await it to completion — it never resolves.
      void ctx.component.approve();
      await flushMicrotasks();
      expect(ctx.component.phase()).toBe('pushing');

      // Attempting to close mid-push must be a no-op on every path.
      ctx.component.close();

      expect(ctx.uiState.closePushPreview).not.toHaveBeenCalled();
      expect(ctx.pushPreviewOpen()).toBe(true);
      expect(ctx.component.phase()).toBe('pushing');
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

  describe('per-file scope (TER-37)', () => {
    const FILE = 'prd/auth.md';

    it('threads the per-file path into buildPreview and executePush', async () => {
      const ctx = setup();
      // Scope the modal to a single file before opening (as openPushPreviewForFile would).
      ctx.pushPreviewFilePath.set(FILE);
      await open(ctx);

      expect(ctx.sync.buildPreview).toHaveBeenCalledWith(CONNECTION.connectionId, FILE);
      expect(ctx.component.filePath()).toBe(FILE);

      await ctx.component.approve();
      ctx.fixture.detectChanges();

      expect(ctx.sync.executePush).toHaveBeenCalledWith(
        CONNECTION.connectionId,
        FILE,
        expect.any(Function),
      );
    });

    it('reflects the per-file scope in the modal header', async () => {
      const ctx = setup();
      ctx.pushPreviewFilePath.set(FILE);
      await open(ctx);

      const out = text(ctx.fixture);
      expect(out).toContain('Push this file to Linear');
      expect(out).toContain(FILE);
    });

    it('falls back to whole-vault wording and no filePath when unscoped', async () => {
      const ctx = setup();
      await open(ctx);

      expect(ctx.sync.buildPreview).toHaveBeenCalledWith(CONNECTION.connectionId, undefined);
      expect(ctx.component.filePath()).toBeNull();
      expect(text(ctx.fixture)).toContain('Push to Linear');
    });
  });

  describe('combined decompose-and-push mode (TER-37)', () => {
    // The combined push is FLAT + stories-only (TER-37): the items the renderer
    // passes are tagged stories with no epic/theme parents. They carry the full
    // folded body + acceptance criteria so the combined preview can render richly.
    const ITEMS = [
      {
        localId: 's1',
        level: 'story' as const,
        title: 'Log in with email',
        description: 'As a user I can log in.\n\n**Open questions**\n- SSO?',
        criteria: ['Valid creds succeed', 'Bad creds show an error'],
      },
      { localId: 's2', level: 'story' as const, title: 'Reset password' },
    ];

    /** A combined preview tree whose roots match the in-memory items by localId. */
    const COMBINED_TREE: PushPreviewTree = {
      roots: [
        node({ localId: 's1', decision: 'create', title: 'Log in with email' }),
        node({ localId: 's2', decision: 'update', title: 'Reset password' }),
      ],
      counts: { create: 1, update: 1, skip: 0, total: 2 },
      cycles: [],
    };

    function combinedReq(
      onApprove: (onProgress?: (ev: ItemProgressEvent) => void) => Promise<PushResult>,
    ) {
      return {
        filePath: 'prd/auth.md',
        items: ITEMS,
        summary: { storiesAdded: 2, sectionCreated: true },
        onApprove,
      };
    }

    it('previews from in-memory items (not the file) and shows the doc-save summary', async () => {
      const ctx = setup();
      ctx.pushPreviewFilePath.set('prd/auth.md');
      ctx.combinedPushRequest.set(combinedReq(async () => PUSH_RESULT));
      await open(ctx);

      // Preview came from the items path, NOT the disk buildPreview.
      expect(ctx.sync.buildPreviewFromItems).toHaveBeenCalledWith(CONNECTION.connectionId, ITEMS);
      expect(ctx.sync.buildPreview).not.toHaveBeenCalled();

      const out = text(ctx.fixture);
      // Doc-save summary + combined header + Save & Push button.
      expect(out).toContain('Will save to prd/auth.md');
      expect(out).toContain('2 new stories');
      expect(out).toContain('Decompose & Push this file');
      expect(out).toContain('Save & Push to Linear');
    });

    it('renders per-story description + acceptance criteria from the in-memory items', async () => {
      const sync = makeSync();
      sync.buildPreviewFromItems.mockResolvedValueOnce({ provider: 'linear', preview: COMBINED_TREE });
      const ctx = setup({ sync });
      ctx.pushPreviewFilePath.set('prd/auth.md');
      ctx.combinedPushRequest.set(combinedReq(async () => PUSH_RESULT));
      await open(ctx);

      const rows = ctx.component.combinedStories();
      expect(rows.map((r) => r.localId)).toEqual(['s1', 's2']);
      expect(rows[0].decision).toBe('create');
      expect(rows[0].criteria).toEqual(['Valid creds succeed', 'Bad creds show an error']);

      const out = text(ctx.fixture);
      // Story title + folded body + criteria + heading, not just counts.
      expect(out).toContain('Log in with email');
      expect(out).toContain('As a user I can log in.');
      expect(out).toContain('Acceptance criteria');
      expect(out).toContain('Valid creds succeed');
      expect(out).toContain('Bad creds show an error');
    });

    it('approve runs the write-then-push callback (not the push-only executePush)', async () => {
      const ctx = setup();
      const onApprove = vi.fn(async () => PUSH_RESULT);
      ctx.pushPreviewFilePath.set('prd/auth.md');
      ctx.combinedPushRequest.set(combinedReq(onApprove));
      await open(ctx);

      await ctx.component.approve();
      ctx.fixture.detectChanges();

      expect(onApprove).toHaveBeenCalledTimes(1);
      // The combined approve forwards a progress sink to the write-then-push callback.
      expect(onApprove).toHaveBeenCalledWith(expect.any(Function));
      // The combined approve must NOT call the push-only executePush directly.
      expect(ctx.sync.executePush).not.toHaveBeenCalled();
      expect(ctx.component.phase()).toBe('done');
    });
  });

  describe('live per-item progress (TER-37)', () => {
    it('seeds pending rows then transitions pending → creating → done as events arrive', async () => {
      const sync = makeSync();
      // Hold the push open so we can drive progress events before it resolves.
      let resolvePush!: (r: PushResult) => void;
      let progress: ((ev: ItemProgressEvent) => void) | undefined;
      sync.executePush.mockImplementationOnce(
        (_conn: string, _file: string | undefined, onProgress?: (ev: ItemProgressEvent) => void) => {
          progress = onProgress;
          return new Promise<PushResult>((resolve) => {
            resolvePush = resolve;
          });
        },
      );
      const ctx = setup({ sync });
      await open(ctx);

      void ctx.component.approve();
      await flushMicrotasks();
      ctx.fixture.detectChanges();

      // Seeded one pending row per preview-tree node, in plan order.
      expect(ctx.component.phase()).toBe('pushing');
      expect(ctx.component.progressRows().map((r) => r.localId)).toEqual([
        'epic-1',
        'story-1',
        'story-2',
      ]);
      expect(ctx.component.progressRows().every((r) => r.status === 'pending')).toBe(true);

      // start → creating in place; the row's badge vocabulary (statusClass) is reused.
      progress?.({ phase: 'start', localId: 'epic-1', decision: 'create', title: 'Checkout revamp' });
      ctx.fixture.detectChanges();
      expect(ctx.component.progressRows().find((r) => r.localId === 'epic-1')?.status).toBe('creating');

      // done → done, carrying the per-item result for the final badge/link.
      progress?.({
        phase: 'done',
        localId: 'epic-1',
        decision: 'create',
        title: 'Checkout revamp',
        result: {
          localId: 'epic-1',
          decision: 'create',
          status: 'created',
          externalUrl: 'https://linear.app/acme/issue/LIN-10',
        },
      });
      ctx.fixture.detectChanges();
      const epicRow = ctx.component.progressRows().find((r) => r.localId === 'epic-1');
      expect(epicRow?.status).toBe('done');
      // The done badge reuses the result-row badge vocabulary (created = accent).
      const badge = (ctx.fixture.nativeElement as HTMLElement).querySelector('.bg-accent.text-white');
      expect(badge?.textContent).toContain('created');
      expect(text(ctx.fixture)).toContain('View in Linear');

      // A failed item flips the row to failed.
      progress?.({
        phase: 'done',
        localId: 'story-1',
        decision: 'create',
        title: 'Cart page',
        result: { localId: 'story-1', decision: 'create', status: 'failed', error: 'rate limited' },
      });
      ctx.fixture.detectChanges();
      expect(ctx.component.progressRows().find((r) => r.localId === 'story-1')?.status).toBe('failed');
      expect(text(ctx.fixture)).toContain('rate limited');

      resolvePush(PUSH_RESULT);
      await flushMicrotasks();
      ctx.fixture.detectChanges();
      expect(ctx.component.phase()).toBe('done');
    });

    it('ignores progress from a stale generation (modal closed mid-push)', async () => {
      const sync = makeSync();
      let progress: ((ev: ItemProgressEvent) => void) | undefined;
      sync.executePush.mockImplementationOnce(
        (_conn: string, _file: string | undefined, onProgress?: (ev: ItemProgressEvent) => void) => {
          progress = onProgress;
          return new Promise<PushResult>(() => {});
        },
      );
      const ctx = setup({ sync });
      await open(ctx);

      void ctx.component.approve();
      await flushMicrotasks();
      expect(ctx.component.phase()).toBe('pushing');

      // Close bumps the generation (reset()). A late event must be discarded.
      ctx.pushPreviewOpen.set(false);
      ctx.fixture.detectChanges();
      progress?.({ phase: 'start', localId: 'epic-1', decision: 'create', title: 'Checkout revamp' });

      // The map was cleared by reset and the stale event did not repopulate it.
      expect(ctx.component.progressRows()).toEqual([]);
    });
  });
});
