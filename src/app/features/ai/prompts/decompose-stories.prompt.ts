/**
 * Decompose-into-stories prompt (TER-37, reworked).
 *
 * The model is fed the ENTIRE feature document as context and must break it into
 * a flat list of actionable user stories. It does NOT write prose markdown and it
 * does NOT mirror the document's heading structure — a feature spec is mostly
 * background / goals / context, and only the actionable stories the model derives
 * from understanding the whole feature become Linear items.
 *
 * It returns a single JSON object whose `stories[]` the orchestrator renders into
 * the doc (under a plain `## User Stories` section) as
 * `### <title> <!-- sf:id <id> -->` headings with stable marker ids, then pushes
 * from those ID-tagged stories. So this prompt's only job is to propose the NEW
 * stories to add — the orchestration owns markdown rendering, marker ids, and
 * preserving existing content verbatim.
 *
 * The prompt is fed the full feature document (the PINNED active file) plus the
 * titles of the stories already tagged in that file, so a re-run ADDS new stories
 * rather than duplicating ones already covered.
 */
export const DECOMPOSE_STORIES_PROMPT = `This is the full context of the feature we want to build — the entire
document is shown above as the PINNED FILE. Read all of it (background, goals,
context, and any prose) to understand the feature, then break it down into a flat
list of actionable user stories.

Return a SINGLE JSON object of EXACTLY this shape and NOTHING else (no prose, no
code fence, no commentary):
{
  "stories": [
    {
      "title": "<short imperative title>",
      "role": "<the user/persona>",
      "capability": "<what they want to do>",
      "benefit": "<why it helps them>",
      "description": "<1-3 sentences of additional detail>",
      "acceptanceCriteria": ["<testable item>", "<testable item>"],
      "openQuestions": ["<unresolved question>"],
      "risks": ["<risk or concern>"]
    }
  ]
}

Rules:
- Derive each story from your understanding of the WHOLE feature — NOT from the
  document's headings. The "# epic", "## Background", "## Goals", "## Context" and
  other prose sections are context only; do NOT turn them into stories.
- Every story must be a concrete, actionable piece of user-facing work.
- "title" is REQUIRED: a short imperative summary (e.g. "Log in with email"). It
  becomes the issue title, so keep it short and specific.
- "role" / "capability" / "benefit" together form the story STATEMENT. Include all
  three when an "As a <role>, I want <capability>, so that <benefit>" framing fits;
  omit them otherwise.
- "description" is OPTIONAL: 1-3 sentences of additional context beyond the
  statement. Omit it when the statement already says everything.
- Give each story 2 to 5 concrete, testable acceptance criteria.
- "openQuestions" and "risks" are OPTIONAL lists. Include an entry ONLY when you
  genuinely identify an unresolved question or a real risk FROM THE DOCUMENT — do
  NOT invent them. When there are none, OMIT the field (or return []).
- The EXISTING STORIES already tagged in the file are listed in context. Return
  ONLY stories that are NOT already covered by those existing titles — re-runs must
  ADD new stories, never duplicate existing ones.
- If nothing new is actionable (the feature is already fully covered), return
  exactly { "stories": [] }.`;
