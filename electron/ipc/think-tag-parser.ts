/**
 * THE single source of truth for splitting inline `<think>…</think>` reasoning
 * out of an assistant's `content`. Deliberately free of any Electron / Node
 * imports so it can be unit-tested under the renderer's (browser) test runner,
 * imported by the shared agentic loop, AND bundled into the main process —
 * mirroring `gemma-tool-call-parser.ts`.
 *
 * ONE parser, applied where assistant content is FINALIZED (the shared
 * `runAgenticLoop` for tool-turns + the bench, and the orchestrator's non-tool
 * path). The main process IPC layer (`ai.ts`) does NO inline `<think>` parsing
 * at all — it only forwards the NATIVE sibling reasoning channel
 * (`reasoning_content` / `reasoning`). This avoids a second, divergent parsing
 * mechanism.
 *
 * Some models (e.g. Qwen3) embed their chain-of-thought INLINE in the content
 * stream rather than on a sibling `reasoning` channel:
 *
 *   <think>
 *   …reasoning…
 *   </think>
 *   …the actual answer…
 *
 * REAL-MODEL REALITY — detection keys off the CLOSING tag, not the opening one.
 * The "`<think>` is always at the very start" guarantee turned out NOT to be
 * reliable: in practice the chat template injects the OPENING `<think>` into the
 * PROMPT, so the model's completion starts directly with reasoning and ends at a
 * CLOSING `</think>` with NO opening tag in the output at all, e.g.:
 *
 *   The user wants me to create a PRD …\n</think>\n\nThe PRD has been created…
 *
 * Detection is therefore CLOSING-TAG-DRIVEN (always-on auto-detect, no setting):
 * if a `</think>` appears, everything before the FIRST one is reasoning. An
 * explicit leading `<think>` is still honored when present, but is not required.
 *
 * ACCEPTED FALSE POSITIVE: a normal reply that literally contains `</think>`
 * (e.g. "How do </think> tags work?") will be mis-split — the text before the
 * first `</think>` becomes reasoning. This tradeoff is approved: the real-model
 * closing-tag-only format is far more common than a stray literal `</think>`.
 *
 * EDGE CASES:
 *   (a) truncated generation — explicit `<think>` opened but never closed →
 *       everything is reasoning, the answer is empty.
 *   (b) thinking disabled — no `</think>` anywhere → everything is the answer
 *       (returned verbatim).
 */

/** Opening think tag; honored when the text starts with it, but not required. */
const OPEN = '<think>';
/** Closing think tag — the PRIMARY detection signal — after which the answer follows. */
const CLOSE = '</think>';

/**
 * Whole-text split: separates inline `<think>` reasoning from the answer.
 *
 *   - explicit leading `<think>` (after optional whitespace):
 *       · closed     → reasoning = text between the tags (trimmed);
 *                      content = after `</think>`, leading newlines stripped.
 *       · never closed (truncated) → reasoning = remainder (trimmed); content ''.
 *   - implicit closing-tag-only (no leading `<think>`, but a `</think>` exists):
 *       reasoning = text before the FIRST `</think>` (trimmed);
 *       content = after it, leading newlines stripped. (The real-model case.)
 *   - no `</think>` at all → { reasoning: '', content: text } (text verbatim).
 */
export function splitThinkTags(text: string): { reasoning: string; content: string } {
  const lead = text.replace(/^\s+/, '');

  // EXPLICIT: the completion literally begins with `<think>`. Drop the opening
  // tag (and one optional immediately-following newline) and split on the close.
  if (lead.startsWith(OPEN)) {
    const body = lead.slice(OPEN.length).replace(/^\n/, '');
    const cIdx = body.indexOf(CLOSE);
    if (cIdx === -1) {
      // Truncated generation: everything that was generated is reasoning.
      return { reasoning: body.trim(), content: '' };
    }
    return {
      reasoning: body.slice(0, cIdx).trim(),
      content: body.slice(cIdx + CLOSE.length).replace(/^\n+/, ''),
    };
  }

  // IMPLICIT (the real-model format): no opening tag, but a closing `</think>`
  // marks the end of reasoning. Everything before the FIRST one is reasoning.
  const i = text.indexOf(CLOSE);
  if (i !== -1) {
    return {
      reasoning: text.slice(0, i).trim(),
      content: text.slice(i + CLOSE.length).replace(/^\n+/, ''),
    };
  }

  // No tags at all: the whole text is the answer (returned verbatim).
  return { reasoning: '', content: text };
}
