import { describe, expect, it } from 'vitest';
import { executePush, type PushExecutionDeps } from '../../../electron/sync/executor';
import type {
  IAdapter,
  ExternalItemResult,
  ProjectMetadata,
  CreateItemContext,
} from '../../../electron/sync/adapter';
import type { CanonicalItem } from '../../../electron/sync/canonical-item';
import type { ItemDiff, PushPlan, SyncDecision } from '../../../electron/sync/sync-engine';
import type { SyncLink } from '../../../electron/db/repositories/sync-links.repo';

const CONNECTION_ID = 'conn-1';
const FIXED_NOW = '2026-06-15T00:00:00.000Z';

/** Minimal CanonicalItem factory keeping tests terse (mirrors sync-engine.spec). */
function item(partial: Partial<CanonicalItem> & Pick<CanonicalItem, 'localId'>): CanonicalItem {
  return {
    level: 'story',
    title: `title-${partial.localId}`,
    ...partial,
  };
}

/** Minimal SyncLink factory; supplies the existing external handle for update/skip. */
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

/** Build an ItemDiff for a given decision; attaches a link for update/skip. */
function diff(
  it: CanonicalItem,
  decision: SyncDecision,
  opts: { hash?: string; link?: SyncLink } = {},
): ItemDiff {
  const hash = opts.hash ?? `hash-${it.localId}`;
  if (decision === 'create') return { item: it, decision, hash };
  const l = opts.link ?? link(it.localId, decision === 'skip' ? hash : 'stale');
  return { item: it, decision, hash, link: l };
}

/** Wrap a list of diffs as an acyclic PushPlan (no cycles). */
function plan(ordered: ItemDiff[]): PushPlan {
  return { ordered, cycles: [] };
}

interface CreateCall {
  item: CanonicalItem;
  /** The container context the engine threaded in (TER-20); undefined when absent. */
  context?: CreateItemContext;
}
interface UpdateCall {
  id: string;
  item: CanonicalItem;
}
interface LinkCall {
  parentId: string;
  childIds: string[];
}

/**
 * In-memory fake adapter. `createItem` returns a synthetic handle derived from the
 * item's localId and records the call; `failOn` localIds throw to exercise
 * partial failure. All calls are captured in order for assertions.
 */
function fakeAdapter(
  opts: {
    failCreate?: Set<string>;
    failUpdate?: Set<string>;
    failLink?: Set<string>; // by child external id
  } = {},
): IAdapter & {
  creates: CreateCall[];
  updates: UpdateCall[];
  links: LinkCall[];
} {
  const creates: CreateCall[] = [];
  const updates: UpdateCall[] = [];
  const links: LinkCall[] = [];
  const failCreate = opts.failCreate ?? new Set<string>();
  const failUpdate = opts.failUpdate ?? new Set<string>();
  const failLink = opts.failLink ?? new Set<string>();

  return {
    name: 'linear',
    creates,
    updates,
    links,
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
    linkItems(parentId: string, childIds: string[]): Promise<void> {
      links.push({ parentId, childIds });
      if (childIds.some((c) => failLink.has(c))) {
        return Promise.reject(new Error(`linkItems failed for ${childIds.join(',')}`));
      }
      return Promise.resolve();
    },
    // The push executor never reads remote state; this stub only satisfies the
    // read-direction half of IAdapter (TER-23) so the fake still typechecks.
    getRemoteState(): Promise<null> {
      return Promise.resolve(null);
    },
  };
}

/** Build deps with an in-memory writeLink capture and a fixed clock. */
function fakeDeps(adapter: IAdapter): {
  deps: PushExecutionDeps;
  writtenLinks: SyncLink[];
} {
  const writtenLinks: SyncLink[] = [];
  return {
    writtenLinks,
    deps: {
      adapter,
      writeLink: (l) => writtenLinks.push(l),
      now: () => FIXED_NOW,
    },
  };
}

