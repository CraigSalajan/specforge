import { describe, expect, it, vi } from 'vitest';

// `electron/ipc/sync` imports `ipcMain` at module top. These tests exercise only
// the exported pure `handle*` functions (never `registerSyncHandlers`), so a bare
// `ipcMain.handle` stub is enough to let the module load under jsdom — mirroring
// the `vi.mock('electron', …)` seam in connection-secrets.spec.ts.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));

import {
  handleBuildPreview,
  handleConnectionList,
  handleExecutePush,
  handleTestConnection,
  type SyncIpcContext,
} from '../../../electron/ipc/sync';
import type { SyncOrchestratorDeps } from '../../../electron/sync/orchestrator';
import { LinearRequestError } from '../../../electron/sync/linear/errors';
import type { Connection } from '../../../electron/sync/connection';
import type {
  CreateItemContext,
  ExternalItemResult,
  IAdapter,
  ProjectMetadata,
} from '../../../electron/sync/adapter';
import type { CanonicalItem } from '../../../electron/sync/canonical-item';
import type { SyncLink } from '../../../electron/db/repositories/sync-links.repo';

const VAULT_PATH = '/vault';
const CONNECTION_ID = 'linear-conn-1';
const FIXED_NOW = '2026-06-25T00:00:00.000Z';

/** A persisted Linear connection with the canonical id threaded through. */
function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    connectionId: CONNECTION_ID,
    provider: 'linear',
    enabled: true,
    authMode: 'pat',
    teamId: 'team-1',
    ...overrides,
  };
}

/** Minimal CanonicalItem factory keeping tests terse (mirrors sync-orchestrator.spec). */
function item(partial: Partial<CanonicalItem> & Pick<CanonicalItem, 'localId'>): CanonicalItem {
  return {
    level: 'story',
    title: `title-${partial.localId}`,
    ...partial,
  };
}

const PROJECT_METADATA: ProjectMetadata = {
  provider: 'linear',
  projectId: 'p',
  projectName: 'P',
  supportedLevels: ['epic', 'feature', 'story', 'criterion'],
};

/**
 * In-memory fake adapter mirroring sync-orchestrator.spec's helper. `getMetadata`
 * can be overridden to reject (e.g. with a {@link LinearRequestError}) so the
 * test-connection error path is exercised without any network.
 */
function fakeAdapter(
  opts: { metadata?: () => Promise<ProjectMetadata> } = {},
): IAdapter & { creates: CanonicalItem[] } {
  const creates: CanonicalItem[] = [];
  return {
    name: 'linear',
    creates,
    getMetadata(): Promise<ProjectMetadata> {
      return opts.metadata ? opts.metadata() : Promise.resolve(PROJECT_METADATA);
    },
    createItem(it: CanonicalItem, _context?: CreateItemContext): Promise<ExternalItemResult> {
      creates.push(it);
      return Promise.resolve({
        externalId: `ext-${it.localId}`,
        externalUrl: `https://x/${it.localId}`,
      });
    },
    updateItem(): Promise<void> {
      return Promise.resolve();
    },
    linkItems(): Promise<void> {
      return Promise.resolve();
    },
    getRemoteState(): Promise<null> {
      return Promise.resolve(null);
    },
  };
}

/**
 * Builds a {@link SyncIpcContext} over in-memory fakes: a stubbed vault root, a
 * single connection, a fixed item source, an empty SyncLink store, a capturing
 * `writeLink`, and a fixed clock — mirroring sync-orchestrator.spec's `fakeDeps`.
 */
function fakeCtx(opts: {
  vaultPath?: string | null;
  connection?: Connection | undefined;
  items?: CanonicalItem[];
  links?: SyncLink[];
  adapter?: IAdapter & { creates: CanonicalItem[] };
}): {
  ctx: SyncIpcContext;
  writtenLinks: SyncLink[];
  adapter: IAdapter & { creates: CanonicalItem[] };
} {
  const writtenLinks: SyncLink[] = [];
  const adapter = opts.adapter ?? fakeAdapter();
  const links = opts.links ?? [];
  const conn = 'connection' in opts ? opts.connection : connection();

  const deps: SyncOrchestratorDeps = {
    resolveVaultRoot: () => (opts.vaultPath === undefined ? VAULT_PATH : opts.vaultPath),
    readConnection: (_vaultPath, connectionId) =>
      conn && conn.connectionId === connectionId ? conn : undefined,
    sourceCanonicalItems: () => opts.items ?? [],
    listLinks: () => links,
    writeLink: (l) => writtenLinks.push(l),
    buildAdapter: () => adapter,
    now: () => FIXED_NOW,
  };

  return {
    writtenLinks,
    adapter,
    ctx: {
      deps,
      listConnections: () => (conn ? [conn] : []),
    },
  };
}

