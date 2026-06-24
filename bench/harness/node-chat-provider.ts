/**
 * A {@link ChatProvider} for the headless benchmark harness.
 *
 * Talks to an OpenAI-compatible `/chat/completions` endpoint directly over
 * global `fetch` (Node 24). It deliberately mirrors the production request
 * shaping (`buildChatBody`) and response shaping (`handleChatComplete`) from
 * `electron/ipc/ai.ts` — re-created here rather than imported, because that
 * module pulls in `electron`. Keeping the wire format identical means the
 * model is driven exactly as it is inside the app.
 *
 * Unlike the app, the harness does NOT stream: `chat()` issues a single
 * non-streaming request and yields exactly one final chunk. The agentic loop
 * only consumes the final `done` chunk's `delta` + `toolCalls`, so a one-shot
 * request is behaviourally equivalent for benchmarking and far simpler/cheaper.
 */

import type {
  ChatChunk,
  ChatCompleteResult,
  ChatMessage,
  ChatOptions,
  ChatProvider,
  TokenUsage,
  ToolCall,
} from '../../src/app/features/ai/providers/chat.provider';
import { extractGemmaToolCalls } from '../../electron/ipc/gemma-tool-call-parser';

export interface NodeChatProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Per-request wall-clock bound; defaults to 60s. */
  timeoutMs?: number;
}

/** Minimal shape of the OpenAI `tool_calls` entry on a completion message. */
interface RawToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: RawToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

const DEFAULT_TIMEOUT_MS = 60_000;

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Re-creation of `electron/ipc/ai.ts:buildChatBody` (which is not exported and
 * lives behind an `electron` import). Maps {@link ChatOptions} onto the OpenAI
 * request body.
 */
function buildChatBody(
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = { model, messages, stream: false };
  if (opts?.temperature !== undefined) body['temperature'] = opts.temperature;
  if (opts?.maxTokens !== undefined) body['max_tokens'] = opts.maxTokens;
  if (opts?.jsonObject) body['response_format'] = { type: 'json_object' };
  if (opts?.tools && opts.tools.length > 0) {
    body['tools'] = opts.tools;
    body['tool_choice'] = opts.toolChoice ?? 'auto';
  }
  return body;
}

/**
 * Normalizes the endpoint's structured `tool_calls` into the harness
 * {@link ToolCall} shape. Already in `{ id, type, function:{ name, arguments } }`
 * form on OpenAI-compatible servers; we defensively fill any gaps.
 */
function normalizeRawToolCalls(raw: RawToolCall[]): ToolCall[] {
  return raw.map((c, i) => ({
    id: c.id ?? `call_${i}`,
    type: 'function',
    function: {
      name: c.function?.name ?? '',
      arguments: c.function?.arguments ?? '{}',
    },
  }));
}

/** Maps the OpenAI snake_case `usage` block onto the harness {@link TokenUsage}. */
function mapUsage(
  u: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined,
): TokenUsage | undefined {
  if (!u) return undefined;
  const out: TokenUsage = {};
  if (typeof u.prompt_tokens === 'number') out.promptTokens = u.prompt_tokens;
  if (typeof u.completion_tokens === 'number') out.completionTokens = u.completion_tokens;
  if (typeof u.total_tokens === 'number') out.totalTokens = u.total_tokens;
  return Object.keys(out).length > 0 ? out : undefined;
}

export class NodeChatProvider implements ChatProvider {
  constructor(private readonly config: NodeChatProviderConfig) {}

  /**
   * Single non-streaming request. The async generator yields exactly one final
   * chunk so the agentic loop's `for await … if (chunk.done) break` sees the
   * complete result in one pass.
   */
  async *chat(messages: ChatMessage[], opts: ChatOptions = {}): AsyncIterable<ChatChunk> {
    const { cleanedText, toolCalls, finishReason, usage } = await this.request(messages, opts);
    yield {
      delta: cleanedText,
      done: true,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
      usage,
    };
  }

  /** Non-streaming completion sharing the exact request path of {@link chat}. */
  async chatComplete(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatCompleteResult> {
    const { cleanedText, toolCalls, finishReason, usage } = await this.request(messages, opts);
    return {
      content: cleanedText,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason,
      usage,
    };
  }

  /**
   * Issues the POST and shapes the response: merges any structured
   * `message.tool_calls` with Gemma text-format calls parsed out of
   * `message.content` (mirroring `handleChatComplete`).
   */
  private async request(
    messages: ChatMessage[],
    opts: ChatOptions,
  ): Promise<{ cleanedText: string; toolCalls: ToolCall[]; finishReason: string | undefined; usage: TokenUsage | undefined }> {
    const model = opts.model ?? this.config.model;
    const body = buildChatBody(model, messages, opts);

    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    // Chain the caller's signal so a loop-level abort still tears down the fetch.
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Keep the timeout armed across BOTH the fetch AND the body read: a server
    // that sends headers then stalls the body would otherwise hang forever once
    // `fetch()` resolved. The single try/finally tears the timer + abort
    // listener down on every path (success or error), only after the body is
    // fully consumed.
    try {
      const res = await fetch(`${trimTrailingSlash(this.config.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const snippet = (await readBodyText(res)).slice(0, 500);
        throw new Error(
          `Chat completion request failed: ${res.status} ${res.statusText}${
            snippet ? ` — ${snippet}` : ''
          }`,
        );
      }

      const json = (await res.json()) as ChatCompletionResponse;
      const choice = json.choices?.[0];
      const { cleanedText, toolCalls: gemmaCalls } = extractGemmaToolCalls(
        choice?.message?.content ?? '',
      );
      const structured = normalizeRawToolCalls(choice?.message?.tool_calls ?? []);
      const merged: ToolCall[] = [...structured, ...gemmaCalls];

      return {
        cleanedText,
        toolCalls: merged,
        finishReason: choice?.finish_reason ?? undefined,
        usage: mapUsage(json.usage),
      };
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    }
  }
}

async function readBodyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