describe('executePush — order & dispatch', () => {
  it('dispatches create/update/skip to the right adapter methods', async () => {
    const a = item({ localId: 'a', level: 'epic' });
    const b = item({ localId: 'b', level: 'feature' });
    const c = item({ localId: 'c', level: 'story' });
    const adapter = fakeAdapter();
    const { deps, writtenLinks } = fakeDeps(adapter);

    const result = await executePush(
      plan([diff(a, 'create'), diff(b, 'update'), diff(c, 'skip')]),
      CONNECTION_ID,
      deps,
    );

    // create -> createItem, update -> updateItem, skip -> neither.
    expect(adapter.creates.map((cc) => cc.item.localId)).toEqual(['a']);
    expect(adapter.updates.map((uu) => uu.item.localId)).toEqual(['b']);
    expect(adapter.links).toHaveLength(0);

    expect(result.created).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);

    // Only create/update wrote links; skip did not.
    expect(writtenLinks.map((l) => l.specItemId).sort()).toEqual(['a', 'b']);
  });

  it('calls createItem in plan.ordered order', async () => {
    const items = ['p', 'q', 'r', 's'].map((id) => item({ localId: id }));
    const adapter = fakeAdapter();
    const { deps } = fakeDeps(adapter);

    await executePush(
      plan(items.map((it) => diff(it, 'create'))),
      CONNECTION_ID,
      deps,
    );

    expect(adapter.creates.map((cc) => cc.item.localId)).toEqual(['p', 'q', 'r', 's']);
  });
});

describe('executePush — parent id capture & threading (AC #2)', () => {
  it('links a created child to the PARENT created earlier in the pass', async () => {
    // A feature→story edge: neither is a container, so the generic native parent
    // link path runs (epic→feature container membership is covered separately).
    const parent = item({ localId: 'e1', level: 'feature' });
    const child = item({ localId: 'f1', level: 'story', parentLocalId: 'e1' });
    const adapter = fakeAdapter();
    const { deps } = fakeDeps(adapter);

    const result = await executePush(
      plan([diff(parent, 'create'), diff(child, 'create')]),
      CONNECTION_ID,
      deps,
    );

    // linkItems(parentExternalId, [childExternalId]) — captured parent id, not localId.
    expect(adapter.links).toEqual([{ parentId: 'ext-e1', childIds: ['ext-f1'] }]);

    const childResult = result.results.find((r) => r.localId === 'f1');
    expect(childResult?.linked).toBe(true);
    expect(childResult?.linkError).toBeUndefined();
  });
});

describe('executePush — skipped/updated parent still links children (AC #2)', () => {
  it('links a created child to a SKIPPED parent via the parent link external id', async () => {
    // Non-container feature→story edge so the generic parent-link path runs.
    const parent = item({ localId: 'e1', level: 'feature' });
    const child = item({ localId: 'f1', level: 'story', parentLocalId: 'e1' });
    const adapter = fakeAdapter();
    const { deps } = fakeDeps(adapter);

    // Parent is skip (unchanged) and carries its existing external handle EXT-e1.
    const result = await executePush(
      plan([diff(parent, 'skip', { hash: 'h' }), diff(child, 'create')]),
      CONNECTION_ID,
      deps,
    );

    expect(adapter.links).toEqual([{ parentId: 'EXT-e1', childIds: ['ext-f1'] }]);
    expect(result.results.find((r) => r.localId === 'f1')?.linked).toBe(true);
  });

  it('links a created child to an UPDATED parent via the parent link external id', async () => {
    // Non-container feature→story edge so the generic parent-link path runs.
    const parent = item({ localId: 'e1', level: 'feature' });
    const child = item({ localId: 'f1', level: 'story', parentLocalId: 'e1' });
    const adapter = fakeAdapter();
    const { deps } = fakeDeps(adapter);

    const result = await executePush(
      plan([diff(parent, 'update'), diff(child, 'create')]),
      CONNECTION_ID,
      deps,
    );

    expect(adapter.links).toEqual([{ parentId: 'EXT-e1', childIds: ['ext-f1'] }]);
    expect(result.results.find((r) => r.localId === 'f1')?.linked).toBe(true);
  });
});

