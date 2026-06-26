import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  buildCanonicalItemsForVault,
  buildTaskItemsForFile,
  buildTaskItemsFromContent,
  specToCanonicalItems,
  type SpecDoc,
} from '../../../electron/sync/spec-to-canonical';
import type { CanonicalItem } from '../../../electron/sync/canonical-item';
import { planPush } from '../../../electron/sync/sync-engine';

/**
 * `collectSpecDocs` / `buildCanonicalItemsForVault` are the thin impure reader
 * (a recursive `<root>/prd` `.md` walk + `readFileSync`, both wrapped in
 * try/catch that returns `[]`/skips on a missing folder or unreadable file).
 * They are intentionally NOT exercised here: there is no real vault in the unit
 * environment and a tmp-dir fixture would add cross-platform fs flakiness for
 * little signal. The PURE core ({@link specToCanonicalItems}) carries all the
 * parsing logic and is covered exhaustively below; the reader only sorts docs by
 * relPath and feeds them to the core, which the deterministic-ordering test
 * below verifies at the core boundary.
 */

const doc = (relPath: string, content: string): SpecDoc => ({ relPath, content });

/** Indexes emitted items by localId for terse assertions. */
const byId = (items: CanonicalItem[]): Map<string, CanonicalItem> =>
  new Map(items.map((i) => [i.localId, i] as const));

/** A realistic stories doc matching the create-stories prompt's output. */
const AUTH_STORIES = `# Authentication

Covers how users sign in and recover access.

## Sign-in

The primary credential flow.

- As a returning user, I want to log in with email and password, so that I can access my workspace.
  - Acceptance criteria:
    - Given valid credentials, the session is created and I land on the dashboard.
    - Given invalid credentials, a non-specific error is shown.
- As a user, I want to stay signed in across restarts, so that I don't re-authenticate constantly.
  - Acceptance criteria:
    - A persisted session is restored on app launch.

## Account recovery

- As a user, I want to reset my password, so that I can regain access if I forget it.
  - Acceptance criteria:
    - A reset link is emailed to a registered address.
    - The link expires after 30 minutes.
`;

describe('specToCanonicalItems — levels & wiring', () => {
  it('emits epic, features and stories with criteria from a realistic stories doc', () => {
    const items = specToCanonicalItems([doc('prd/auth-stories.md', AUTH_STORIES)]);
    const map = byId(items);

    const epicId = 'prd/auth-stories.md';
    const signInId = `${epicId}#sign-in`;
    const recoveryId = `${epicId}#account-recovery`;

    // Epic
    const epic = map.get(epicId)!;
    expect(epic.level).toBe('epic');
    expect(epic.title).toBe('Authentication');
    expect(epic.parentLocalId).toBeUndefined();
    expect(epic.description).toBe('Covers how users sign in and recover access.');

    // Features
    const signIn = map.get(signInId)!;
    expect(signIn.level).toBe('feature');
    expect(signIn.title).toBe('Sign-in');
    expect(signIn.parentLocalId).toBe(epicId);
    // The feature's own prose survives; story/criteria lines are lifted out.
    expect(signIn.description).toBe('The primary credential flow.');

    const recovery = map.get(recoveryId)!;
    expect(recovery.level).toBe('feature');
    expect(recovery.parentLocalId).toBe(epicId);

    // Stories (ordinal anchors within each feature)
    const story1 = map.get(`${signInId}/s1`)!;
    expect(story1.level).toBe('story');
    expect(story1.parentLocalId).toBe(signInId);
    expect(story1.title).toBe(
      'As a returning user, I want to log in with email and password, so that I can access my workspace.',
    );
    expect(story1.criteria).toEqual([
      'Given valid credentials, the session is created and I land on the dashboard.',
      'Given invalid credentials, a non-specific error is shown.',
    ]);

    const story2 = map.get(`${signInId}/s2`)!;
    expect(story2.criteria).toEqual(['A persisted session is restored on app launch.']);

    const recoveryStory = map.get(`${recoveryId}/s1`)!;
    expect(recoveryStory.parentLocalId).toBe(recoveryId);
    expect(recoveryStory.criteria).toEqual([
      'A reset link is emailed to a registered address.',
      'The link expires after 30 minutes.',
    ]);
  });

  it('every non-epic item resolves to an emitted parent; epics have none', () => {
    const items = specToCanonicalItems([doc('prd/auth-stories.md', AUTH_STORIES)]);
    const ids = new Set(items.map((i) => i.localId));
    for (const item of items) {
      if (item.level === 'epic') {
        expect(item.parentLocalId).toBeUndefined();
      } else {
        expect(item.parentLocalId).toBeDefined();
        expect(ids.has(item.parentLocalId!)).toBe(true);
      }
    }
  });
});

