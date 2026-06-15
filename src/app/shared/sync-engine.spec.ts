import { describe, expect, it } from 'vitest';
import {
  computeItemHash,
  diffItem,
  planPush,
  serializeItemForHash,
  topologicalSort,
  type SyncLinkResolver,
} from '../../../electron/sync/sync-engine';
import type { CanonicalItem } from '../../../electron/sync/canonical-item';
import type { SyncLink } from '../../../electron/db/repositories/sync-links.repo';

/** Minimal CanonicalItem factory keeping tests terse. */
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

const orderedIds = (items: CanonicalItem[]): string[] => items.map((i) => i.localId);

describe('topologicalSort', () => {
  it('orders parents before children across every level', () => {
    const epic = item({ localId: 'e1', level: 'epic' });
    const feature = item({ localId: 'f1', level: 'feature', parentLocalId: 'e1' });
    const story = item({ localId: 's1', level: 'story', parentLocalId: 'f1' });
    const criterion = item({ localId: 'c1', level: 'criterion', parentLocalId: 's1' });

    // Provide them out of hierarchy order to prove the sort, not the input, decides.
    const { ordered, cycles } = topologicalSort([criterion, story, feature, epic]);

    expect(orderedIds(ordered)).toEqual(['e1', 'f1', 's1', 'c1']);
    expect(cycles).toEqual([]);
  });

  it('preserves input order for independent and sibling items (stable)', () => {
    const root = item({ localId: 'e1', level: 'epic' });
    const b = item({ localId: 'b', level: 'feature', parentLocalId: 'e1' });
    const a = item({ localId: 'a', level: 'feature', parentLocalId: 'e1' });
    const c = item({ localId: 'c', level: 'feature', parentLocalId: 'e1' });
    const independent = item({ localId: 'z', level: 'epic' });

    const { ordered } = topologicalSort([root, b, a, c, independent]);

    // Roots keep input order; siblings of e1 keep their input order (b, a, c).
    expect(orderedIds(ordered)).toEqual(['e1', 'z', 'b', 'a', 'c']);
  });

  it('treats a dangling parentLocalId as a root without crashing', () => {
    const orphan = item({ localId: 's1', parentLocalId: 'missing-parent' });
    const root = item({ localId: 'e1', level: 'epic' });

    const { ordered, cycles } = topologicalSort([root, orphan]);

    expect(orderedIds(ordered)).toEqual(['e1', 's1']);
    expect(cycles).toEqual([]);
  });

  it('is cycle-safe: returns all nodes and reports the cycle without looping', () => {
    const a = item({ localId: 'A', parentLocalId: 'B' });
    const b = item({ localId: 'B', parentLocalId: 'A' });

    const { ordered, cycles } = topologicalSort([a, b]);

    // Every node is still present in the output...
    expect(orderedIds(ordered).sort()).toEqual(['A', 'B']);
    // ...and the offending ids are reported.
    expect(cycles).toHaveLength(1);
    expect(cycles[0].sort()).toEqual(['A', 'B']);
  });

  it('returns empty results for empty input', () => {
    expect(topologicalSort([])).toEqual({ ordered: [], cycles: [] });
  });

  it('treats a self-referential parentLocalId as a root, not a cycle', () => {
    const selfParent = item({ localId: 'x', parentLocalId: 'x' });

    const { ordered, cycles } = topologicalSort([selfParent]);

    expect(orderedIds(ordered)).toEqual(['x']);
    expect(cycles).toEqual([]);
  });

  it('emits every node and reports nodes downstream of a cycle', () => {
    const root = item({ localId: 'r', level: 'epic' });
    const a = item({ localId: 'A', parentLocalId: 'B' });
    const b = item({ localId: 'B', parentLocalId: 'A' });
    const downstream = item({ localId: 'D', parentLocalId: 'A' });

    const { ordered, cycles } = topologicalSort([root, a, b, downstream]);

    // The acyclic root is emitted first, then every cyclic/downstream node.
    expect(ordered[0].localId).toBe('r');
    expect(orderedIds(ordered).sort()).toEqual(['A', 'B', 'D', 'r']);
    // Unemitted nodes (the cycle plus its downstream child) are reported together.
    expect(cycles).toHaveLength(1);
    expect(cycles[0].sort()).toEqual(['A', 'B', 'D']);
  });

  it('does not crash or double-emit on duplicate localIds', () => {
    const first = item({ localId: 'dup', title: 'first' });
    const parent = item({ localId: 'p', level: 'epic' });
    const second = item({ localId: 'dup', title: 'second', parentLocalId: 'p' });

    const { ordered } = topologicalSort([first, parent, second]);

    // Each distinct id appears exactly once; no duplicate emission.
    expect(orderedIds(ordered).filter((id) => id === 'dup')).toHaveLength(1);
    expect(orderedIds(ordered)).toContain('p');
  });
});

