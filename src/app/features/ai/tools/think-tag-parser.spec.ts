import { splitThinkTags } from '../../../../../electron/ipc/think-tag-parser';

/**
 * Tests THE single inline-`<think>…</think>` reasoning splitter — the one
 * parser shared by the IPC layer, the agentic loop, and the bench. Some models
 * (e.g. Qwen3) embed their chain-of-thought INLINE in the content rather than on
 * a sibling reasoning channel.
 *
 * Detection is CLOSING-TAG-DRIVEN: the chat template injects the OPENING
 * `<think>` into the prompt, so the real completion typically starts directly
 * with reasoning and ends at `</think>` with NO opening tag. An explicit leading
 * `<think>` is still honored when present. These tests cover the explicit case,
 * the implicit closing-tag-only case (the real-model format), truncation, the
 * no-tags passthrough, leading-newline stripping, multiline reasoning, and the
 * ACCEPTED false positive (a normal reply that literally contains `</think>`).
 */
describe('splitThinkTags', () => {
  it('splits an explicit opened-and-closed think block', () => {
    expect(splitThinkTags('<think>\nR\n</think>A')).toEqual({
      reasoning: 'R',
      content: 'A',
    });
  });

  it('splits the implicit closing-tag-only form (the real-model format)', () => {
    // No opening `<think>` — the prompt template injected it, so the completion
    // begins with reasoning and the first `</think>` ends it.
    expect(splitThinkTags('R\n</think>\n\nA')).toEqual({
      reasoning: 'R',
      content: 'A',
    });
  });

  it('treats a truncated (never-closed) explicit think block as all reasoning', () => {
    expect(splitThinkTags('<think>\nR')).toEqual({ reasoning: 'R', content: '' });
  });

  it('returns the text verbatim as content when there are no tags', () => {
    expect(splitThinkTags('Just an answer')).toEqual({
      reasoning: '',
      content: 'Just an answer',
    });
  });

  it('honors an explicit think block after leading whitespace', () => {
    expect(splitThinkTags('  \n<think>\nthinking\n</think>the answer')).toEqual({
      reasoning: 'thinking',
      content: 'the answer',
    });
  });

  it('strips leading newlines after </think>', () => {
    expect(splitThinkTags('R</think>\n\n\nthe answer')).toEqual({
      reasoning: 'R',
      content: 'the answer',
    });
  });

  it('preserves multiline reasoning', () => {
    const { reasoning, content } = splitThinkTags(
      '<think>\nline one\nline two\n</think>\nfinal answer',
    );
    expect(reasoning).toBe('line one\nline two');
    expect(content).toBe('final answer');
  });

  it('splits a normal reply that merely contains </think> (ACCEPTED false positive)', () => {
    // This is the approved tradeoff of the closing-tag-only detection: the text
    // before the first `</think>` is treated as reasoning. The real-model
    // closing-tag-only format is far more common than a stray literal `</think>`.
    // Only leading NEWLINES are stripped after `</think>` (the real format emits
    // `</think>\n\n…`); a single leading space here is preserved verbatim.
    expect(splitThinkTags('Before </think> after')).toEqual({
      reasoning: 'Before',
      content: ' after',
    });
  });
});
