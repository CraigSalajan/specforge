import { describe, expect, it } from 'vitest';
import { buildTaskItemsFromContent } from '../../../electron/sync/task-items';

/**
 * `buildTaskItemsFromContent` (TER-37, reworked) is the PURE, FLAT, stories-only
 * builder for the combined-review preview AND the per-file push: ONLY the AI-tagged
 * stories (`sf:id` markers) become items — never the epic, themes, or untagged
 * background/goals/context prose — and each is a flat `level:'story'` item with no
 * `parentLocalId`. This is the regression guard for the user's complaint that the
 * push was pulling in the whole heading structure.
 */
describe('buildTaskItemsFromContent', () => {
  const DOC = [
    '# Auth feature <!-- sf:id epicX -->', // even a marked epic must NOT be extracted
    '',
    '## Background',
    '',
    'Why we are building this. Not a story.',
    '',
    '## Goals',
    '',
    '- Make sign-in painless.',
    '',
    '## User Stories',
    '',
    '### Log in with email <!-- sf:id s-login -->',
    '',
    '- Acceptance criteria:',
    '  - Valid credentials land on the dashboard.',
    '  - Invalid credentials show an error.',
    '',
    '### Reset password <!-- sf:id s-reset -->',
  ].join('\n');

  it('emits FLAT story items only — drops the marked epic, Background/Goals/User-Stories headings and prose', () => {
    const items = buildTaskItemsFromContent('prd/auth.md', DOC);

    // ONLY the two `### story` headings — the marked epic H1 is dropped too.
    expect(items.map((i) => i.localId)).toEqual(['s-login', 's-reset']);
    // Every item is a FLAT story (no epic/feature levels, no parent links).
    expect(items.every((i) => i.level === 'story')).toBe(true);
    expect(items.every((i) => i.parentLocalId === undefined)).toBe(true);
  });

  it('attaches criteria, omitting the field when a story has none', () => {
    const items = buildTaskItemsFromContent('prd/auth.md', DOC);
    const byLocal = new Map(items.map((i) => [i.localId, i] as const));
    expect(byLocal.get('s-login')!.criteria).toEqual([
      'Valid credentials land on the dashboard.',
      'Invalid credentials show an error.',
    ]);
    expect(byLocal.get('s-reset')!.criteria).toBeUndefined();
  });

  it('composes the description from body prose + open questions + risks; AC stays in `criteria`', () => {
    const doc = [
      '## User Stories',
      '',
      '### Reset password <!-- sf:id s -->',
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
    ].join('\n');

    const [item] = buildTaskItemsFromContent('prd/auth.md', doc);
    expect(item.title).toBe('Reset password');
    // The composed description carries statement + description + open questions + risks…
    expect(item.description).toContain(
      'As a locked-out user, I want reset my password, so that I regain access',
    );
    expect(item.description).toContain('Covers the email reset link and its expiry window.');
    expect(item.description).toContain('**Open questions**');
    expect(item.description).toContain('- Should the link be single-use?');
    expect(item.description).toContain('**Risks**');
    expect(item.description).toContain('- Reset emails may land in spam.');
    // …but NOT the acceptance criteria — those stay on `criteria` for the adapter checklist.
    expect(item.description).not.toContain('A reset link is emailed.');
    expect(item.criteria).toEqual(['A reset link is emailed.']);
  });

  it('omits `description` entirely for a story with only acceptance criteria (no prose/questions/risks)', () => {
    const doc = [
      '### Export the report <!-- sf:id s -->',
      '',
      '- Acceptance criteria:',
      '  - A CSV downloads.',
    ].join('\n');
    const [item] = buildTaskItemsFromContent('prd/x.md', doc);
    expect(item.description).toBeUndefined();
    expect(item.criteria).toEqual(['A CSV downloads.']);
  });

  it('includes open questions / risks in the description even when there is no statement prose', () => {
    const doc = [
      '### Story <!-- sf:id s -->',
      '',
      '- Acceptance criteria:',
      '  - It works.',
      '- Risks:',
      '  - A standalone risk.',
    ].join('\n');
    const [item] = buildTaskItemsFromContent('prd/x.md', doc);
    expect(item.description).toBe('**Risks**\n- A standalone risk.');
  });

  it('localId is the marker id — independent of the relPath argument (idempotency anchor)', () => {
    const a = buildTaskItemsFromContent('prd/auth.md', DOC).map((i) => i.localId);
    const b = buildTaskItemsFromContent('elsewhere/renamed.md', DOC).map((i) => i.localId);
    expect(a).toEqual(b);
  });

  it('returns [] for a doc with no tagged stories', () => {
    expect(buildTaskItemsFromContent('prd/x.md', '# Epic\n\n## Background\n\nProse only.\n')).toEqual([]);
  });
});
