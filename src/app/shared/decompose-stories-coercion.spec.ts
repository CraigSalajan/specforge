import { describe, expect, it } from 'vitest';
import { parseStoriesResponse } from '../features/ai/ai-orchestrator.service';

/**
 * `parseStoriesResponse` (TER-37) is the tolerance seam between the model's
 * free-form JSON and the structured story renderer. A model may omit the OPTIONAL
 * `openQuestions` / `risks` fields, send a non-array where a list is expected, or
 * slip a non-string entry into a list. None of that may throw — malformed shapes
 * must coerce to safe defaults (or drop the entry) so a decompose turn never
 * crashes on a slightly off-spec response. These cases are NOT exercised by the
 * orchestrator service spec (which feeds a fully-formed payload), so they are
 * pinned here directly against the pure parser.
 *
 * Imported into the shared module graph (no `vi.mock`) so there is no
 * order-dependent mock-state leak across the bundled spec set.
 */
describe('parseStoriesResponse — AI coercion tolerance', () => {
  it('tolerates a story that omits openQuestions and risks entirely', () => {
    const raw = JSON.stringify({
      stories: [
        {
          title: 'Log in',
          role: 'user',
          capability: 'log in',
          benefit: 'I can work',
          acceptanceCriteria: ['Valid creds pass.'],
        },
      ],
    });
    const [story] = parseStoriesResponse(raw);
    expect(story.acceptanceCriteria).toEqual(['Valid creds pass.']);
    expect(story.openQuestions).toEqual([]);
    expect(story.risks).toEqual([]);
  });

  it('coerces non-array list fields to [] instead of throwing', () => {
    const raw = JSON.stringify({
      stories: [
        {
          title: 'X',
          capability: 'do x',
          acceptanceCriteria: 'not an array',
          openQuestions: 42,
          risks: { nope: true },
        },
      ],
    });
    const [story] = parseStoriesResponse(raw);
    expect(story.acceptanceCriteria).toEqual([]);
    expect(story.openQuestions).toEqual([]);
    expect(story.risks).toEqual([]);
  });

  it('drops null / non-string entries from list fields', () => {
    const raw = JSON.stringify({
      stories: [
        {
          title: 'Y',
          capability: 'do y',
          acceptanceCriteria: ['keep', null, 7, 'also keep', { drop: 1 }],
          openQuestions: [null, 'a question'],
          risks: [false, 'a risk'],
        },
      ],
    });
    const [story] = parseStoriesResponse(raw);
    expect(story.acceptanceCriteria).toEqual(['keep', 'also keep']);
    expect(story.openQuestions).toEqual(['a question']);
    expect(story.risks).toEqual(['a risk']);
  });

  it('drops an entry with neither a title nor a capability (too empty to render)', () => {
    const raw = JSON.stringify({
      stories: [
        { role: 'user', benefit: 'help', acceptanceCriteria: ['x'] },
        { title: 'Keeper', acceptanceCriteria: ['y'] },
      ],
    });
    const stories = parseStoriesResponse(raw);
    expect(stories.map((s) => s.title)).toEqual(['Keeper']);
  });

  it('returns [] for a non-array stories field, a missing object, or unparsable text', () => {
    expect(parseStoriesResponse(JSON.stringify({ stories: 'nope' }))).toEqual([]);
    expect(parseStoriesResponse(JSON.stringify({ notStories: [] }))).toEqual([]);
    expect(parseStoriesResponse('   ')).toEqual([]);
    expect(parseStoriesResponse('this is not json at all')).toEqual([]);
  });

  it('extracts the first {…} object when the model wraps the JSON in prose / a fence', () => {
    const raw = 'Sure! Here you go:\n```json\n{ "stories": [ { "title": "Wrapped" } ] }\n```\nDone.';
    const stories = parseStoriesResponse(raw);
    expect(stories.map((s) => s.title)).toEqual(['Wrapped']);
  });
});