describe('serializeItemForHash / computeItemHash', () => {
  it('is deterministic for the same item', () => {
    const i = item({ localId: 'x', description: 'd', criteria: ['a', 'b'], tags: ['t'] });
    expect(computeItemHash(i)).toBe(computeItemHash(i));
  });

  it('omits undefined fields from the serialization', () => {
    const i = item({ localId: 'x', level: 'epic', title: 'T' });
    expect(serializeItemForHash(i)).toBe(JSON.stringify({ level: 'epic', title: 'T' }));
  });

  it('emits content fields in the fixed key order', () => {
    const i = item({
      localId: 'x',
      level: 'story',
      title: 'T',
      description: 'D',
      criteria: ['c1'],
      tags: ['tag'],
      parentLocalId: 'p',
    });
    expect(serializeItemForHash(i)).toBe(
      JSON.stringify({
        level: 'story',
        title: 'T',
        description: 'D',
        criteria: ['c1'],
        tags: ['tag'],
        parentLocalId: 'p',
      }),
    );
  });

  it('changes when a content field changes', () => {
    const before = item({ localId: 'x', title: 'before' });
    const after = item({ localId: 'x', title: 'after' });
    expect(computeItemHash(before)).not.toBe(computeItemHash(after));
  });

  it('changes when criteria are reordered (order is content)', () => {
    const a = item({ localId: 'x', criteria: ['one', 'two'] });
    const b = item({ localId: 'x', criteria: ['two', 'one'] });
    expect(computeItemHash(a)).not.toBe(computeItemHash(b));
  });

  it('does not change when only localId changes (identity is not content)', () => {
    const base = { level: 'story', title: 'same', description: 'd' } as const;
    const a = item({ localId: 'id-a', ...base });
    const b = item({ localId: 'id-b', ...base });
    expect(computeItemHash(a)).toBe(computeItemHash(b));
  });
});

describe('diffItem', () => {
  it('returns create when there is no link', () => {
    const i = item({ localId: 'x' });
    const diff = diffItem(i, null);
    expect(diff.decision).toBe('create');
    expect(diff.hash).toBe(computeItemHash(i));
    expect(diff.link).toBeUndefined();
  });

  it('returns update when the stored hash is stale', () => {
    const i = item({ localId: 'x' });
    const diff = diffItem(i, link('x', 'stale-hash'));
    expect(diff.decision).toBe('update');
    expect(diff.link).toBeDefined();
    expect(diff.hash).toBe(computeItemHash(i));
  });

  it('returns skip when the stored hash matches the current hash', () => {
    const i = item({ localId: 'x' });
    const diff = diffItem(i, link('x', computeItemHash(i)));
    expect(diff.decision).toBe('skip');
    expect(diff.link).toBeDefined();
  });
});

describe('planPush over a mixed tree (AC)', () => {
  it('orders parents first and decides create/update/skip per item', () => {
    const epic = item({ localId: 'e1', level: 'epic', title: 'Epic' });
    // brand-new: no link -> create
    const freshFeature = item({
      localId: 'f-new',
      level: 'feature',
      title: 'New',
      parentLocalId: 'e1',
    });
    // changed: link hash is stale -> update
    const changedFeature = item({
      localId: 'f-chg',
      level: 'feature',
      title: 'Changed',
      parentLocalId: 'e1',
    });
    // unchanged: link hash matches current -> skip
    const unchangedStory = item({
      localId: 's-keep',
      level: 'story',
      title: 'Keep',
      parentLocalId: 'f-chg',
    });

    const links: SyncLink[] = [
      link('e1', computeItemHash(epic)), // epic unchanged -> skip
      link('f-chg', 'OUTDATED'), // stale -> update
      link('s-keep', computeItemHash(unchangedStory)), // current -> skip
    ];

    // Feed in a non-topological order to exercise the sort.
    const { ordered, cycles } = planPush(
      [unchangedStory, changedFeature, freshFeature, epic],
      resolverFrom(links),
    );

    // Parents precede children: e1 before its features; f-chg before s-keep.
    const ids = ordered.map((d) => d.item.localId);
    expect(ids.indexOf('e1')).toBeLessThan(ids.indexOf('f-new'));
    expect(ids.indexOf('e1')).toBeLessThan(ids.indexOf('f-chg'));
    expect(ids.indexOf('f-chg')).toBeLessThan(ids.indexOf('s-keep'));

    const decisionsById = new Map(ordered.map((d) => [d.item.localId, d.decision] as const));
    expect(decisionsById.get('e1')).toBe('skip');
    expect(decisionsById.get('f-new')).toBe('create');
    expect(decisionsById.get('f-chg')).toBe('update');
    expect(decisionsById.get('s-keep')).toBe('skip');

    expect(cycles).toEqual([]);
  });
});