describe('handleTestConnection (AC #1)', () => {
  it('returns { ok: true, data: metadata } on success', async () => {
    const { ctx } = fakeCtx({});
    const res = await handleTestConnection(CONNECTION_ID, ctx);
    expect(res).toEqual({ ok: true, data: PROJECT_METADATA });
  });

  it('surfaces a LinearRequestError as { ok: false, error: <its info> }', async () => {
    const info = { code: 'auth' as const, status: 401, retryable: false, message: 'Unauthorized' };
    const adapter = fakeAdapter({ metadata: () => Promise.reject(new LinearRequestError(info)) });
    const { ctx } = fakeCtx({ adapter });

    const res = await handleTestConnection(CONNECTION_ID, ctx);

    expect(res).toEqual({ ok: false, error: info });
  });

  it('returns an error envelope for a missing connection', async () => {
    const { ctx } = fakeCtx({ connection: undefined });

    const res = await handleTestConnection('does-not-exist', ctx);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('unknown');
      expect(res.error.message).toContain('Unknown connection: does-not-exist');
      expect(res.error.retryable).toBe(false);
    }
  });

  it('returns an error envelope when no vault is active', async () => {
    const { ctx } = fakeCtx({ vaultPath: null });

    const res = await handleTestConnection(CONNECTION_ID, ctx);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain('No active vault');
  });
});

describe('handleBuildPreview (AC #1)', () => {
  it('returns { ok: true, data: { provider, preview } } without adapter/items in the payload', async () => {
    const items = [item({ localId: 'a' }), item({ localId: 'b' })];
    const { ctx } = fakeCtx({ items });

    const res = await handleBuildPreview(CONNECTION_ID, ctx);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.provider).toBe('linear');
      expect(res.data.preview.counts).toEqual({ create: 2, update: 0, skip: 0, total: 2 });
      // The serializable subset MUST NOT leak the non-serializable adapter or the
      // bulky items/plan the renderer does not need.
      expect(res.data).not.toHaveProperty('adapter');
      expect(res.data).not.toHaveProperty('items');
      expect(res.data).not.toHaveProperty('plan');
      expect(Object.keys(res.data).sort()).toEqual(['preview', 'provider']);
    }
  });

  it('returns an error envelope on a disabled connection', async () => {
    const { ctx } = fakeCtx({ connection: connection({ enabled: false }) });

    const res = await handleBuildPreview(CONNECTION_ID, ctx);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain('is disabled');
  });
});

describe('handleExecutePush (AC #1)', () => {
  it('returns { ok: true, data: pushResult } after executing the plan', async () => {
    const items = [item({ localId: 'a' }), item({ localId: 'b' })];
    const { ctx, writtenLinks, adapter } = fakeCtx({ items });

    const res = await handleExecutePush(CONNECTION_ID, ctx);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data?.created).toBe(2);
      expect(res.data?.failed).toBe(0);
    }
    expect(adapter.creates.map((c) => c.localId).sort()).toEqual(['a', 'b']);
    expect(writtenLinks.map((l) => l.specItemId).sort()).toEqual(['a', 'b']);
  });

  it('returns an error envelope when no vault is active', async () => {
    const { ctx } = fakeCtx({ vaultPath: null });

    const res = await handleExecutePush(CONNECTION_ID, ctx);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain('No active vault');
  });
});

describe('handleConnectionList (AC #1)', () => {
  it('returns the connections array for the vault (bare, no envelope)', async () => {
    const conn = connection();
    const { ctx } = fakeCtx({ connection: conn });

    const result = await handleConnectionList(VAULT_PATH, ctx);

    expect(result).toEqual([conn]);
  });

  it('rejects an invalid vault path', async () => {
    const { ctx } = fakeCtx({});
    await expect(handleConnectionList('', ctx)).rejects.toThrow(/Invalid vault path/);
  });
});
