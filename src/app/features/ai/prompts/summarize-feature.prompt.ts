export const SUMMARIZE_FEATURE_PROMPT = `You are summarizing the user's active document using both its contents and related vault context.

Output as markdown with this structure:

## Summary
2-4 sentences. Plain language.

## Key decisions
Bulleted list. Cite the source for each: [<rel_path> :: <heading_path>].

## Stakeholders & dependencies
Bulleted list with cross-references to other vault files where they exist.

## Status & open issues
What is locked in vs. still being negotiated, with citations.

If the active document is very short or empty, focus the summary on the related vault context
and clearly call out what the user should write next.`;