describe('executePush — SyncLink only on success (AC #3)', () => {
  it('writes a SyncLink for created items with diff.hash and the injected timestamp', async () => {
    const a = item({ localId: 'a', level: 'epic' });
    const adapter = fakeAdapter();
    const { deps, writtenLinks } = fakeDeps(adapter);

    await executePush(plan([diff(a, 'create', { hash: 'created-hash' })]), CONNECTION_ID, deps);

    expect(writtenLinks).toEqual([
      {
        specItemId: 'a',
        connectionId: CONNECTION_ID,
        externalId: 'ext-a',
        externalUrl: 'https://x/a',
        lastPushedHash: 'created-hash',
        lastPushedAt: FIXED_NOW,
      },
    ]);
  });

  it('writes a SyncLink for updated items reusing the link external handle and new hash', async () => {
    const b = item({ localId: 'b', level: 'feature' });
    const adapter = fakeAdapter();
    const { deps, writtenLinks } = fakeDeps(adapter);

    await executePush(
      plan([diff(b, 'update', { hash: 'new-hash', link: link('b', 'old-hash') })]),
      CONNECTION_ID,
      deps,
    );

    expect(writtenLinks).toEqual([
      {
        specItemId: 'b',
        connectionId: CONNECTION_ID,
        externalId: 'EXT-b',
        externalUrl: 'https://example.test/b',
        lastPushedHash: 'new-hash',
        lastPushedAt: FIXED_NOW,
      },
    ]);
  });

  it('does NOT write a SyncLink for skipped or failed items', async () => {
    const skipped = item({ localId: 'skip-me' });
    const failing = item({ localId: 'fail-me' });
    const adapter = fakeAdapter({ failCreate: new Set(['fail-me']) });
    const { deps, writtenLinks } = fakeDeps(adapter);

    const result = await executePush(
      plan([diff(skipped, 'skip', { hash: 'h' }), diff(failing, 'create')]),
      CONNECTION_ID,
      deps,
    );

    expect(writtenLinks).toEqual([]);
    expect(result.results.find((r) => r.localId === 'skip-me')?.status).toBe('skipped');
    expect(result.results.find((r) => r.localId === 'fail-me')?.status).toBe('failed');
  });
});

describe('executePush — partial-failure isolation (AC #4)', () => {
  it('isolates a mid-list create failure; links before AND after stay intact', async () => {
    // before (create) -> boom (create, fails) -> after (create). All independent.
    const before = item({ localId: 'before' });
    const boom = item({ localId: 'boom' });
    const after = item({ localId: 'after' });
    const adapter = fakeAdapter({ failCreate: new Set(['boom']) });
    const { deps, writtenLinks } = fakeDeps(adapter);

    const result = await executePush(
      plan([diff(before, 'create'), diff(boom, 'create'), diff(after, 'create')]),
      CONNECTION_ID,
      deps,
    );

    // Loop completed over all three, in order.
    expect(adapter.creates.map((cc) => cc.item.localId)).toEqual(['before', 'boom', 'after']);

    // The failed item is `failed`, no link written for it.
    const boomResult = result.results.find((r) => r.localId === 'boom');
    expect(boomResult?.status).toBe('failed');
    expect(boomResult?.error).toContain('boom');

    // Links written for the items before AND after the failure survive.
    expect(writtenLinks.map((l) => l.specItemId)).toEqual(['before', 'after']);

    expect(result.created).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.updated).toBe(0);
  });

  it('records a failed update without a link write and continues', async () => {
    const ok = item({ localId: 'ok' });
    const bad = item({ localId: 'bad' });
    const adapter = fakeAdapter({ failUpdate: new Set(['bad']) });
    const { deps, writtenLinks } = fakeDeps(adapter);

    const result = await executePush(
      plan([diff(bad, 'update'), diff(ok, 'create')]),
      CONNECTION_ID,
      deps,
    );

    expect(result.results.find((r) => r.localId === 'bad')?.status).toBe('failed');
    expect(writtenLinks.map((l) => l.specItemId)).toEqual(['ok']);
    expect(result.failed).toBe(1);
    expect(result.created).toBe(1);
  });

  it('a link failure flags linkError but keeps the child created and its link written', async () => {
    // Non-container feature→story edge so a real linkItems call is attempted.
    const parent = item({ localId: 'e1', level: 'feature' });
    const child = item({ localId: 'f1', level: 'story', parentLocalId: 'e1' });
    // Linking the child's external id throws.
    const adapter = fakeAdapter({ failLink: new Set(['ext-f1']) });
    const { deps, writtenLinks } = fakeDeps(adapter);

    const result = await executePush(
      plan([diff(parent, 'create'), diff(child, 'create')]),
      CONNECTION_ID,
      deps,
    );

    const childResult = result.results.find((r) => r.localId === 'f1');
    // Child create still succeeded...
    expect(childResult?.status).toBe('created');
    // ...the link is flagged, not the item...
    expect(childResult?.linked).toBe(false);
    expect(childResult?.linkError).toContain('linkItems failed');
    // ...and the already-written SyncLink for the child is intact.
    expect(writtenLinks.map((l) => l.specItemId).sort()).toEqual(['e1', 'f1']);
    expect(result.created).toBe(2);
    expect(result.failed).toBe(0);
  });
});