describe('specToCanonicalItems — story recognition paths', () => {
  it('recognizes "As a …" lines (case-insensitive, bullet-tolerant)', () => {
    const md = `# Epic

## Feature
* AS AN admin, I WANT to revoke tokens, so that compromised sessions die.
`;
    const items = specToCanonicalItems([doc('prd/x.md', md)]);
    const story = items.find((i) => i.level === 'story')!;
    expect(story.title).toBe(
      'AS AN admin, I WANT to revoke tokens, so that compromised sessions die.',
    );
    expect(story.localId).toBe('prd/x.md#feature/s1');
  });

  it('falls back to ### H3 headings as stories when a feature has no "As a …" lines', () => {
    const md = `# Epic

## Feature without user-story lines

### First capability

Some detail about the first capability.

- Acceptance criteria:
  - It does the first thing.

### Second capability

- Acceptance criteria:
  - It does the second thing.
`;
    const items = specToCanonicalItems([doc('prd/y.md', md)]);
    const stories = items.filter((i) => i.level === 'story');
    expect(stories.map((s) => s.title)).toEqual(['First capability', 'Second capability']);
    // H3-fallback stories use slugged anchors, not ordinals.
    expect(stories[0].localId).toBe('prd/y.md#feature-without-user-story-lines/first-capability');
    expect(stories[0].criteria).toEqual(['It does the first thing.']);
    expect(stories[1].criteria).toEqual(['It does the second thing.']);
  });

  it('prefers "As a …" lines over H3 headings when both are present in a feature', () => {
    const md = `# Epic

## Feature

### A heading that is not a story

- As a user, I want a thing, so that I benefit.
  - Acceptance criteria:
    - The thing happens.
`;
    const items = specToCanonicalItems([doc('prd/z.md', md)]);
    const stories = items.filter((i) => i.level === 'story');
    expect(stories).toHaveLength(1);
    expect(stories[0].title).toBe('As a user, I want a thing, so that I benefit.');
    // The H3 stays in the feature description (not lifted into a story).
    const feature = items.find((i) => i.level === 'feature')!;
    expect(feature.description).toContain('A heading that is not a story');
  });
});

