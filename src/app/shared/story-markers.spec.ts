import { describe, expect, it } from 'vitest';
import {
  extractTaggedTasks,
  generateUniqueId,
  injectMarkerAtLine,
  parseMarkedHeadings,
  parseMarkerId,
  renderHeadingWithMarker,
  renderMarker,
  stripMarkerFromTitle,
} from '../../../electron/sync/story-markers';

/**
 * The story-marker helper (TER-37) is the single source of truth for the
 * inline `sf:id` marker format — parse / inject / strip round-trips, and the
 * marker rendering invisibly to the title.
 */
describe('story-markers', () => {
  describe('parseMarkerId', () => {
    it('extracts the id from a marked heading at any level', () => {
      expect(parseMarkerId('# Epic <!-- sf:id abc123 -->')).toBe('abc123');
      expect(parseMarkerId('## Theme <!-- sf:id def456 -->')).toBe('def456');
      expect(parseMarkerId('### As a user, I want X, so that Y <!-- sf:id ghi789 -->')).toBe(
        'ghi789',
      );
    });

    it('returns null for a heading without a marker', () => {
      expect(parseMarkerId('# Plain epic')).toBeNull();
      expect(parseMarkerId('## Plain theme')).toBeNull();
    });

    it('returns null for a non-heading line', () => {
      expect(parseMarkerId('Just some prose.')).toBeNull();
      expect(parseMarkerId('- a bullet')).toBeNull();
    });

    it('tolerates extra trailing metadata in the comment (e.g. linear=…)', () => {
      expect(parseMarkerId('# Epic <!-- sf:id abc123 linear=ENG-9 -->')).toBe('abc123');
    });

    it('ignores a `<!-- … -->` comment that appears earlier in the heading text', () => {
      // The marker must be the LAST thing on the line; an interior comment is not it.
      expect(parseMarkerId('# Epic <!-- a note --> still text')).toBeNull();
    });

    it('is CRLF-safe', () => {
      expect(parseMarkerId('# Epic <!-- sf:id abc123 -->\r')).toBe('abc123');
    });
  });

  describe('stripMarkerFromTitle', () => {
    it('strips the marker, leaving just the heading text', () => {
      expect(stripMarkerFromTitle('# Authentication <!-- sf:id abc123 -->')).toBe('Authentication');
      expect(
        stripMarkerFromTitle('### As a user, I want X, so that Y <!-- sf:id z -->'),
      ).toBe('As a user, I want X, so that Y');
    });

    it('returns the plain heading text when there is no marker', () => {
      expect(stripMarkerFromTitle('## Sign-in')).toBe('Sign-in');
    });
  });

  describe('renderHeadingWithMarker / renderMarker', () => {
    it('renders a heading line with the marker as the same-line tail', () => {
      expect(renderHeadingWithMarker(2, 'Sign-in', 'abc')).toBe('## Sign-in <!-- sf:id abc -->');
    });

    it('clamps the level into 1–6', () => {
      expect(renderHeadingWithMarker(0, 'X', 'i').startsWith('# ')).toBe(true);
      expect(renderHeadingWithMarker(9, 'X', 'i').startsWith('###### ')).toBe(true);
    });

    it('renderMarker emits the bare comment', () => {
      expect(renderMarker('xyz')).toBe('<!-- sf:id xyz -->');
    });
  });

  describe('round-trips', () => {
    it('render → parse recovers the id; strip recovers the title (marker invisible to title)', () => {
      const line = renderHeadingWithMarker(3, 'As a user, I want X, so that Y', 'rid42');
      expect(parseMarkerId(line)).toBe('rid42');
      expect(stripMarkerFromTitle(line)).toBe('As a user, I want X, so that Y');
    });
  });

  describe('parseMarkedHeadings', () => {
    it('reports id, level, title and line index for every heading', () => {
      const content = [
        '# Epic <!-- sf:id e1 -->',
        '',
        'Prose.',
        '',
        '## Theme',
        '',
        '### As a user, I want X, so that Y <!-- sf:id s1 -->',
      ].join('\n');
      const headings = parseMarkedHeadings(content);
      expect(headings).toEqual([
        { level: 1, title: 'Epic', id: 'e1', lineIndex: 0 },
        { level: 2, title: 'Theme', id: null, lineIndex: 4 },
        { level: 3, title: 'As a user, I want X, so that Y', id: 's1', lineIndex: 6 },
      ]);
    });
  });

  describe('injectMarkerAtLine', () => {
    it('appends a marker onto an unmarked heading line in place', () => {
      const content = '# Epic\n\nbody';
      const next = injectMarkerAtLine(content, 0, 'new1');
      expect(next.split('\n')[0]).toBe('# Epic <!-- sf:id new1 -->');
      // The rest of the doc is untouched.
      expect(next.split('\n').slice(1).join('\n')).toBe('\nbody');
    });

    it('is a no-op when the heading already carries a marker', () => {
      const content = '# Epic <!-- sf:id old -->\n\nbody';
      expect(injectMarkerAtLine(content, 0, 'new1')).toBe(content);
    });

    it('is a no-op when the target line is not a heading', () => {
      const content = '# Epic\nprose line';
      expect(injectMarkerAtLine(content, 1, 'x')).toBe(content);
    });

    it('preserves a CRLF line ending', () => {
      const content = '# Epic\r\n\r\nbody';
      const next = injectMarkerAtLine(content, 0, 'n');
      expect(next.split('\n')[0]).toBe('# Epic <!-- sf:id n -->\r');
    });
  });

  describe('generateUniqueId', () => {
    it('produces a short hex id not in the existing set', () => {
      const id = generateUniqueId(new Set());
      expect(id).toMatch(/^[0-9a-f]+$/);
      expect(id.length).toBeGreaterThanOrEqual(12);
    });

    it('avoids a seeded collision', () => {
      // Force the first short candidate to be considered taken by seeding many
      // ids; the generator must still return something not in the set.
      const existing = new Set<string>();
      const a = generateUniqueId(existing);
      existing.add(a);
      const b = generateUniqueId(existing);
      expect(b).not.toBe(a);
    });
  });

  /**
   * `extractTaggedTasks` (TER-37, reworked) is the marker-driven, FLAT,
   * stories-only source for the per-file push: it returns ONLY the `### story`
   * headings that carry an `sf:id` marker, with their criteria — never the epic,
   * themes, or untagged background/goals/context prose. It is fence-aware.
   */
  describe('extractTaggedTasks', () => {
    it('returns ONLY tagged ### story headings — never a marked epic/theme or untagged prose', () => {
      const content = [
        '# Epic <!-- sf:id epic1 -->', // a marked H1 epic must NOT be extracted…
        '',
        '## Background',
        '',
        'Context only — must not become a task.',
        '',
        '## Goals <!-- sf:id theme1 -->', // …nor a marked H2 theme.
        '',
        '- Reduce friction.',
        '',
        '## User Stories',
        '',
        '### Pay with a card <!-- sf:id s1 -->',
        '',
        '- Acceptance criteria:',
        '  - A valid card is charged.',
        '  - A declined card errors.',
        '',
        '### Refund a payment <!-- sf:id s2 -->',
      ].join('\n');

      const tasks = extractTaggedTasks(content);
      // ONLY the two H3 stories — the marked epic/theme + untagged headings/prose
      // are all dropped.
      expect(tasks.map((t) => t.id)).toEqual(['s1', 's2']);
      expect(tasks.map((t) => t.title)).toEqual(['Pay with a card', 'Refund a payment']);
      expect(tasks[0].criteria).toEqual(['A valid card is charged.', 'A declined card errors.']);
      // A tagged story with no criteria list carries an empty array.
      expect(tasks[1].criteria).toEqual([]);
      // Open questions / risks default to empty arrays when not present.
      expect(tasks[0].openQuestions).toEqual([]);
      expect(tasks[0].risks).toEqual([]);
    });

    it('round-trips a fully-structured story: body prose + AC + open questions + risks', () => {
      const content = [
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
        '  - The link expires after an hour.',
        '- Open questions:',
        '  - Should the link be single-use?',
        '- Risks:',
        '  - Reset emails may land in spam.',
      ].join('\n');

      const [task] = extractTaggedTasks(content);
      expect(task.title).toBe('Reset password');
      expect(task.statementAndDescription).toBe(
        'As a locked-out user, I want reset my password, so that I regain access\n\nCovers the email reset link and its expiry window.',
      );
      expect(task.criteria).toEqual(['A reset link is emailed.', 'The link expires after an hour.']);
      expect(task.openQuestions).toEqual(['Should the link be single-use?']);
      expect(task.risks).toEqual(['Reset emails may land in spam.']);
    });

    it('a story with only AC yields empty open-questions/risks and no prose', () => {
      const content = [
        '### Export the report <!-- sf:id s -->',
        '',
        '- Acceptance criteria:',
        '  - A CSV downloads.',
      ].join('\n');
      const [task] = extractTaggedTasks(content);
      expect(task.statementAndDescription).toBe('');
      expect(task.criteria).toEqual(['A CSV downloads.']);
      expect(task.openQuestions).toEqual([]);
      expect(task.risks).toEqual([]);
    });

    it('captures only the prose before the first labeled list as the body', () => {
      const content = [
        '### Story <!-- sf:id s -->',
        '',
        'Statement line.',
        '',
        '- Acceptance criteria:',
        '  - One.',
        '- Risks:',
        '  - A risk, NOT prose.',
      ].join('\n');
      const [task] = extractTaggedTasks(content);
      expect(task.statementAndDescription).toBe('Statement line.');
      expect(task.risks).toEqual(['A risk, NOT prose.']);
    });

    it('the key regression: untagged ## Background / ## Goals yield NO tasks — only the tagged stories', () => {
      const content = [
        '# Feature',
        '',
        '## Background',
        '',
        'Lots of prose.',
        '',
        '## Goals',
        '',
        'More prose.',
        '',
        '## User Stories',
        '',
        '### First story <!-- sf:id a -->',
        '### Second story <!-- sf:id b -->',
        '### Third story <!-- sf:id c -->',
      ].join('\n');

      const tasks = extractTaggedTasks(content);
      // EXACTLY the three tagged stories — nothing from the epic/background/goals.
      expect(tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
      expect(tasks).toHaveLength(3);
    });

    it('is fence-aware: ignores `sf:id`-looking headings inside a fenced code block', () => {
      const content = [
        '# Epic',
        '',
        '## User Stories',
        '',
        '### Real story <!-- sf:id real -->',
        '',
        '- Acceptance criteria:',
        '  - It works.',
        '',
        'A worked example of the convention:',
        '',
        '```md',
        '### Fenced story <!-- sf:id fenced -->',
        '- Acceptance criteria:',
        '  - This must be ignored.',
        '```',
      ].join('\n');

      const tasks = extractTaggedTasks(content);
      expect(tasks.map((t) => t.id)).toEqual(['real']);
      expect(tasks[0].criteria).toEqual(['It works.']);
    });

    it('stops collecting criteria at a blank line and at the next heading', () => {
      const content = [
        '### Story <!-- sf:id s -->',
        '',
        '- Acceptance criteria:',
        '  - First.',
        '',
        '  - A later bullet after a paragraph break, not a criterion.',
        '',
        '### Next story <!-- sf:id n -->',
      ].join('\n');

      const tasks = extractTaggedTasks(content);
      expect(tasks.map((t) => t.id)).toEqual(['s', 'n']);
      expect(tasks[0].criteria).toEqual(['First.']);
      expect(tasks[1].criteria).toEqual([]);
    });

    it('is CRLF-safe', () => {
      const lf = '### Story <!-- sf:id s -->\n\n- Acceptance criteria:\n  - It works.\n';
      expect(extractTaggedTasks(lf.replace(/\n/g, '\r\n'))).toEqual(extractTaggedTasks(lf));
    });

    it('returns [] when there are no tagged headings', () => {
      expect(extractTaggedTasks('# Epic\n\n## Background\n\nProse.\n')).toEqual([]);
    });
  });
});
