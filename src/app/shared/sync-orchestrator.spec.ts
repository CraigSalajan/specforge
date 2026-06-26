import { describe, expect, it } from 'vitest';
import {
  createLinearAdapterBuilder,
  executePlannedPush,
  planPushForConnection,
  runSyncPush,
  type SyncOrchestratorDeps,
} from '../../../electron/sync/orchestrator';
import { computeItemHash } from '../../../electron/sync/sync-engine';
import { connectionToLinearConfig, type Connection } from '../../../electron/sync/connection';
import { LinearAdapter } from '../../../electron/sync/linear/linear-adapter';
import type {
  ConnectionSecretKind,
  ConnectionSecrets,
} from '../../../electron/sync/connection-secrets';
import type { TokenSource } from '../../../electron/sync/linear/auth';
import type { OAuthTokenManager } from '../../../electron/sync/linear/oauth/token-manager';
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
const FIXED_NOW = '2026-06-15T00:00:00.000Z';

/** Minimal CanonicalItem factory keeping tests terse (mirrors sync-executor.spec). */
function item(partial: Partial<CanonicalItem> & Pick<CanonicalItem, 'localId'>): CanonicalItem {
  return {
    level: 'story',
    title: `title-${partial.localId}`,
    ...partial,
  };
}

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

interface CreateCall {
  item: CanonicalItem;
  context?: CreateItemContext;
}
interface UpdateCall {
  id: string;
  item: CanonicalItem;
}

/**
 * In-memory fake adapter mirroring sync-executor.spec's helper: `createItem`
 * returns a synthetic handle and records the call; `failCreate`/`failUpdate`
 * localIds reject to exercise the partial-failure contract.
 */