describe('specToCanonicalItems — stable, deterministic ids', () => {
  it('produces identical localIds across two runs on identical input', () => {
    const input = [doc('prd/auth-stories.md', AUTH_STORIES)];
    const first = specToCanonicalItems(input).map((i) => i.localId);
    const second = specToCanonicalItems(input).map((i) => i.localId);
    expect(second).toEqual(first);
  });

  it('honors an explicit frontmatter id: as the epic id; descendants derive from it', () => {
    const md = `---
id: EPIC-AUTH
tags:
  - security
---
# Authentication

## Sign-in
- As a user, I want to log in, so that I can work.
  - Acceptance criteria:
    - It works.
`;
    const items = specToCanonicalItems([doc('prd/auth.md', md)]);
    const map = byId(items);

    expect(map.has('EPIC-AUTH')).toBe(true);
    expect(map.get('EPIC-AUTH')!.level).toBe('epic');
    expect(map.has('EPIC-AUTH#sign-in')).toBe(true);
    expect(map.has('EPIC-AUTH#sign-in/s1')).toBe(true);
    // No relPath-derived epic id when an explicit id is present.
    expect(map.has('prd/auth.md')).toBe(false);
  });

  it('disambiguates duplicate sibling feature anchors deterministically', () => {
    const md = `# Epic

## Setup
- As a user, I want step one, so that I begin.

## Setup
- As a user, I want step two, so that I continue.
`;
    const items = specToCanonicalItems([doc('prd/dup.md', md)]);
    const featureIds = items.filter((i) => i.level === 'feature').map((i) => i.localId);
    expect(featureIds).toEqual(['prd/dup.md#setup', 'prd/dup.md#setup-2']);
  });

  it('all localIds in a batch are unique', () => {
    const items = specToCanonicalItems([doc('prd/auth-stories.md', AUTH_STORIES)]);
    const ids = items.map((i) => i.localId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('specToCanonicalItems — sf:id markers (TER-37)', () => {
  it('uses an H3 story marker id as the localId and strips the marker from the title', () => {
    const md = `# Epic <!-- sf:id epic1 -->

## Sign-in <!-- sf:id theme1 -->

### As a user, I want to log in, so that I work <!-- sf:id storyA -->

- Acceptance criteria:
  - It works.
`;
    const items = specToCanonicalItems([doc('prd/auth.md', md)]);
    const map = byId(items);

    // Each level's localId IS its marker id (not a relPath/anchor derivation).
    expect(map.has('epic1')).toBe(true);
    expect(map.has('theme1')).toBe(true);
    expect(map.has('storyA')).toBe(true);

    // The marker is stripped from every emitted title.
    expect(map.get('epic1')!.title).toBe('Epic');
    expect(map.get('theme1')!.title).toBe('Sign-in');
    expect(map.get('storyA')!.title).toBe('As a user, I want to log in, so that I work');

    // Parent links use marker ids end-to-end.
    expect(map.get('theme1')!.parentLocalId).toBe('epic1');
    expect(map.get('storyA')!.parentLocalId).toBe('theme1');
    expect(map.get('storyA')!.criteria).toEqual(['It works.']);

    // No relPath/anchor-derived ids leak in when markers are present.
    expect(map.has('prd/auth.md')).toBe(false);
    expect(map.has('prd/auth.md#sign-in')).toBe(false);
  });

  it('falls back to the existing derivation when a heading has NO marker', () => {
    const md = `# Epic

## Sign-in <!-- sf:id theme1 -->

### A capability with a marker <!-- sf:id storyA -->

- Acceptance criteria:
  - It works.
`;
    const items = specToCanonicalItems([doc('prd/auth.md', md)]);
    const map = byId(items);

    // Unmarked epic → relPath-derived id; marked theme/story → marker ids.
    expect(map.has('prd/auth.md')).toBe(true);
    expect(map.get('prd/auth.md')!.level).toBe('epic');
    expect(map.has('theme1')).toBe(true);
    expect(map.get('theme1')!.parentLocalId).toBe('prd/auth.md');
    expect(map.has('storyA')).toBe(true);
    expect(map.get('storyA')!.parentLocalId).toBe('theme1');
  });

  it('keeps a MARKED H3 story even when an "As a …" bullet line coexists under the same feature', () => {
    // A hand-written "As a …" bullet alongside a builder-added marked H3 story
    // under the same theme: the marked H3 carries explicit identity and must NOT
    // be dropped (otherwise its SyncLink orphans and the push re-creates it).
    const md = `# Epic <!-- sf:id epic1 -->

## Sign-in <!-- sf:id theme1 -->

- As a user, I want to log in, so that I work.
  - Acceptance criteria:
    - It works.

### As a returning user, I want to stay signed in, so that I avoid re-auth <!-- sf:id storyB -->

- Acceptance criteria:
  - The session persists.
`;
    const items = specToCanonicalItems([doc('prd/auth.md', md)]);
    const stories = items.filter((i) => i.level === 'story');
    // BOTH stories are emitted under the one feature.
    expect(stories).toHaveLength(2);
    expect(stories.map((s) => s.localId)).toContain('storyB');
    expect(stories.every((s) => s.parentLocalId === 'theme1')).toBe(true);
    // The marked H3 keeps its marker id + stripped title + its own criteria.
    const marked = stories.find((s) => s.localId === 'storyB')!;
    expect(marked.title).toBe('As a returning user, I want to stay signed in, so that I avoid re-auth');
    expect(marked.criteria).toEqual(['The session persists.']);
  });

  it('leaves an UNMARKED H3 in the feature description when "As a …" lines coexist (unchanged)', () => {
    // Backward-compat: without a marker, a coexisting H3 stays inert prose in the
    // feature description — it is NOT lifted into a story.
    const md = `# Epic

## Feature

### A heading that is not a story

- As a user, I want a thing, so that I benefit.
  - Acceptance criteria:
    - The thing happens.
`;
    const items = specToCanonicalItems([doc('prd/u.md', md)]);
    const stories = items.filter((i) => i.level === 'story');
    expect(stories).toHaveLength(1);
    const feature = items.find((i) => i.level === 'feature')!;
    expect(feature.description).toContain('A heading that is not a story');
  });

  it('keeps the SAME localId when a marked heading is renamed or reordered', () => {
    const original = `# Epic <!-- sf:id e -->

## Theme one <!-- sf:id t1 -->

### As a user, I want A, so that X <!-- sf:id s1 -->

## Theme two <!-- sf:id t2 -->

### As a user, I want B, so that Y <!-- sf:id s2 -->
`;
    // Rename headings AND swap the two theme blocks; ids must be unchanged.
    const renamedReordered = `# Renamed epic <!-- sf:id e -->

## Theme TWO renamed <!-- sf:id t2 -->

### As an admin, I want B revised, so that Y <!-- sf:id s2 -->

## Theme ONE renamed <!-- sf:id t1 -->

### As an admin, I want A revised, so that X <!-- sf:id s1 -->
`;
    const idsOf = (md: string) =>
      new Set(specToCanonicalItems([doc('prd/x.md', md)]).map((i) => i.localId));

    expect(idsOf(renamedReordered)).toEqual(idsOf(original));
    expect(idsOf(original)).toEqual(new Set(['e', 't1', 's1', 't2', 's2']));
  });
});

describe('specToCanonicalItems — tags', () => {
  it('attaches frontmatter tags (array) to the epic only', () => {
    const md = `---
tags:
  - auth
  - security
---
# Authentication

## Sign-in
- As a user, I want to log in, so that I can work.
`;
    const items = specToCanonicalItems([doc('prd/auth.md', md)]);
    const epic = items.find((i) => i.level === 'epic')!;
    expect(epic.tags).toEqual(['auth', 'security']);
    // Tags live on the epic, not on features or stories.
    for (const item of items) {
      if (item.level !== 'epic') expect(item.tags).toBeUndefined();
    }
  });

  it('coerces a single-string tags value to a one-element array', () => {
    const md = `---
tags: solo
---
# Epic

## Feature
- As a user, I want a thing, so that I benefit.
`;
    const items = specToCanonicalItems([doc('prd/solo.md', md)]);
    expect(items.find((i) => i.level === 'epic')!.tags).toEqual(['solo']);
  });

  it('omits tags when frontmatter has none', () => {
    const items = specToCanonicalItems([doc('prd/auth-stories.md', AUTH_STORIES)]);
    expect(items.find((i) => i.level === 'epic')!.tags).toBeUndefined();
  });
});

describe('specToCanonicalItems — ordering across multiple docs', () => {
  it('emits items grouped per doc, with docs processed in input order', () => {
    // Input is given out of relPath order (b before a). The PURE core preserves
    // input order — sorting by relPath is the reader's job (collectSpecDocs), not
    // the core's — so the emitted epics follow input order, not alphabetical.
    const docs: SpecDoc[] = [
      doc('prd/b.md', `# Beta\n\n## G\n- As a user, I want b, so that y.\n`),
      doc('prd/a.md', `# Alpha\n\n## F\n- As a user, I want a, so that x.\n`),
    ];
    const items = specToCanonicalItems(docs);
    const epics = items.filter((i) => i.level === 'epic').map((i) => i.title);
    expect(epics).toEqual(['Beta', 'Alpha']);

    // Within a doc: epic, then feature, then story — in that source order.
    expect(items.map((i) => i.level)).toEqual([
      'epic',
      'feature',
      'story',
      'epic',
      'feature',
      'story',
    ]);
  });
});

describe('specToCanonicalItems — robustness', () => {
  it('handles CRLF input identically to LF', () => {
    const lf = AUTH_STORIES;
    const crlf = AUTH_STORIES.replace(/\n/g, '\r\n');
    expect(specToCanonicalItems([doc('prd/x.md', crlf)])).toEqual(
      specToCanonicalItems([doc('prd/x.md', lf)]),
    );
  });

  it('skips a doc with no H1 without throwing', () => {
    const md = `## Orphan feature\n- As a user, I want a thing, so that I benefit.\n`;
    expect(specToCanonicalItems([doc('prd/no-h1.md', md)])).toEqual([]);
  });

  it('stops collecting criteria at a blank line, not folding a later bullet in', () => {
    const md = `# Epic

## Feature

- As a user, I want a thing, so that I benefit.
  - Acceptance criteria:
    - First criterion.

  - A separate bullet after a paragraph break, not a criterion.
`;
    const story = specToCanonicalItems([doc('prd/blank.md', md)]).find(
      (i) => i.level === 'story',
    )!;
    expect(story.criteria).toEqual(['First criterion.']);
  });

  it('emits an epic (and features) even when a feature has no stories at all', () => {
    const md = `# Epic

Intro prose.

## Lonely feature

Just a description, no stories or criteria.
`;
    const items = specToCanonicalItems([doc('prd/lonely.md', md)]);
    expect(items.map((i) => i.level)).toEqual(['epic', 'feature']);
    expect(items[1].description).toBe('Just a description, no stories or criteria.');
  });

  it('emits a lone epic for a doc with an H1 but no H2 features', () => {
    const md = `# Just a title\n\nSome narrative with no themes.\n`;
    const items = specToCanonicalItems([doc('prd/title-only.md', md)]);
    expect(items).toHaveLength(1);
    expect(items[0].level).toBe('epic');
    expect(items[0].description).toBe('Some narrative with no themes.');
  });

  it('does not treat a fenced ## heading as a feature (heading parse is fence-aware)', () => {
    const md = `# Epic

## Real feature

\`\`\`md
## Fenced heading that must not become a feature
\`\`\`

- As a user, I want a real thing, so that it counts.
`;
    const items = specToCanonicalItems([doc('prd/fence.md', md)]);
    const features = items.filter((i) => i.level === 'feature');
    expect(features.map((f) => f.title)).toEqual(['Real feature']);
    const stories = items.filter((i) => i.level === 'story');
    expect(stories).toHaveLength(1);
    expect(stories[0].title).toBe('As a user, I want a real thing, so that it counts.');
  });

  it('does not treat a fenced "As a …" line as a story (story scan is fence-aware)', () => {
    const md = `# Epic

## Feature

A worked example of the convention:

\`\`\`md
- As a user, I want THIS to be ignored, so that the fence is respected.
  - Acceptance criteria:
    - This criterion must not be lifted either.
\`\`\`

- As a user, I want the REAL story, so that it counts.
  - Acceptance criteria:
    - The real criterion is captured.
`;
    const items = specToCanonicalItems([doc('prd/fenced-story.md', md)]);
    const stories = items.filter((i) => i.level === 'story');
    expect(stories).toHaveLength(1);
    expect(stories[0].title).toBe('As a user, I want the REAL story, so that it counts.');
    expect(stories[0].criteria).toEqual(['The real criterion is captured.']);
    // The fenced block stays in the feature description, lifted into no story.
    const feature = items.find((i) => i.level === 'feature')!;
    expect(feature.description).toContain('THIS to be ignored');
  });
});

describe('planPush integration (AC)', () => {
  it('feeds converter output into planPush: all creates, topologically ordered', () => {
    const items = specToCanonicalItems([doc('prd/auth-stories.md', AUTH_STORIES)]);
    const plan = planPush(items, () => null);

    // No existing links → every decision is a create.
    expect(plan.ordered.every((d) => d.decision === 'create')).toBe(true);
    expect(plan.cycles).toEqual([]);

    // Topological invariant: every item appears after its parent.
    const position = new Map<string, number>();
    plan.ordered.forEach((d, idx) => position.set(d.item.localId, idx));
    for (const d of plan.ordered) {
      const parent = d.item.parentLocalId;
      if (parent !== undefined) {
        expect(position.get(parent)!).toBeLessThan(position.get(d.item.localId)!);
      }
    }
  });
});

/**
 * `buildTaskItemsForFile` (TER-37, reworked) is the FLAT, stories-only file-scoped
 * reader for the per-file push: read one markdown file (any folder) and emit ONLY
 * its AI-tagged stories (`sf:id` markers) — never the epic, themes, or untagged
 * background/goals/context prose. This is the deliberate divergence from the
 * whole-vault Push button (which still parses the entire heading structure).
 * Exercised against a real tmp-dir vault (cleaned up per test) since the function's
 * whole job is the fs read + flat extraction.
 */
describe('buildTaskItemsForFile (TER-37 — flat, stories-only)', () => {
  let root: string;

  // A realistic feature doc: an epic, BACKGROUND/GOALS prose, and three tagged
  // stories under a plain `## User Stories` section. Only the three tagged stories
  // should ever push.
  const PAYMENTS = `# Payments <!-- sf:id epic1 -->

How customers pay.

## Background

Context the team already agreed on. NOT a story.

## Goals

- Reduce checkout friction.

## User Stories

### Pay with a card <!-- sf:id story-card -->

- Acceptance criteria:
  - A valid card is charged and the order confirms.
  - A declined card shows a recoverable error.

### Save a card for later <!-- sf:id story-save -->

- Acceptance criteria:
  - A saved card appears at next checkout.

### Refund a payment <!-- sf:id story-refund -->
`;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'specforge-ter37-'));
    mkdirSync(path.join(root, 'prd'), { recursive: true });
    writeFileSync(path.join(root, 'prd', 'payments.md'), PAYMENTS, 'utf-8');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('emits EXACTLY the tagged stories — no epic, themes, or background/goals headings', () => {
    const items = buildTaskItemsForFile(root, 'prd/payments.md');

    // Three flat stories, nothing else — the epic + Background + Goals + the plain
    // `## User Stories` heading are all dropped (the key regression for the bug).
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.level === 'story')).toBe(true);
    expect(items.every((i) => i.parentLocalId === undefined)).toBe(true);
    expect(items.map((i) => i.localId)).toEqual(['story-card', 'story-save', 'story-refund']);
    expect(items.map((i) => i.title)).toEqual([
      'Pay with a card',
      'Save a card for later',
      'Refund a payment',
    ]);
  });

  it('attaches each story’s acceptance criteria (or none when absent)', () => {
    const items = buildTaskItemsForFile(root, 'prd/payments.md');
    const byLocal = new Map(items.map((i) => [i.localId, i] as const));
    expect(byLocal.get('story-card')!.criteria).toEqual([
      'A valid card is charged and the order confirms.',
      'A declined card shows a recoverable error.',
    ]);
    expect(byLocal.get('story-save')!.criteria).toEqual(['A saved card appears at next checkout.']);
    // A tagged story with no criteria list carries none.
    expect(byLocal.get('story-refund')!.criteria).toBeUndefined();
  });

  it('story localIds are the marker ids, so a re-run UPDATES rather than duplicates', () => {
    // The flat per-file path and the whole-vault converter both anchor a marked
    // story on its marker id, so the two never duplicate the same story.
    const fileItems = buildTaskItemsForFile(root, 'prd/payments.md');
    const vaultStories = buildCanonicalItemsForVault(root).filter((i) => i.level === 'story');
    const fileIds = new Set(fileItems.map((i) => i.localId));
    for (const story of vaultStories) {
      expect(fileIds.has(story.localId)).toBe(true);
    }
  });

  it('works on a markdown file in any folder (no /prd restriction)', () => {
    mkdirSync(path.join(root, 'notes'), { recursive: true });
    writeFileSync(path.join(root, 'notes', 'idea.md'), PAYMENTS, 'utf-8');

    const items = buildTaskItemsForFile(root, 'notes/idea.md');
    expect(items.map((i) => i.localId)).toEqual(['story-card', 'story-save', 'story-refund']);
  });

  it('returns [] for a missing file rather than throwing', () => {
    expect(buildTaskItemsForFile(root, 'prd/does-not-exist.md')).toEqual([]);
  });

  it('returns [] for a file with no tagged stories (only prose / untagged headings)', () => {
    writeFileSync(
      path.join(root, 'prd', 'prose.md'),
      '# Just an epic\n\n## Background\n\nNo tagged stories here.\n',
      'utf-8',
    );
    expect(buildTaskItemsForFile(root, 'prd/prose.md')).toEqual([]);
  });

  // The `/push-file` path (no-AI re-push of a disk doc that already has structured
  // tagged stories) must yield items with the FULL structured `description` —
  // statement + description + open questions + risks — not title+criteria only.
  it('carries the FULL structured description for a tagged story on disk (push-file path)', () => {
    const structured = [
      '# Auth <!-- sf:id epic1 -->',
      '',
      '## User Stories',
      '',
      '### Reset password <!-- sf:id story-reset -->',
      '',
      'As a locked-out user, I want reset my password, so that I regain access',
      '',
      'Covers the email reset link and its expiry window.',
      '',
      '- Acceptance criteria:',
      '  - A reset link is emailed.',
      '- Open questions:',
      '  - Should the link be single-use?',
      '- Risks:',
      '  - Reset emails may land in spam.',
      '',
    ].join('\n');
    writeFileSync(path.join(root, 'prd', 'auth.md'), structured, 'utf-8');

    const [item] = buildTaskItemsForFile(root, 'prd/auth.md');
    expect(item.localId).toBe('story-reset');
    expect(item.title).toBe('Reset password');
    // The composed description carries the statement + description + open questions
    // + risks — exactly what the renderer previews and the combined push sends.
    expect(item.description).toContain(
      'As a locked-out user, I want reset my password, so that I regain access',
    );
    expect(item.description).toContain('Covers the email reset link and its expiry window.');
    expect(item.description).toContain('**Open questions**');
    expect(item.description).toContain('- Should the link be single-use?');
    expect(item.description).toContain('**Risks**');
    expect(item.description).toContain('- Reset emails may land in spam.');
    // AC stays on `criteria` for the adapter checklist, never in the body.
    expect(item.criteria).toEqual(['A reset link is emailed.']);
    expect(item.description).not.toContain('A reset link is emailed.');
  });
});

/**
 * Routing-guard lock (TER-37 bug): the whole-vault converter
 * ({@link specToCanonicalItems}, reached only by the explicit no-filePath Push
 * button) is FLAT-dropping for stories — it emits a story as `{title, criteria}`
 * only, LOSING the structured description (statement/description/open-questions/
 * risks). This is precisely why the combined `/decompose-stories` execute must NOT
 * re-plan from disk through this converter, and why a per-file execute must never
 * silently fall back to it. This test pins that lossy behavior so the routing guard
 * can never quietly route a structured push through here.
 */
describe('specToCanonicalItems — whole-vault converter DROPS structured story fields (routing-guard lock)', () => {
  const STRUCTURED_DOC = `# Auth <!-- sf:id epic1 -->

## User Stories

### Reset password <!-- sf:id story-reset -->

As a locked-out user, I want reset my password, so that I regain access

Covers the email reset link and its expiry window.

- Acceptance criteria:
  - A reset link is emailed.
- Open questions:
  - Should the link be single-use?
- Risks:
  - Reset emails may land in spam.
`;

  it('no story from the whole-vault converter carries the structured open-questions/risks body', () => {
    const stories = specToCanonicalItems([doc('prd/auth.md', STRUCTURED_DOC)]).filter(
      (i) => i.level === 'story',
    );

    // Whatever the converter recognizes as stories here, NONE carries the structured
    // body (open questions / risks) — that data is dropped on the floor. This is the
    // exact loss the combined push avoids by pushing the previewed in-memory items.
    expect(stories.length).toBeGreaterThan(0);
    for (const story of stories) {
      expect(story.description ?? '').not.toContain('**Open questions**');
      expect(story.description ?? '').not.toContain('**Risks**');
    }
  });

  it('the per-file FLAT builder KEEPS the structured body the whole-vault converter drops', () => {
    // Same marker id from BOTH paths (the idempotency anchor), but only the per-file
    // FLAT builder — which the per-file reader and the renderer preview share —
    // carries the structured statement / description / open questions / risks.
    const wholeVaultMarked = specToCanonicalItems([doc('prd/auth.md', STRUCTURED_DOC)]).find(
      (i) => i.localId === 'story-reset',
    );
    const [flat] = buildTaskItemsFromContent('prd/auth.md', STRUCTURED_DOC);

    // The marked story id survives in both paths…
    expect(flat.localId).toBe('story-reset');
    if (wholeVaultMarked) expect(wholeVaultMarked.localId).toBe('story-reset');
    // …but only the per-file builder keeps the structured body.
    expect(flat.description).toContain('As a locked-out user');
    expect(flat.description).toContain('**Open questions**');
    expect(flat.description).toContain('**Risks**');
  });
});
