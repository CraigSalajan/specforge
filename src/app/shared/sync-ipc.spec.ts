import { describe, expect, it } from 'vitest';

import {
  handleBuildPreview,
  handleConnectionList,
  handleExecutePush,
  handleListProjects,
  handleListTeams,
  handleTestConnection,
  type SyncIpcContext,
} from '../../../electron/ipc/sync-handlers';
import type { SyncOrchestratorDeps } from '../../../electron/sync/orchestrator';
import { buildEphemeralLinearClient } from '../../../electron/sync/orchestrator';
import { LinearRequestError } from '../../../electron/sync/linear/errors';
import { LinearGraphQLClient } from '../../../electron/sync/linear/client';
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
      // The non-discovery handlers never invoke this; a throwing stub keeps the
      // context type-complete without pulling a real client into these tests.
      buildDiscoveryClient: () => {
        throw new Error('buildDiscoveryClient not used in this test');
      },
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

// --- TER-31: team/project discovery -----------------------------------------

/** A `fetch` stub returning one GraphQL `data` payload (HTTP 200, no errors). */
function fetchReturning(data: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
}

/** A `fetch` stub returning a 401 so the client classifies it as an `auth` error. */
function fetchUnauthorized(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ errors: [{ message: 'Authentication required' }] }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
}

/**
 * Builds a discovery context whose `buildDiscoveryClient` records the PAT it was
 * handed and returns a real {@link LinearGraphQLClient} over the supplied
 * `fetchFn` — so the full ephemeral-client + discovery-query path runs with no
 * network. The recorded PAT lets tests assert the credential reached the client
 * (and ONLY the client).
 */
function discoveryCtx(fetchFn: typeof fetch): {
  ctx: SyncIpcContext;
  pats: string[];
} {
  const pats: string[] = [];
  const ctx: SyncIpcContext = {
    deps: {
      resolveVaultRoot: () => VAULT_PATH,
      readConnection: () => undefined,
      sourceCanonicalItems: () => [],
      listLinks: () => [],
      writeLink: () => undefined,
      buildAdapter: () => fakeAdapter(),
      now: () => FIXED_NOW,
    },
    listConnections: () => [],
    buildDiscoveryClient: (pat: string) => {
      pats.push(pat);
      return new LinearGraphQLClient({ auth: { authorizationHeader: () => Promise.resolve(pat) }, fetchFn });
    },
  };
  return { ctx, pats };
}

describe('handleListTeams (TER-31)', () => {
  it('builds the ephemeral adapter from the PAT and returns the {ok,data} envelope', async () => {
    const teams = [
      { id: 't1', key: 'ENG', name: 'Engineering' },
      { id: 't2', key: 'DES', name: 'Design' },
    ];
    const { ctx, pats } = discoveryCtx(fetchReturning({ teams: { nodes: teams } }));

    const res = await handleListTeams({ provider: 'linear', pat: 'lin_api_secret' }, ctx);

    expect(res).toEqual({ ok: true, data: teams });
    // The PAT reached the (ephemeral) client and nothing else.
    expect(pats).toEqual(['lin_api_secret']);
  });

  it('maps an auth failure to { ok: false, error } (code auth)', async () => {
    const { ctx } = discoveryCtx(fetchUnauthorized());

    const res = await handleListTeams({ provider: 'linear', pat: 'bad' }, ctx);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('auth');
      // The discovery context is appended to the auth message.
      expect(res.error.message).toContain('read access to this workspace');
    }
  });

  it('rejects a non-linear provider before touching the PAT', async () => {
    const built: string[] = [];
    const ctx: SyncIpcContext = {
      ...discoveryCtx(fetchReturning({ teams: { nodes: [] } })).ctx,
      buildDiscoveryClient: (pat) => {
        built.push(pat);
        return buildEphemeralLinearClient(pat);
      },
    };

    const res = await handleListTeams(
      { provider: 'jira', pat: 'lin_api_secret' },
      ctx,
    );

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain('Unsupported discovery provider');
    // The client builder was never invoked, so the PAT was never used.
    expect(built).toEqual([]);
  });

  it('rejects an empty PAT', async () => {
    const { ctx } = discoveryCtx(fetchReturning({ teams: { nodes: [] } }));
    const res = await handleListTeams({ provider: 'linear', pat: '' }, ctx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain('Invalid PAT');
  });
});

describe('handleListProjects (TER-31)', () => {
  it('builds the ephemeral adapter and returns the team projects', async () => {
    const projects = [
      { id: 'p1', name: 'Platform' },
      { id: 'p2', name: 'Mobile' },
    ];
    const { ctx, pats } = discoveryCtx(
      fetchReturning({ team: { projects: { nodes: projects } } }),
    );

    const res = await handleListProjects(
      { provider: 'linear', pat: 'lin_api_secret', teamId: 't1' },
      ctx,
    );

    expect(res).toEqual({ ok: true, data: projects });
    expect(pats).toEqual(['lin_api_secret']);
  });

  it('returns [] when the team is not visible (null team node)', async () => {
    const { ctx } = discoveryCtx(fetchReturning({ team: null }));

    const res = await handleListProjects(
      { provider: 'linear', pat: 'lin_api_secret', teamId: 'missing' },
      ctx,
    );

    expect(res).toEqual({ ok: true, data: [] });
  });

  it('maps an auth failure to { ok: false, error }', async () => {
    const { ctx } = discoveryCtx(fetchUnauthorized());

    const res = await handleListProjects(
      { provider: 'linear', pat: 'bad', teamId: 't1' },
      ctx,
    );

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('auth');
  });

  it('rejects an empty team id', async () => {
    const { ctx } = discoveryCtx(fetchReturning({ team: { projects: { nodes: [] } } }));
    const res = await handleListProjects(
      { provider: 'linear', pat: 'lin_api_secret', teamId: '' },
      ctx,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain('Invalid team id');
  });
});
