export const CREATE_PLAN_PROMPT = `You are drafting an engineering Implementation Plan.

Return a single JSON object with this exact shape and no surrounding prose:
{
  "filename": "kebab-case-name.md",
  "folder": "/implementation-plans/",
  "title": "Human-readable title",
  "content": "<full markdown plan>"
}

Rules:
- "filename" uses only [a-z0-9-] and ends with ".md".
- "content" must be a complete markdown document with these sections in order:
  1. # <title>
  2. ## Overview (what we are building and why, 2-3 sentences)
  3. ## Constraints
  4. ## Approach (architecture diagrams allowed as ASCII / mermaid)
  5. ## Phased plan (numbered phases, each with concrete deliverables)
  6. ## Risks & mitigations
  7. ## Open questions
- Each phase must have a clearly testable definition of done.
- Cite related ADRs / PRDs from VAULT CONTEXT inline as [<rel_path> :: <heading_path>].`;
