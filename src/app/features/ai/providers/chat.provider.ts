/**
 * Provider-agnostic chat surface used by the AI harness.
 *
 * Implementations target OpenAI-compatible endpoints. The streaming surface
 * yields incremental token chunks via an `AsyncIterable`; the non-streaming
 * surface returns the final assembled string.
 */

export interface ToolFunctionDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface ToolDef {
  type: 'function';
  function: ToolFunctionDef;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Null only on an assistant message that carries tool_calls and no text. */
  content: string | null;
  /** Present on an assistant message that requested tool invocations. */
  tool_calls?: ToolCall[];
  /** Present on a `tool`-role message, referencing the call it answers. */
  tool_call_id?: string;
  /** Tool name (for `tool`-role messages). */
  name?: string;
}

export interface ChatOptions {
  /** Override the configured chat model for this single call. */
  model?: string;
  /** Sampling temperature. Provider default if omitted. */
  temperature?: number;
  /** Max tokens to generate. */
  maxTokens?: number;
  /**
   * If true and the provider supports it (OpenAI / many proxies), request a
   * single JSON object response. Used by the planning commands that produce
   * structured file proposals.
   */
  jsonObject?: boolean;
  /** Function-calling tool schemas offered to the model for this call. */
  tools?: ToolDef[];
  /** Tool-choice policy. Defaults to 'auto' when tools are present. */
  toolChoice?: 'auto' | 'none' | 'required';
  /** Abort the request mid-stream. */
  signal?: AbortSignal;
}

/** Token usage for a model turn, as reported by the provider (camelCase). */
export interface TokenUsage {
  /** Prompt/input tokens, when the provider reports them. */
  promptTokens?: number;
  /** Completion/output tokens, when the provider reports them. */
  completionTokens?: number;
  /** Total tokens, when the provider reports them (some send only this). */
  totalTokens?: number;
}

export interface ChatChunk {
  /** Incremental delta text. */
  delta: string;
  /** Incremental reasoning/"thinking" delta, kept separate from `delta`. */
  reasoning?: string;
  /** True on the final chunk after the stream completes. */
  done: boolean;
  /** Assembled tool calls; only set on the final `done` chunk. */
  toolCalls?: ToolCall[];
  /** Provider finish reason; only set on the final `done` chunk. */
  finishReason?: string;
  /** Token usage for the turn; only set on the final `done` chunk, when the provider reports it. */
  usage?: TokenUsage;
}

export interface ChatCompleteResult {
  content: string | null;
  /** Reasoning/"thinking" text, kept separate from `content`; null when absent. */
  reasoning?: string | null;
  toolCalls?: ToolCall[];
  finishReason?: string;
  /** Token usage for the call, when the provider reports it. */
  usage?: TokenUsage;
}

export interface ChatProvider {
  chat(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<ChatChunk>;
  chatComplete(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatCompleteResult>;
}
