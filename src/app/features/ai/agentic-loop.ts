import type {
  ChatChunk,
  ChatMessage,
  ChatOptions,
  TokenUsage,
  ToolCall,
  ToolDef,
} from './providers/chat.provider';
// THE single inline-`<think>` parser — shared with the IPC layer and the bench.
// Reaching electron/ipc from src/app/features/ai is four levels up, mirroring
// how the gemma parser is imported by the bench's node-chat-provider.
import { splitThinkTags } from '../../../../electron/ipc/think-tag-parser';

/** Default upper bound on agentic tool rounds per turn (loop safety). */
export const DEFAULT_MAX_TOOL_ROUNDS = 8;

/**
 * Joins the reasoning sources for a turn into the single cumulative string the
 * app/bench surface. NATIVE sibling reasoning is concatenated onto `base`
 * WITHOUT a separator (preserving the exact accumulation the loop has always
 * produced for the native-only path — the streamed deltas carry their own
 * spacing); INLINE `<think>` reasoning, when present, is appended on a NEW line
 * so it reads as a distinct block. Returns '' when every piece is empty.
 */
function mergeReasoning(base: string, native: string, inline: string): string {
  let out = base + native;
  if (inline) out = out.length > 0 ? `${out}\n${inline}` : inline;
  return out;
}

/**
 * Folds a single turn's reported token usage into the running cross-round total.
 * Each field is summed independently and ONLY when the incoming turn reported it,
 * so a turn that omits a field never zeroes the accumulated value. Returns `acc`
 * unchanged (possibly still undefined) when the turn carried no usage at all —
 * the loop surfaces `undefined` so a backend that never reports `usage` is
 * distinguishable from one that genuinely reported zero.
 */
function accumulateUsage(
  acc: TokenUsage | undefined,
  next: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!next) return acc;
  const out: TokenUsage = acc ? { ...acc } : {};
  if (next.promptTokens != null) out.promptTokens = (out.promptTokens ?? 0) + next.promptTokens;
  if (next.completionTokens != null) {
    out.completionTokens = (out.completionTokens ?? 0) + next.completionTokens;
  }
  if (next.totalTokens != null) out.totalTokens = (out.totalTokens ?? 0) + next.totalTokens;
  return out;
}

/**
 * Cheap guard so `splitThinkTags` (and its string scans) only runs when the raw
 * round text could actually contain an inline think block — i.e. it has a
 * closing `</think>` somewhere, or it explicitly opens with `<think>`. For the
 * overwhelmingly common no-tags case this avoids re-scanning the growing buffer
 * on every streamed chunk (which would be O(n^2) across a long answer).
 */
function mightContainThink(raw: string): boolean {
  return raw.includes('</think>') || raw.replace(/^\s+/, '').startsWith('<think>');
}

/**
 * Collaborators the loop needs, injected so the same algorithm runs under the
 * Angular orchestrator (real chat provider, modal-gated tool execution) and in
 * the headless benchmark harness (direct-fetch provider, auto-accepted tools).
 */
export interface AgenticLoopDeps {
  /** Streams one model turn. Mirrors ChatProvider.chat. */
  chat: (messages: ChatMessage[], opts: ChatOptions) => AsyncIterable<ChatChunk>;
  /** Tool schemas advertised to the model (already filtered for disabled tools). */
  toolSchemas: ToolDef[];
  /**
   * Runs one tool call and returns the `tool`-role message to feed back to the
   * model. The caller owns dispatch, validation, and any confirmation handshake.
   */
  executeToolCall: (call: ToolCall) => Promise<ChatMessage>;
  /** Aborts the in-flight model stream. */
  signal?: AbortSignal;
  /** Loop cap; defaults to {@link DEFAULT_MAX_TOOL_ROUNDS}. */
  maxRounds?: number;
  /**
   * Invoked as streamed assistant text grows, with the full accumulated text so
   * far (across all rounds). Used by the app to update the live chat bubble.
   */
  onText?: (liveText: string) => void;
  /**
   * Invoked as streamed reasoning/"thinking" text grows, with the full
   * accumulated reasoning so far (across all rounds). Mirrors {@link onText}.
   */
  onReasoning?: (liveReasoning: string) => void;
}

export interface AgenticLoopResult {
  /** The full assistant text accumulated across all rounds. */
  finalText: string;
  /** The full reasoning/"thinking" text accumulated across all rounds. */
  finalReasoning: string;
  /** Every tool call the model emitted, in round/array order. */
  toolCalls: ToolCall[];
  /** Number of model rounds executed. */
  rounds: number;
  /**
   * True when the round cap was hit while the model was still requesting tools
   * (no final natural-language reply was produced).
   */
  exhaustedToolRounds: boolean;
  /**
   * Token usage summed across every model round, when the provider reported it;
   * `undefined` when no round carried a `usage` payload. `completionTokens` is
   * what the benchmark bridge forwards to eval-core.
   */
  usage?: TokenUsage;
}

/**
 * The provider-agnostic agentic tool loop: streams a model turn, and while the
 * model emits tool_calls, executes each, appends the results to `convo`, and
 * re-invokes — bounded by `maxRounds`. Free of Angular/Electron so the same
 * loop drives the app orchestrator and the headless benchmark harness.
 *
 * OpenAI ordering contract: every assistant message carrying tool_calls is
 * immediately followed by exactly one tool-role message per tool_call_id before
 * the next model call. `convo` is mutated in place (assistant + tool messages
 * are appended) exactly as the orchestrator did.
 */
