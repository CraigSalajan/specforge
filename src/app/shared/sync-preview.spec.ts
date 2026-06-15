import { describe, expect, it } from 'vitest';
import { buildPushPreview, type PreviewNode } from '../../../electron/sync/preview';
import { computeItemHash, planPush, type SyncLinkResolver } from '../../../electron/sync/sync-engine';
import type { CanonicalItem } from '../../../electron/sync/canonical-item';
import type { SyncLink } from '../../../electron/db/repositories/sync-links.repo';

/** Minimal CanonicalItem factory keeping tests terse (mirrors sync-engine.spec.ts). */
function item(partial: Partial<CanonicalItem> & Pick<CanonicalItem, 'localId'>): CanonicalItem {
  return {
    level: 'story',
    title: `title-${partial.localId}`,
    ...partial,
  };
}

/** Minimal SyncLink factory; only `specItemId` and `lastPushedHash` matter here. */
function link(specItemId: string, lastPushedHash: string): SyncLink {
  return {
    specItemId,
    connectionId: 'conn-1',
    externalId: `EXT-${specItemId}`,
    externalUrl: `https://example.test/${specItemId}`,
    lastPushedHash,
    lastPushedAt: '2026-06-15T00:00:00.000Z',
  };
}

/** Build a map-backed resolver from a list of links (mirrors per-connection lookup). */
function resolverFrom(links: SyncLink[]): SyncLinkResolver {
  const byId = new Map(links.map((l) => [l.specItemId, l] as const));
  return (specItemId) => byId.get(specItemId) ?? null;
}

/** Depth-first flatten of a preview forest into a flat node list. */
function flatten(nodes: PreviewNode[]): PreviewNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}

/** Find a node anywhere in the tree by localId. */
function findNode(tree: { roots: PreviewNode[] }, localId: string): PreviewNode | undefined {
  return flatten(tree.roots).find((n) => n.localId === localId);
}

