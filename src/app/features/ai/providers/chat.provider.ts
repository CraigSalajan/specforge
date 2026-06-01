/**
 * Provider-agnostic chat surface used by the AI harness.
 *
 * Implementations target OpenAI-compatible endpoints. The streaming surface
 * yields incremental token chunks via an `AsyncIterable`; the non-streaming
 * surface returns the final assembled string.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
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
  /** Abort the request mid-stream. */
  signal?: AbortSignal;
}

export interface ChatChunk {
  /** Incremental delta text. */
  delta: string;
  /** True on the final chunk after the stream completes. */
  done: boolean;
}

export interface ChatProvider {
  chat(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<ChatChunk>;
  chatComplete(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
}