describe('executePush — child of a failed parent (AC #4)', () => {
  it('creates the child but reports linked=false with a linkError; other branches unaffected', async () => {
    // Branch 1: parent p1 fails to create; its child c1 still creates but can't link.
    // Branch 2: parent p2 + child c2 both succeed and link fine.
    // Non-container feature→story edges so the generic native parent-link path runs.
    const p1 = item({ localId: 'p1', level: 'feature' });
    const c1 = item({ localId: 'c1', level: 'story', parentLocalId: 'p1' });
    const p2 = item({ localId: 'p2', level: 'feature' });
    const c2 = item({ localId: 'c2', level: 'story', parentLocalId: 'p2' });
    const adapter = fakeAdapter({ failCreate: new Set(['p1']) });
    const { deps, writtenLinks } = fakeDeps(adapter);

    const result = await executePush(
      plan([diff(p1, 'create'), diff(c1, 'create'), diff(p2, 'create'), diff(c2, 'create')]),
      CONNECTION_ID,
      deps,
    );

    // Failed parent: failed, no link.
    expect(result.results.find((r) => r.localId === 'p1')?.status).toBe('failed');

    // Orphaned child: created, but link could not be attempted.
    const c1Result = result.results.find((r) => r.localId === 'c1');
    expect(c1Result?.status).toBe('created');
    expect(c1Result?.linked).toBe(false);
    expect(c1Result?.linkError).toBe('parent external id unavailable');

    // The unrelated branch is unaffected: c2 links to p2's captured external id.
    expect(result.results.find((r) => r.localId === 'c2')?.linked).toBe(true);
    expect(adapter.links).toEqual([{ parentId: 'ext-p2', childIds: ['ext-c2'] }]);

    // No link call was made for the orphaned child.
    expect(adapter.links.some((l) => l.childIds.includes('ext-c1'))).toBe(false);

    // Links written for everything that succeeded (c1, p2, c2) — but not the failed p1.
    expect(writtenLinks.map((l) => l.specItemId).sort()).toEqual(['c1', 'c2', 'p2']);
    expect(result.created).toBe(3);
    expect(result.failed).toBe(1);
  });
});

describe('executePush — data-error & edge cases', () => {
  it('marks an `update` diff with no SyncLink as failed without calling the adapter or writing a link', async () => {
    // A well-formed plan never produces this, but a corrupt diff must fail
    // gracefully rather than call updateItem with no id.
    const orphan = item({ localId: 'no-link' });
    const adapter = fakeAdapter();
    const { deps, writtenLinks } = fakeDeps(adapter);

    // Hand-build the malformed diff: decision `update` but no `link`.
    const malformed: ItemDiff = { item: orphan, decision: 'update', hash: 'h' };

    const result = await executePush(plan([malformed]), CONNECTION_ID, deps);

    const r = result.results.find((rr) => rr.localId === 'no-link');
    expect(r?.status).toBe('failed');
    expect(r?.error).toContain('missing its SyncLink external id');
    expect(adapter.updates).toHaveLength(0);
    expect(writtenLinks).toEqual([]);
    expect(result.failed).toBe(1);
    expect(result.updated).toBe(0);
  });

  it('handles an empty plan: no adapter calls, no links, zeroed tallies', async () => {
    const adapter = fakeAdapter();
    const { deps, writtenLinks } = fakeDeps(adapter);

    const result = await executePush(plan([]), CONNECTION_ID, deps);

    expect(adapter.creates).toHaveLength(0);
    expect(adapter.updates).toHaveLength(0);
    expect(adapter.links).toHaveLength(0);
    expect(writtenLinks).toEqual([]);
    expect(result).toEqual({ results: [], created: 0, updated: 0, skipped: 0, failed: 0 });
  });

  it('does not crash on a cyclic plan where a child precedes its parent; flags the link', async () => {
    // topologicalSort appends cycle members in input order, so a child can be seen
    // before its parent's external id exists. The child still creates; its link is
    // flagged unavailable rather than throwing.
    const child = item({ localId: 'c', level: 'feature', parentLocalId: 'p' });
    const parent = item({ localId: 'p', level: 'epic', parentLocalId: 'c' });
    const adapter = fakeAdapter();
    const { deps, writtenLinks } = fakeDeps(adapter);

    // Child first (as a cycle would order it), parent second; cycles reported.
    const cyclic: PushPlan = {
      ordered: [diff(child, 'create'), diff(parent, 'create')],
      cycles: [['c', 'p']],
    };

    const result = await executePush(cyclic, CONNECTION_ID, deps);

    // Both items were created and their links written.
    expect(adapter.creates.map((cc) => cc.item.localId)).toEqual(['c', 'p']);
    expect(writtenLinks.map((l) => l.specItemId).sort()).toEqual(['c', 'p']);

    // The child saw no parent id yet, so its link is flagged unavailable.
    const childResult = result.results.find((r) => r.localId === 'c');
    expect(childResult?.status).toBe('created');
    expect(childResult?.linked).toBe(false);
    expect(childResult?.linkError).toBe('parent external id unavailable');

    // The parent's own create succeeded; it links to the child captured earlier.
    expect(adapter.links).toEqual([{ parentId: 'ext-c', childIds: ['ext-p'] }]);
    expect(result.created).toBe(2);
    expect(result.failed).toBe(0);
  });
});

