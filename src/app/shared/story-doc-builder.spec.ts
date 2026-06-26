import { describe, expect, it } from 'vitest';
import {
  buildProposedContent,
  type ProposedStory,
} from '../../../electron/sync/story-doc-builder';
import { parseMarkedHeadings } from '../../../electron/sync/story-markers';
import { buildTaskItemsFromContent } from '../../../electron/sync/task-items';

/**
 * The story-doc builder (TER-37, reworked) appends AI-authored stories under a
 * plain `## User Stories` section of an existing feature doc: it preserves ALL
 * existing content verbatim (epic, background/goals/context, prior stories), tags
 * ONLY the new `### <story>` headings with a fresh `sf:id`, and never tags the epic
 * or theme headings.
 */
const story = (over: Partial<ProposedStory> = {}): ProposedStory => ({
  title: 'Log in with email',
  role: 'returning user',
  capability: 'log in with email and password',
  benefit: 'I can access my workspace',
  acceptanceCriteria: ['Valid credentials land on the dashboard.', 'Invalid credentials error out.'],
  ...over,
});

describe('buildProposedContent', () => {
  it('appends a NEW story under a freshly-created "## User Stories" section', () => {
    const existing = '# Authentication\n\nCovers sign-in.\n';
    const result = buildProposedContent(existing, [story()]);

    expect(result.storiesAdded).toBe(1);
    expect(result.sectionCreated).toBe(true);

    const headings = parseMarkedHeadings(result.content);
    // The epic H1 is NOT tagged (only stories are tagged now).
    const h1 = headings.find((h) => h.level === 1)!;
    expect(h1.title).toBe('Authentication');
    expect(h1.id).toBeNull();

    // A plain (untagged) "## User Stories" section heading was created.
    const section = headings.find((h) => h.level === 2 && h.title === 'User Stories')!;
    expect(section.id).toBeNull();

    // The new story is an H3 carrying a marker; the heading is the SHORT title now
    // (the "As a …" statement renders in the body, not the heading).
    const storyHeading = headings.find((h) => h.level === 3)!;
    expect(storyHeading.id).not.toBeNull();
    expect(storyHeading.title).toBe('Log in with email');
    // The statement renders as a body prose line.
    expect(result.content).toContain(
      'As a returning user, I want log in with email and password, so that I can access my workspace',
    );
    // Acceptance criteria rendered as a nested bullet list.
    expect(result.content).toContain('- Acceptance criteria:');
    expect(result.content).toContain('  - Valid credentials land on the dashboard.');
  });

  it('renders the structured sections (statement, description, AC, open questions, risks) in order, omitting empty ones', () => {
    const existing = '# Epic\n';
    const result = buildProposedContent(existing, [
      story({
        title: 'Reset password',
        role: 'locked-out user',
        capability: 'reset my password',
        benefit: 'I regain access',
        description: 'Covers the email reset link and its expiry window.',
        acceptanceCriteria: ['A reset link is emailed.', 'The link expires after an hour.'],
        openQuestions: ['Should the link be single-use?'],
        risks: ['Reset emails may land in spam.'],
      }),
    ]);

    const idx = (needle: string): number => result.content.indexOf(needle);
    // Every section is present…
    expect(idx('### Reset password')).toBeGreaterThanOrEqual(0);
    expect(idx('As a locked-out user, I want reset my password, so that I regain access')).toBeGreaterThanOrEqual(0);
    expect(idx('Covers the email reset link and its expiry window.')).toBeGreaterThanOrEqual(0);
    expect(idx('- Acceptance criteria:')).toBeGreaterThanOrEqual(0);
    expect(idx('  - A reset link is emailed.')).toBeGreaterThanOrEqual(0);
    expect(idx('- Open questions:')).toBeGreaterThanOrEqual(0);
    expect(idx('  - Should the link be single-use?')).toBeGreaterThanOrEqual(0);
    expect(idx('- Risks:')).toBeGreaterThanOrEqual(0);
    expect(idx('  - Reset emails may land in spam.')).toBeGreaterThanOrEqual(0);
    // …and rendered in format order.
    expect(idx('### Reset password')).toBeLessThan(idx('As a locked-out user'));
    expect(idx('As a locked-out user')).toBeLessThan(idx('Covers the email reset link'));
    expect(idx('Covers the email reset link')).toBeLessThan(idx('- Acceptance criteria:'));
    expect(idx('- Acceptance criteria:')).toBeLessThan(idx('- Open questions:'));
    expect(idx('- Open questions:')).toBeLessThan(idx('- Risks:'));
  });

  it('omits empty sections — a story with only AC renders no statement/description/open-questions/risks', () => {
    const result = buildProposedContent('# Epic\n', [
      { title: 'Export the report', acceptanceCriteria: ['A CSV downloads.'] },
    ]);
    expect(result.content).toContain('### Export the report');
    expect(result.content).toContain('- Acceptance criteria:');
    expect(result.content).not.toContain('As a ');
    expect(result.content).not.toContain('- Open questions:');
    expect(result.content).not.toContain('- Risks:');
  });

  it('uses the plain title when role/capability/benefit are absent', () => {
    const existing = '# Epic\n';
    const result = buildProposedContent(existing, [
      { title: 'Export the report', acceptanceCriteria: ['A CSV downloads.'] },
    ]);
    const storyHeading = parseMarkedHeadings(result.content).find((h) => h.level === 3)!;
    expect(storyHeading.title).toBe('Export the report');
  });

  it('preserves ALL existing content verbatim — including background prose and prior stories', () => {
    const existing = [
      '# Authentication',
      '',
      '## Background',
      '',
      'Important context that must survive untouched.',
      '',
      '## User Stories',
      '',
      '### As a user, I want to log in, so that I work <!-- sf:id storyA -->',
      '',
      '- Acceptance criteria:',
      '  - Hand-edited criterion that must survive.',
    ].join('\n');

    const result = buildProposedContent(existing, [
      story({ title: 'Reset password', capability: 'reset my password', benefit: 'I regain access' }),
    ]);

    // Existing background prose + the prior tagged story are preserved byte-for-byte.
    expect(result.content).toContain('Important context that must survive untouched.');
    expect(result.content).toContain('### As a user, I want to log in, so that I work <!-- sf:id storyA -->');
    expect(result.content).toContain('  - Hand-edited criterion that must survive.');
    // The existing section was reused — no second "## User Stories" heading.
    expect(result.sectionCreated).toBe(false);
    const sections = parseMarkedHeadings(result.content).filter(
      (h) => h.level === 2 && h.title === 'User Stories',
    );
    expect(sections).toHaveLength(1);
  });

  it('appends NEW stories into an EXISTING "## User Stories" section without duplicating the heading', () => {
    const existing = [
      '# Authentication',
      '',
      '## User Stories',
      '',
      '### As a user, I want to log in, so that I work <!-- sf:id storyA -->',
    ].join('\n');

    const result = buildProposedContent(existing, [
      story({ title: 'Stay signed in', capability: 'stay signed in', benefit: 'I avoid re-auth' }),
    ]);

    expect(result.sectionCreated).toBe(false);

    // Two flat tagged stories now extract from the doc (the existing + the new).
    const items = buildTaskItemsFromContent('prd/auth.md', result.content);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.localId)).toContain('storyA');
    expect(items.every((i) => i.level === 'story' && i.parentLocalId === undefined)).toBe(true);
  });

  it('tags ONLY the story headings — never the epic or theme headings', () => {
    const existing = '# Authentication\n\n## Some Theme\n\nProse under a theme.\n';
    const result = buildProposedContent(existing, [story()]);

    const headings = parseMarkedHeadings(result.content);
    // Epic + the pre-existing theme stay untagged.
    expect(headings.find((h) => h.level === 1)!.id).toBeNull();
    expect(headings.find((h) => h.level === 2 && h.title === 'Some Theme')!.id).toBeNull();
    // Only the H3 story carries a marker.
    const marked = headings.filter((h) => h.id !== null);
    expect(marked).toHaveLength(1);
    expect(marked[0].level).toBe(3);
  });

  it('empty stories → returns the content unchanged with zero counts', () => {
    const existing = '# Authentication\n\nProse.\n';
    const result = buildProposedContent(existing, []);
    expect(result.content).toBe(existing);
    expect(result.storiesAdded).toBe(0);
    expect(result.sectionCreated).toBe(false);
  });

  it('mints unique ids for every new story (no collisions within a batch)', () => {
    const existing = '# Epic\n';
    const result = buildProposedContent(existing, [
      story({ title: 'A', capability: 'do a', benefit: 'b' }),
      story({ title: 'C', capability: 'do c', benefit: 'd' }),
      story({ title: 'E', capability: 'do e', benefit: 'f' }),
    ]);
    const ids = parseMarkedHeadings(result.content)
      .map((h) => h.id)
      .filter((id): id is string => id !== null);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the resulting story items carry the marker id as their localId (idempotency anchor)', () => {
    const existing = '# Authentication\n';
    const result = buildProposedContent(existing, [story()]);
    const storyHeading = parseMarkedHeadings(result.content).find((h) => h.level === 3)!;

    const items = buildTaskItemsFromContent('prd/auth.md', result.content);
    const storyItem = items.find((i) => i.level === 'story')!;
    // The localId IS the marker id — not a heading-derived anchor.
    expect(storyItem.localId).toBe(storyHeading.id);
  });

  it('re-running keeps the existing tagged story’s localId stable (update, not duplicate)', () => {
    // First run: one story is added + tagged.
    const first = buildProposedContent('# Epic\n', [story({ title: 'First' })]);
    const firstId = parseMarkedHeadings(first.content).find((h) => h.level === 3)!.id!;

    // Second run: the first story stays verbatim (its id unchanged), a new one is
    // appended into the SAME section.
    const second = buildProposedContent(first.content, [story({ title: 'Second' })]);
    const ids = buildTaskItemsFromContent('prd/x.md', second.content).map((i) => i.localId);
    expect(ids).toContain(firstId); // the original story's identity is preserved
    expect(ids).toHaveLength(2);
  });

  it('round-trips a fully-structured story through render → extract into one CanonicalItem', () => {
    const result = buildProposedContent('# Epic\n', [
      story({
        title: 'Reset password',
        role: 'locked-out user',
        capability: 'reset my password',
        benefit: 'I regain access',
        description: 'Covers the email reset link.',
        acceptanceCriteria: ['A reset link is emailed.'],
        openQuestions: ['Single-use link?'],
        risks: ['Emails may be flagged as spam.'],
      }),
    ]);

    const items = buildTaskItemsFromContent('prd/auth.md', result.content);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.title).toBe('Reset password');
    expect(item.criteria).toEqual(['A reset link is emailed.']);
    expect(item.description).toContain('As a locked-out user, I want reset my password, so that I regain access');
    expect(item.description).toContain('Covers the email reset link.');
    expect(item.description).toContain('**Open questions**');
    expect(item.description).toContain('- Single-use link?');
    expect(item.description).toContain('**Risks**');
    expect(item.description).toContain('- Emails may be flagged as spam.');
  });

  it('idempotency: hand-adding an open question to a tagged story keeps its localId (update, not duplicate)', () => {
    // First run renders + tags one story with ONLY acceptance criteria (no
    // statement/description), so its composed description starts out undefined.
    const first = buildProposedContent('# Epic\n', [
      { title: 'Reset password', acceptanceCriteria: ['A reset link is emailed.'] },
    ]);
    const beforeItems = buildTaskItemsFromContent('prd/auth.md', first.content);
    const id = beforeItems[0].localId;
    expect(beforeItems[0].description).toBeUndefined();

    // Simulate a user editing the doc to add an "- Open questions:" section under the
    // SAME tagged heading (the marker id is untouched).
    const edited = first.content.replace(
      '  - A reset link is emailed.',
      '  - A reset link is emailed.\n- Open questions:\n  - Single-use link?',
    );

    const afterItems = buildTaskItemsFromContent('prd/auth.md', edited);
    // Same localId → the push UPDATES the same Linear issue, never duplicates it.
    expect(afterItems).toHaveLength(1);
    expect(afterItems[0].localId).toBe(id);
    // The new section flows into the composed description (so the issue re-syncs).
    expect(afterItems[0].description).toContain('**Open questions**');
    expect(afterItems[0].description).toContain('- Single-use link?');
  });

  it('is fence-aware: a fenced "## User Stories" example is NOT treated as the real section, and the new stories DO push', () => {
    // The doc demonstrates the convention INSIDE a code fence. A fence-unaware
    // builder would splice the new `### story` line into that fence — corrupting
    // the example AND hiding the story from the fence-aware extractor (push reports
    // N added but pushes 0). There is no REAL `## User Stories` section here.
    const existing = [
      '# Authentication',
      '',
      '## Background',
      '',
      'The convention looks like this:',
      '',
      '```md',
      '## User Stories',
      '',
      '### As a user, I want X, so that Y <!-- sf:id example -->',
      '```',
    ].join('\n');

    const result = buildProposedContent(existing, [
      { title: 'Reset password', acceptanceCriteria: ['A reset link is emailed.'] },
    ]);

    // A real section was created (the fenced one was correctly ignored).
    expect(result.sectionCreated).toBe(true);
    expect(result.storiesAdded).toBe(1);

    // The fenced example survives byte-for-byte — it was never spliced into.
    expect(result.content).toContain(
      '```md\n## User Stories\n\n### As a user, I want X, so that Y <!-- sf:id example -->\n```',
    );

    // The REAL new story is extracted and DOES push; the fenced `sf:id example`
    // marker stays inert (the regression the fence-awareness fixes).
    const items = buildTaskItemsFromContent('prd/auth.md', result.content);
    expect(items).toHaveLength(1);
    expect(items[0].localId).not.toBe('example');
    expect(items[0].level).toBe('story');
    expect(items[0].title).toBe('Reset password');
  });

  it('is fence-aware: appends into the REAL "## User Stories" section even when a fenced example precedes it', () => {
    // Both a fenced example section AND a real section exist. The new story must
    // land in the REAL one (after the existing real story), not the fenced example.
    const existing = [
      '# Authentication',
      '',
      '## Background',
      '',
      '```md',
      '## User Stories',
      '### Example only <!-- sf:id example -->',
      '```',
      '',
      '## User Stories',
      '',
      '### As a user, I want to log in, so that I work <!-- sf:id real1 -->',
    ].join('\n');

    const result = buildProposedContent(existing, [story({ title: 'Reset password' })]);

    // The existing real section was reused — no duplicate heading was created.
    expect(result.sectionCreated).toBe(false);

    // The fenced example is preserved verbatim and its marker stays inert.
    expect(result.content).toContain('```md\n## User Stories\n### Example only <!-- sf:id example -->\n```');

    // Only the real existing story + the new one push — never the fenced example.
    const items = buildTaskItemsFromContent('prd/auth.md', result.content);
    expect(items.map((i) => i.localId)).toContain('real1');
    expect(items.map((i) => i.localId)).not.toContain('example');
    expect(items).toHaveLength(2);
  });
});