export async function runAgenticLoop(
  convo: ChatMessage[],
  deps: AgenticLoopDeps,
): Promise<AgenticLoopResult> {
  const maxRounds = deps.maxRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  const allToolCalls: ToolCall[] = [];
  let finalText = '';
  let finalReasoning = '';
  // Flips false the first time a round ends without tool calls; if it is still
  // true after the loop, the round cap cut the turn short.
  let exhaustedToolRounds = true;
  let rounds = 0;
  let usage: TokenUsage | undefined;

  // The last cumulative reasoning value reported to `onReasoning`. Used to
  // de-duplicate calls so a text delta that doesn't change the reasoning never
  // re-fires it — preserving the exact one-call-per-reasoning-delta cadence the
  // native-only path has always had, while still letting inline `<think>`
  // reasoning (which arrives on text deltas) surface as it streams.
  let lastReportedReasoning = '';

  for (let round = 0; round < maxRounds; round++) {
    rounds++;
    // RAW round text straight off the wire (may carry an inline `<think>` block);
    // and the native sibling reasoning streamed on its own channel. Inline
    // `<think>` is peeled out of `roundRaw` by the single `splitThinkTags`.
    let roundRaw = '';
    let roundNativeReasoning = '';
    let toolCalls: ToolCall[] | undefined;

    // Splits the raw round text once, but only pays for the scan when an inline
    // think block could actually be present (the cheap guard). For the common
    // no-tags case this is identical to the legacy path: content === roundRaw,
    // reasoning === ''.
    const splitRound = (): { reasoning: string; content: string } =>
      mightContainThink(roundRaw)
        ? splitThinkTags(roundRaw)
        : { reasoning: '', content: roundRaw };

    // Reports cumulative reasoning only when it actually changed (see
    // `lastReportedReasoning`).
    const reportReasoning = (inline: string): void => {
      const live = mergeReasoning(finalReasoning, roundNativeReasoning, inline);
      if (live && live !== lastReportedReasoning) {
        lastReportedReasoning = live;
        deps.onReasoning?.(live);
      }
    };

    for await (const chunk of deps.chat(convo, {
      signal: deps.signal,
      tools: deps.toolSchemas,
      toolChoice: 'auto',
    })) {
      if (chunk.delta) {
        roundRaw += chunk.delta;
        const split = splitRound();
        // Report the running total of CLEAN content so the app updates the
        // bubble; fold any in-flight inline reasoning into the reasoning channel.
        deps.onText?.(finalText + split.content);
        reportReasoning(split.reasoning);
      }
      if (chunk.reasoning) {
        roundNativeReasoning += chunk.reasoning;
        // Mirror onText: report the cumulative reasoning across all rounds.
        reportReasoning(splitRound().reasoning);
      }
      if (chunk.done) {
        toolCalls = chunk.toolCalls;
        usage = accumulateUsage(usage, chunk.usage);
        break;
      }
    }

    // Final split of this round's raw text: clean content vs inline reasoning.
    const split = splitRound();
    const roundContent = split.content;
    const roundInlineReasoning = split.reasoning;

    finalText += roundContent;
    finalReasoning = mergeReasoning(finalReasoning, roundNativeReasoning, roundInlineReasoning);

    // No tool calls: this is the final natural-language reply. Append it to the
    // conversation so `convo` is a COMPLETE log of the exchange — the loop
    // already records an assistant message for every tool-calling round, and
    // without this the final text-only turn would be missing (which a consumer
    // surfacing `convo` as a transcript would notice). It carries no tool_calls,
    // so no tool messages follow it. This is behavior-preserving for the
    // orchestrator, which discards `convo` after the loop and persists the final
    // text separately via `finalText`.
    //
    // CLEAN content (inline `<think>` stripped) is what gets pushed: inline
    // reasoning is display-only and must never be replayed back to the model.
    // Native reasoning is likewise a display-only sibling channel and is not
    // attached to any `convo` assistant message either.
    if (!toolCalls || toolCalls.length === 0) {
      convo.push({ role: 'assistant', content: roundContent });
      exhaustedToolRounds = false;
      break;
    }

    // Record the assistant's tool-call message with CLEAN content (may be null).
    convo.push({
      role: 'assistant',
      content: roundContent.length > 0 ? roundContent : null,
      tool_calls: toolCalls,
    });

    // Execute each call in order and append exactly one tool message per id.
    for (const call of toolCalls) {
      // Defensive: OpenAI always sends a non-empty `id`, but a stray delta (or a
      // non-conformant proxy) could yield a tool call without one. Synthesize a
      // stable id so the follow-up request never emits a `tool_call_id:''` that
      // the model/endpoint would reject, and so the assistant(tool_calls) → tool
      // ordering contract still holds. Mutating in place updates the same object
      // already referenced by the pushed assistant message's tool_calls.
      if (!call.id) {
        call.id = `call_${round}_${toolCalls.indexOf(call)}`;
      }
      allToolCalls.push(call);
      const toolMsg = await deps.executeToolCall(call);
      convo.push(toolMsg);
    }
    // Loop continues: re-invoke the model with the tool results appended.
  }

  return { finalText, finalReasoning, toolCalls: allToolCalls, rounds, exhaustedToolRounds, usage };
}
