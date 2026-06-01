export const CREATE_STORIES_PROMPT = `You are drafting User Stories.

Return a single JSON object with this exact shape and no surrounding prose:
{
  "filename": "kebab-case-name-stories.md",
  "folder": "/prd/",
  "title": "Human-readable title",
  "content": "<full markdown story list>"
}

Rules:
- "filename" uses only [a-z0-9-] and ends with ".md".
- The default location is "/prd/" — stories live next to the PRD they refine.
  Override only if the user explicitly asks for "/stories/".
- "content" should start with "# <title>" then group stories under "## Theme" subheadings.
- Each story uses the "As a <role>, I want <capability>, so that <benefit>" form.
- For each story add a nested "- Acceptance criteria:" bullet list of 2-5 testable items.
- If a PRD is available in VAULT CONTEXT, cite it inline as [<rel_path> :: <heading_path>]
  and explicitly trace each story to the PRD section it refines.`;