describe('buildPushPreview', () => {
  it('nests epic → feature → story → criterion fed out of order into one root chain', () => {
    const epic = item({ localId: 'e1', level: 'epic' });
    const feature = item({ localId: 'f1', level: 'feature', parentLocalId: 'e1' });
    const story = item({ localId: 's1', level: 'story', parentLocalId: 'f1' });
    const criterion = item({ localId: 'c1', level: 'criterion', parentLocalId: 's1' });

    // Out of hierarchy order to prove the tree, not the input, decides nesting.
    const plan = planPush([criterion, story, feature, epic], resolverFrom([]));
    const tree = buildPushPreview(plan, 'linear');

    expect(tree.roots).toHaveLength(1);
    const root = tree.roots[0];
    expect(root.localId).toBe('e1');
    expect(root.children.map((n) => n.localId)).toEqual(['f1']);
    expect(root.children[0].children.map((n) => n.localId)).toEqual(['s1']);
    expect(root.children[0].children[0].children.map((n) => n.localId)).toEqual(['c1']);
    // The deepest node has no further children.
    expect(root.children[0].children[0].children[0].children).toEqual([]);
    expect(tree.cycles).toEqual([]);
  });

  it('promotes an item with a dangling parentLocalId to a top-level root', () => {
    const root = item({ localId: 'e1', level: 'epic' });
    const orphan = item({ localId: 's1', parentLocalId: 'missing-parent' });

    const plan = planPush([root, orphan], resolverFrom([]));
    const tree = buildPushPreview(plan, 'linear');

    expect(tree.roots.map((n) => n.localId).sort()).toEqual(['e1', 's1']);
    const orphanNode = findNode(tree, 's1')!;
    expect(orphanNode.children).toEqual([]);
    expect(orphanNode.inCycle).toBe(false);
  });

  it('treats a self-referential parentLocalId as a root, never nesting a node under itself', () => {
    // The engine emits a self-parent node as a normal root (it is NOT reported in
    // `cycles`), so the preview's `parentId !== node.localId` guard is the only
    // thing preventing the node being attached to its own `children` — which would
    // make the tree circular (un-serializable, infinite to walk). Pin that here.
    const selfParent = item({ localId: 'x', parentLocalId: 'x' });

    const plan = planPush([selfParent], resolverFrom([]));
    const tree = buildPushPreview(plan, 'linear');

    expect(tree.roots.map((n) => n.localId)).toEqual(['x']);
    const selfNode = findNode(tree, 'x')!;
    expect(selfNode.inCycle).toBe(false);
    expect(selfNode.children).toEqual([]);
    // The forest is finite/acyclic: flattening terminates and yields exactly one node.
    expect(flatten(tree.roots)).toHaveLength(1);
  });

  it('assigns the right decision per node and rolls counts up (incl. total)', () => {
    const epic = item({ localId: 'e1', level: 'epic', title: 'Epic' });
    const freshFeature = item({
      localId: 'f-new',
      level: 'feature',
      title: 'New',
      parentLocalId: 'e1',
    });
    const changedFeature = item({
      localId: 'f-chg',
      level: 'feature',
      title: 'Changed',
      parentLocalId: 'e1',
    });
    const unchangedStory = item({
      localId: 's-keep',
      level: 'story',
      title: 'Keep',
      parentLocalId: 'f-chg',
    });

    // Seed matching links exactly like sync-engine.spec.ts so skips are genuine.
    const links: SyncLink[] = [
      link('e1', computeItemHash(epic)), // unchanged -> skip
      link('f-chg', 'OUTDATED'), // stale -> update
      link('s-keep', computeItemHash(unchangedStory)), // current -> skip
      // f-new has no link -> create
    ];

    const plan = planPush(
      [unchangedStory, changedFeature, freshFeature, epic],
      resolverFrom(links),
    );
    const tree = buildPushPreview(plan, 'linear');

    expect(findNode(tree, 'e1')!.decision).toBe('skip');
    expect(findNode(tree, 'f-new')!.decision).toBe('create');
    expect(findNode(tree, 'f-chg')!.decision).toBe('update');
    expect(findNode(tree, 's-keep')!.decision).toBe('skip');

    expect(tree.counts).toEqual({ create: 1, update: 1, skip: 2, total: 4 });
  });

  it('resolves provider-native type and representation per level (linear)', () => {
    const epic = item({ localId: 'e1', level: 'epic' });
    const criterion = item({ localId: 'c1', level: 'criterion', parentLocalId: 'e1' });

    const plan = planPush([epic, criterion], resolverFrom([]));
    const tree = buildPushPreview(plan, 'linear');

    const epicNode = findNode(tree, 'e1')!;
    expect(epicNode.provider).toBe('linear');
    expect(epicNode.nativeType).toBe('Project');
    expect(epicNode.representation).toBe('item');

    const criterionNode = findNode(tree, 'c1')!;
    expect(criterionNode.nativeType).toBe('Description');
    expect(criterionNode.representation).toBe('inline');
  });

  it('resolves a criterion as a native Task item on ado', () => {
    const criterion = item({ localId: 'c1', level: 'criterion' });

    const plan = planPush([criterion], resolverFrom([]));
    const tree = buildPushPreview(plan, 'ado');

    const criterionNode = findNode(tree, 'c1')!;
    expect(criterionNode.provider).toBe('ado');
    expect(criterionNode.nativeType).toBe('Task');
    expect(criterionNode.representation).toBe('item');
  });

  it('carries externalId/externalUrl on update/skip nodes and leaves create nodes undefined', () => {
    const created = item({ localId: 'c-new' });
    const updated = item({ localId: 'u1' });
    const skipped = item({ localId: 'k1' });

    const links: SyncLink[] = [
      link('u1', 'STALE'), // stale -> update
      link('k1', computeItemHash(skipped)), // current -> skip
    ];

    const plan = planPush([created, updated, skipped], resolverFrom(links));
    const tree = buildPushPreview(plan, 'linear');

    const createNode = findNode(tree, 'c-new')!;
    expect(createNode.decision).toBe('create');
    expect(createNode.externalId).toBeUndefined();
    expect(createNode.externalUrl).toBeUndefined();

    const updateNode = findNode(tree, 'u1')!;
    expect(updateNode.decision).toBe('update');
    expect(updateNode.externalId).toBe('EXT-u1');
    expect(updateNode.externalUrl).toBe('https://example.test/u1');

    const skipNode = findNode(tree, 'k1')!;
    expect(skipNode.decision).toBe('skip');
    expect(skipNode.externalId).toBe('EXT-k1');
    expect(skipNode.externalUrl).toBe('https://example.test/k1');
  });

  it('summarizes content presence (description, criteria count, tag count)', () => {
    const rich = item({
      localId: 'rich',
      description: 'a body',
      criteria: ['one', 'two'],
      tags: ['t'],
    });
    const bare = item({ localId: 'bare' });

    const plan = planPush([rich, bare], resolverFrom([]));
    const tree = buildPushPreview(plan, 'linear');

    expect(findNode(tree, 'rich')!.summary).toEqual({
      hasDescription: true,
      criteriaCount: 2,
      tagCount: 1,
    });
    expect(findNode(tree, 'bare')!.summary).toEqual({
      hasDescription: false,
      criteriaCount: 0,
      tagCount: 0,
    });
  });

  it('flags both members of a 2-node cycle as inCycle roots and terminates', () => {
    const a = item({ localId: 'A', parentLocalId: 'B' });
    const b = item({ localId: 'B', parentLocalId: 'A' });

    // If the forward pass ever recursed into a cycle this call would hang.
    const plan = planPush([a, b], resolverFrom([]));
    const tree = buildPushPreview(plan, 'linear');

    expect(tree.roots.map((n) => n.localId).sort()).toEqual(['A', 'B']);
    expect(findNode(tree, 'A')!.inCycle).toBe(true);
    expect(findNode(tree, 'B')!.inCycle).toBe(true);
    // Cycle members are flagged roots, never nested.
    expect(findNode(tree, 'A')!.children).toEqual([]);
    expect(findNode(tree, 'B')!.children).toEqual([]);
    expect(tree.cycles.length).toBeGreaterThan(0);
  });

  it('flags a node downstream of a cycle as a root instead of nesting it under a cycle member', () => {
    // A↔B form a 2-node cycle; D hangs off A. The engine cannot order any of the
    // three, so all land in `cycles`. The preview's `!node.inCycle` guard must keep
    // D a flagged root rather than nesting it under its (also-cyclic) parent A —
    // otherwise a cycle member would gain children and the tree would no longer be
    // a clean, finite forest of cycle roots.
    const a = item({ localId: 'A', parentLocalId: 'B' });
    const b = item({ localId: 'B', parentLocalId: 'A' });
    const downstream = item({ localId: 'D', parentLocalId: 'A' });

    const plan = planPush([a, b, downstream], resolverFrom([]));
    const tree = buildPushPreview(plan, 'linear');

    expect(tree.roots.map((n) => n.localId).sort()).toEqual(['A', 'B', 'D']);
    for (const id of ['A', 'B', 'D']) {
      const node = findNode(tree, id)!;
      expect(node.inCycle).toBe(true);
      expect(node.children).toEqual([]);
    }
    // Every node is surfaced exactly once and the forest stays finite.
    expect(flatten(tree.roots)).toHaveLength(3);
  });

  it('returns an empty tree and zeroed counts for an empty plan', () => {
    const tree = buildPushPreview({ ordered: [], cycles: [] }, 'linear');
    expect(tree).toEqual({
      roots: [],
      counts: { create: 0, update: 0, skip: 0, total: 0 },
      cycles: [],
    });
  });

  it('does not mutate the input plan or its canonical items', () => {
    const epic = item({ localId: 'e1', level: 'epic' });
    const feature = item({ localId: 'f1', level: 'feature', parentLocalId: 'e1' });

    const plan = planPush([epic, feature], resolverFrom([]));
    const orderedLengthBefore = plan.ordered.length;
    const cyclesBefore = plan.cycles;

    buildPushPreview(plan, 'linear');

    // The plan's array identity and length are untouched.
    expect(plan.ordered).toHaveLength(orderedLengthBefore);
    expect(plan.cycles).toBe(cyclesBefore);
    // No `children` array leaked onto the original canonical items.
    for (const diff of plan.ordered) {
      expect('children' in diff.item).toBe(false);
    }
    // The source items themselves are unchanged.
    expect(epic).toEqual({ localId: 'e1', level: 'epic', title: 'title-e1' });
    expect(feature).toEqual({
      localId: 'f1',
      level: 'feature',
      title: 'title-f1',
      parentLocalId: 'e1',
    });
  });
});
