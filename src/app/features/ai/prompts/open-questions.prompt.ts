export const OPEN_QUESTIONS_PROMPT = `You are reviewing the user's active document and surrounding vault context to surface
the most important unresolved questions before the team can move forward.

Output format (markdown, no JSON):

## Open questions

For each question, use this structure:

### <Short question title>
- **Question:** <full question>
- **Why it matters:** <one-line impact>
- **Owner suggestion:** <role or team likely to answer>
- **Source:** [<rel_path> :: <heading_path>] (cite the section that prompted the question)

Limit yourself to the 5 most consequential questions. Prefer questions that block a decision
or unlock an experiment over stylistic nitpicks.`;