/**
 * TER-20: Epic → Project container membership. The fake adapter reports
 * `name: 'linear'`, and Linear maps `epic` to a project container
 * (`containerForChildren: true`). So an Epic owns itself, its descendants inherit
 * that owner, and a child whose parent IS its container joins via `projectId` at
 * create rather than a native parent link — the executor threads the owner into
 * `createItem`'s context and skips `linkItems` for the epic→feature edge.
 */
describe('executePush — Epic container membership (TER-20)', () => {
  it('threads the epic project into the feature and skips its parent link', async () => {
    const epic = item({ localId: 'e1', level: 'epic' });
    const feature = item({ localId: 'f1', level: 'feature', parentLocalId: 'e1' });
    const adapter = fakeAdapter();
    const { deps, writtenLinks } = fakeDeps(adapter);

    const result = await executePush(
      plan([diff(epic, 'create'), diff(feature, 'create')]),
      CONNECTION_ID,
      deps,
    );

    // The feature was created with its epic's project as the container context.
    const featureCreate = adapter.creates.find((c) => c.item.localId === 'f1');
    expect(featureCreate?.context).toEqual({ projectExternalId: 'ext-e1' });

    // The epic IS the feature's container, so no native parent link is emitted.
    expect(adapter.links).toHaveLength(0);
    const featureResult = result.results.find((r) => r.localId === 'f1');
    expect(featureResult?.linked).toBe(true);
    expect(featureResult?.linkError).toBeUndefined();

    // Both SyncLinks were still written.
    expect(writtenLinks.map((l) => l.specItemId).sort()).toEqual(['e1', 'f1']);
  });

  it('inherits the epic project down to a story but preserves the feature→story sub-issue link', async () => {
    const epic = item({ localId: 'e1', level: 'epic' });
    const feature = item({ localId: 'f1', level: 'feature', parentLocalId: 'e1' });
    const story = item({ localId: 's1', level: 'story', parentLocalId: 'f1' });
    const adapter = fakeAdapter();
    const { deps } = fakeDeps(adapter);

    const result = await executePush(
      plan([diff(epic, 'create'), diff(feature, 'create'), diff(story, 'create')]),
      CONNECTION_ID,
      deps,
    );

    // The story inherits the epic's project (its nearest container ancestor).
    const storyCreate = adapter.creates.find((c) => c.item.localId === 's1');
    expect(storyCreate?.context).toEqual({ projectExternalId: 'ext-e1' });

    // The story's parent is the feature, NOT the container, so the sub-issue link
    // is preserved: linkItems fires with the feature's and story's external ids.
    expect(adapter.links).toEqual([{ parentId: 'ext-f1', childIds: ['ext-s1'] }]);
    expect(result.results.find((r) => r.localId === 's1')?.linked).toBe(true);
  });

  it('threads a SKIPPED epic project (from its link) into a re-pushed feature', async () => {
    const epic = item({ localId: 'e1', level: 'epic' });
    const feature = item({ localId: 'f1', level: 'feature', parentLocalId: 'e1' });
    const adapter = fakeAdapter();
    const { deps } = fakeDeps(adapter);

    // Re-push: the epic is unchanged (skip) and carries its project handle EXT-e1;
    // the feature is created and must still receive that project as its container.
    const result = await executePush(
      plan([diff(epic, 'skip', { hash: 'h' }), diff(feature, 'create')]),
      CONNECTION_ID,
      deps,
    );

    const featureCreate = adapter.creates.find((c) => c.item.localId === 'f1');
    expect(featureCreate?.context).toEqual({ projectExternalId: 'EXT-e1' });

    // The feature's parent (the skipped epic) IS its container, so no parent link.
    expect(adapter.links).toHaveLength(0);
    expect(result.results.find((r) => r.localId === 'f1')?.linked).toBe(true);
  });
});