function fakeAdapter(
  opts: { failCreate?: Set<string>; failUpdate?: Set<string> } = {},
): IAdapter & { creates: CreateCall[]; updates: UpdateCall[] } {
  const creates: CreateCall[] = [];
  const updates: UpdateCall[] = [];
  const failCreate = opts.failCreate ?? new Set<string>();
  const failUpdate = opts.failUpdate ?? new Set<string>();

  return {
    name: 'linear',
    creates,
    updates,
    getMetadata(): Promise<ProjectMetadata> {
      return Promise.resolve({
        provider: 'linear',
        projectId: 'p',
        projectName: 'P',
        supportedLevels: ['epic', 'feature', 'story', 'criterion'],
      });
    },
    createItem(it: CanonicalItem, context?: CreateItemContext): Promise<ExternalItemResult> {
      creates.push({ item: it, context });
      if (failCreate.has(it.localId)) {
        return Promise.reject(new Error(`createItem failed for ${it.localId}`));
      }
      return Promise.resolve({
        externalId: `ext-${it.localId}`,
        externalUrl: `https://x/${it.localId}`,
      });
    },
    updateItem(id: string, it: CanonicalItem): Promise<void> {
      updates.push({ id, item: it });
      if (failUpdate.has(it.localId)) {
        return Promise.reject(new Error(`updateItem failed for ${it.localId}`));
      }
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
 * Builds {@link SyncOrchestratorDeps} over in-memory fakes: a fixed vault, a
 * single connection, a fixed item source, a seeded SyncLink store, a capturing
 * `writeLink`, and a fixed clock. Returns the written-link capture and the
 * adapter so tests can assert against both.
 */
function fakeDeps(opts: {
  vaultPath?: string | null;
  connection?: Connection | undefined;
  items?: CanonicalItem[];
  links?: SyncLink[];
  adapter?: IAdapter & { creates: CreateCall[]; updates: UpdateCall[] };
}): {
  deps: SyncOrchestratorDeps;
  writtenLinks: SyncLink[];
  adapter: IAdapter & { creates: CreateCall[]; updates: UpdateCall[] };
} {
  const writtenLinks: SyncLink[] = [];
  const adapter = opts.adapter ?? fakeAdapter();
  const links = opts.links ?? [];
  const conn = 'connection' in opts ? opts.connection : connection();

  return {
    writtenLinks,
    adapter,
    deps: {
      resolveVaultRoot: () => (opts.vaultPath === undefined ? VAULT_PATH : opts.vaultPath),
      readConnection: (_vaultPath, connectionId) =>
        conn && conn.connectionId === connectionId ? conn : undefined,
      sourceCanonicalItems: () => opts.items ?? [],
      listLinks: () => links,
      writeLink: (l) => writtenLinks.push(l),
      buildAdapter: () => adapter,
      now: () => FIXED_NOW,
    },
  };
}

/** A SyncLink carrying the given content hash, as the link store would hold it. */
function link(specItemId: string, lastPushedHash: string): SyncLink {
  return {
    specItemId,
    connectionId: CONNECTION_ID,
    externalId: `EXT-${specItemId}`,
    externalUrl: `https://example.test/${specItemId}`,
    lastPushedHash,
    lastPushedAt: FIXED_NOW,
  };
}

describe('planPushForConnection — plan & preview composition (AC #1, #3)', () => {
  it('plans create + update + skip and builds the matching preview counts', () => {
    const toCreate = item({ localId: 'a' });
    const toUpdate = item({ localId: 'b' });
    const toSkip = item({ localId: 'c' });
    const items = [toCreate, toUpdate, toSkip];

    // `b` has a stale link (hash differs → update); `c`'s link hash equals its
    // current content (→ skip); `a` has no link (→ create).
    const links = [
      link('b', 'stale-hash'),
      link('c', computeItemHash(toSkip)),
    ];
    const { deps } = fakeDeps({ items, links });

    const planned = planPushForConnection(CONNECTION_ID, deps);

    // AC #4: the persisted connection id and provider are threaded onto the plan.
    expect(planned.connectionId).toBe(CONNECTION_ID);
    expect(planned.provider).toBe('linear');
    // AC #3: the items the push will operate over are surfaced verbatim.
    expect(planned.items).toBe(items);

    // AC #1 (plan): per-item decisions in topological order.
    expect(planned.plan.ordered.map((d) => ({ id: d.item.localId, decision: d.decision }))).toEqual([
      { id: 'a', decision: 'create' },
      { id: 'b', decision: 'update' },
      { id: 'c', decision: 'skip' },
    ]);

    // AC #1 (preview): roll-up counts match the decisions.
    expect(planned.preview.counts).toEqual({ create: 1, update: 1, skip: 1, total: 3 });
    expect(planned.preview.cycles).toEqual([]);
  });

  it('throws when no vault is active', () => {
    const { deps } = fakeDeps({ vaultPath: null });
    expect(() => planPushForConnection(CONNECTION_ID, deps)).toThrow(/No active vault/);
  });

  it('throws on an unknown connection', () => {
    const { deps } = fakeDeps({ connection: undefined });
    expect(() => planPushForConnection('does-not-exist', deps)).toThrow(
      'Unknown connection: does-not-exist',
    );
  });

  it('throws on a disabled connection', () => {
    const { deps } = fakeDeps({ connection: connection({ enabled: false }) });
    expect(() => planPushForConnection(CONNECTION_ID, deps)).toThrow(
      `Connection ${CONNECTION_ID} is disabled`,
    );
  });
});

describe('executePlannedPush — apply on approval (AC #1, #4, #5)', () => {
  it('threads the connection id onto every written link', async () => {
    const items = [item({ localId: 'a' }), item({ localId: 'b' })];
    const { deps, writtenLinks } = fakeDeps({ items });

    const planned = planPushForConnection(CONNECTION_ID, deps);
    const result = await executePlannedPush(planned, deps);

    expect(result.created).toBe(2);
    expect(result.failed).toBe(0);
    // AC #4: the persisted connection id is stamped onto every link.
    expect(writtenLinks.map((l) => l.connectionId)).toEqual([CONNECTION_ID, CONNECTION_ID]);
    expect(writtenLinks.map((l) => l.specItemId).sort()).toEqual(['a', 'b']);
  });

  it('surfaces a per-item adapter failure as status "failed" WITHOUT throwing (AC #5)', async () => {
    const items = [item({ localId: 'ok' }), item({ localId: 'boom' })];
    const adapter = fakeAdapter({ failCreate: new Set(['boom']) });
    const { deps, writtenLinks } = fakeDeps({ items, adapter });

    const planned = planPushForConnection(CONNECTION_ID, deps);
    // Must resolve, not reject — the executor captures the failure per-item.
    const result = await executePlannedPush(planned, deps);

    const boom = result.results.find((r) => r.localId === 'boom');
    expect(boom?.status).toBe('failed');
    expect(boom?.error).toContain('boom');
    expect(result.failed).toBe(1);
    expect(result.created).toBe(1);
    // No link written for the failed item; the succeeding item's link survives.
    expect(writtenLinks.map((l) => l.specItemId)).toEqual(['ok']);
  });
});

describe('runSyncPush — approve gate (AC #1)', () => {
  it('executes when approval is granted (default approve)', async () => {
    const items = [item({ localId: 'a' })];
    const { deps, writtenLinks, adapter } = fakeDeps({ items });

    const { planned, result } = await runSyncPush(CONNECTION_ID, deps);

    expect(planned.connectionId).toBe(CONNECTION_ID);
    expect(result?.created).toBe(1);
    expect(adapter.creates.map((c) => c.item.localId)).toEqual(['a']);
    expect(writtenLinks.map((l) => l.specItemId)).toEqual(['a']);
  });

  it('declines: returns result null, writes no links, performs no creates/updates', async () => {
    const items = [item({ localId: 'a' }), item({ localId: 'b' })];
    const { deps, writtenLinks, adapter } = fakeDeps({ items });

    const { planned, result } = await runSyncPush(CONNECTION_ID, deps, () => false);

    // A plan was still produced (the proposal), but nothing was applied.
    expect(planned.preview.counts.create).toBe(2);
    expect(result).toBeNull();
    expect(writtenLinks).toEqual([]);
    expect(adapter.creates).toHaveLength(0);
    expect(adapter.updates).toHaveLength(0);
  });

  it('awaits an async approve resolving false the same way', async () => {
    const items = [item({ localId: 'a' })];
    const { deps, writtenLinks } = fakeDeps({ items });

    const { result } = await runSyncPush(CONNECTION_ID, deps, () => Promise.resolve(false));

    expect(result).toBeNull();
    expect(writtenLinks).toEqual([]);
  });
});

describe('createLinearAdapterBuilder — production adapter builder (AC #2)', () => {
  /** A fake ConnectionSecrets whose token source returns a stub PAT. */
  function fakeSecrets(): {
    secrets: ConnectionSecrets;
    calls: { connectionId: string; kind?: ConnectionSecretKind }[];
  } {
    const calls: { connectionId: string; kind?: ConnectionSecretKind }[] = [];
    const stub: TokenSource = () => 'stub-token';
    const secrets: ConnectionSecrets = {
      getConnectionToken: () => 'stub-token',
      setConnectionToken: () => {},
      hasConnectionToken: () => true,
      deleteConnectionSecrets: () => {},
      connectionTokenSource: (connectionId, kind) => {
        calls.push({ connectionId, kind });
        return stub;
      },
    };
    return { secrets, calls };
  }

  /** A fake OAuth token manager recording the ids `getAccessToken` is asked for. */
  function fakeTokenManager(): {
    tokenManager: OAuthTokenManager;
    accessCalls: string[];
  } {
    const accessCalls: string[] = [];
    const tokenManager: OAuthTokenManager = {
      getAccessToken: (connectionId) => {
        accessCalls.push(connectionId);
        return Promise.resolve('oauth-access-token');
      },
      seedFromExchange: () => {},
      revoke: () => Promise.resolve(),
    };
    return { tokenManager, accessCalls };
  }

  it('builds a LinearAdapter whose config equals connectionToLinearConfig(conn) for a PAT connection', () => {
    const { secrets, calls } = fakeSecrets();
    const { tokenManager } = fakeTokenManager();
    const conn = connection({ authMode: 'pat', projectId: 'proj-9', featureLabelId: 'lbl-3' });

    const builder = createLinearAdapterBuilder(secrets, tokenManager);
    const adapter = builder(conn);

    expect(adapter).toBeInstanceOf(LinearAdapter);
    expect((adapter as LinearAdapter).config).toEqual(connectionToLinearConfig(conn));
    // A PAT connection resolves its token source with the 'pat' kind.
    expect(calls).toEqual([{ connectionId: CONNECTION_ID, kind: 'pat' }]);
  });

  it('routes an OAuth connection through the token manager (not the raw refresh token)', () => {
    const { secrets, calls } = fakeSecrets();
    const { tokenManager, accessCalls } = fakeTokenManager();
    const conn = connection({ authMode: 'oauth' });

    const adapter = createLinearAdapterBuilder(secrets, tokenManager)(conn);

    expect(adapter).toBeInstanceOf(LinearAdapter);
    // OAuth no longer wraps the raw refresh token via connectionTokenSource —
    // the secret store is never asked for a token source on the OAuth path.
    expect(calls).toEqual([]);
    // The access token is minted lazily by the token manager only when a request
    // is actually issued; building the adapter alone must not trigger a mint.
    expect(accessCalls).toEqual([]);
  });

  it('throws for a provider with no registered adapter factory', () => {
    const { secrets } = fakeSecrets();
    const { tokenManager } = fakeTokenManager();
    // A valid AdapterName that isn't registered in ADAPTER_REGISTRY (only 'linear' is).
    const conn = { ...connection(), provider: 'github' } as unknown as Connection;

    expect(() => createLinearAdapterBuilder(secrets, tokenManager)(conn)).toThrow(
      /No adapter registered for provider: github/,
    );
  });
});

/**
 * TER-37 — per-file push scope: `planPushForConnection`/`runSyncPush` thread an
 * optional `filePath` straight into `sourceCanonicalItems`, so the file-scoped
 * source can return just that file's items. Omitting `filePath` must call the
 * source with `undefined`, leaving the whole-vault path behavior-identical.
 */
describe('filePath threading into sourceCanonicalItems (TER-37)', () => {
  /** Deps whose `sourceCanonicalItems` records each (vaultPath, filePath) call. */
  function recordingDeps(items: CanonicalItem[]): {
    deps: SyncOrchestratorDeps;
    sourceCalls: Array<{ vaultPath: string; filePath?: string }>;
  } {
    const sourceCalls: Array<{ vaultPath: string; filePath?: string }> = [];
    const conn = connection();
    return {
      sourceCalls,
      deps: {
        resolveVaultRoot: () => VAULT_PATH,
        readConnection: (_vaultPath, connectionId) =>
          connectionId === conn.connectionId ? conn : undefined,
        sourceCanonicalItems: (vaultPath, filePath) => {
          sourceCalls.push({ vaultPath, filePath });
          return items;
        },
        listLinks: () => [],
        writeLink: () => undefined,
        buildAdapter: () => fakeAdapter(),
        now: () => FIXED_NOW,
      },
    };
  }

  it('planPushForConnection forwards filePath into the item source', () => {
    const { deps, sourceCalls } = recordingDeps([item({ localId: 'prd/x.md' })]);

    planPushForConnection(CONNECTION_ID, deps, 'prd/x.md');

    expect(sourceCalls).toEqual([{ vaultPath: VAULT_PATH, filePath: 'prd/x.md' }]);
  });

  it('planPushForConnection passes filePath=undefined when omitted (whole-vault)', () => {
    const { deps, sourceCalls } = recordingDeps([item({ localId: 'a' })]);

    planPushForConnection(CONNECTION_ID, deps);

    expect(sourceCalls).toEqual([{ vaultPath: VAULT_PATH, filePath: undefined }]);
  });

  it('runSyncPush forwards filePath into the item source', async () => {
    const { deps, sourceCalls } = recordingDeps([item({ localId: 'prd/y.md' })]);

    await runSyncPush(CONNECTION_ID, deps, () => true, 'prd/y.md');

    expect(sourceCalls).toEqual([{ vaultPath: VAULT_PATH, filePath: 'prd/y.md' }]);
  });

  it('runSyncPush passes filePath=undefined when omitted (whole-vault)', async () => {
    const { deps, sourceCalls } = recordingDeps([item({ localId: 'a' })]);

    await runSyncPush(CONNECTION_ID, deps);

    expect(sourceCalls).toEqual([{ vaultPath: VAULT_PATH, filePath: undefined }]);
  });
});
