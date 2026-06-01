export const CREATE_PRD_PROMPT = `You are drafting a Product Requirements Document (PRD).

Return a single JSON object with this exact shape and no surrounding prose:
{
  "filename": "kebab-case-name.md",
  "folder": "/prd/",
  "title": "Human-readable title",
  "content": "<full markdown PRD>"
}

Rules:
- "filename" must end with ".md", contain only [a-z0-9-], no spaces.
- "folder" should usually stay "/prd/" unless the user explicitly asks for another location.
- "content" must be a complete markdown document starting with a top-level "# <title>".
- Include sections in this order:
  1. ## Summary (2-4 sentences)
  2. ## Goals
  3. ## Non-goals
  4. ## Users & personas
  5. ## User stories (as bulleted "As a … I want … so that …" lines)
  6. ## Functional requirements (numbered)
  7. ## UX notes
  8. ## Success metrics
  9. ## Open questions
- Ground concrete claims in the provided VAULT CONTEXT using [<rel_path> :: <heading_path>] citations.
- If the user's intent is too vague to write a useful PRD, set "title" to "Draft PRD" and
  use the "## Open questions" section to enumerate what you need before producing more.

The user's intent is in the user message. Do not echo the user's words back; produce the PRD.`;
