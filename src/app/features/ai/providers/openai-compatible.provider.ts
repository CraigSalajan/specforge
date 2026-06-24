import type {
  AiChatCompleteIpcResult,
  AiChatCompleteRequest,
  AiChatRequestOptions,
  AiChatStreamRequest,
  AiEmbedIpcResult,
  AiEmbedRequest,
  AiErrorInfo,
  AiListModelsIpcResult,
  AiListModelsRequest,
  AiModelInfo,
  AiStreamChunkEvent,
  AiStreamDoneEvent,
  AiStreamErrorEvent,
} from '../../../shared/types';
import type {
  ChatChunk,
  ChatCompleteResult,
  ChatMessage,
  ChatOptions,
  ChatProvider,
  TokenUsage,
  ToolCall,
} from './chat.provider';
import type { EmbeddingProvider } from './embedding.provider';
import { AiHarnessError, stripIpcErrorPrefix, toAiErrorInfo } from './ai-harness-error';

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  embeddingModel: string;
  /**
   * Bound in ms for connecting and, for streams, the first token; values
   * above the default also extend the mid-stream idle bound. 0 disables all
   * request timeouts.
   */
  timeoutMs: number;
}

export type OpenAiConfigGetter = () => OpenAiCompatibleConfig;

/**
 * Narrow IPC surface used by the provider. Declared as an interface so the
 * concrete `IpcService` (which owns many unrelated channels) can be passed in
 * while keeping the provider trivially mockable in tests.
 */
export interface AiIpcAdapter {
  aiChatStream(req: AiChatStreamRequest): Promise<void>;
  aiChatAbort(streamId: string): Promise<void>;
  aiChatComplete(req: AiChatCompleteRequest): Promise<AiChatCompleteIpcResult>;
  aiEmbed(req: AiEmbedRequest): Promise<AiEmbedIpcResult>;
  aiListModels(req: AiListModelsRequest): Promise<AiListModelsIpcResult>;
  onAiStreamChunk(cb: (evt: AiStreamChunkEvent) => void): () => void;
  onAiStreamDone(cb: (evt: AiStreamDoneEvent) => void): () => void;
  onAiStreamError(cb: (evt: AiStreamErrorEvent) => void): () => void;
}

function toRequestOptions(opts: ChatOptions): AiChatRequestOptions | undefined {
  const out: AiChatRequestOptions = {};
  if (opts.temperature !== undefined) out.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) out.maxTokens = opts.maxTokens;
  if (opts.jsonObject) out.responseFormat = { type: 'json_object' };
  if (opts.tools && opts.tools.length > 0) {
    out.tools = opts.tools;
    out.toolChoice = opts.toolChoice ?? 'auto';
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function generateStreamId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Fallback for non-crypto environments (tests). Sufficient for de-duping.
  return `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export class OpenAiCompatibleChatProvider implements ChatProvider {
  constructor(
    private readonly getConfig: OpenAiConfigGetter,
    private readonly ipc: AiIpcAdapter,
  ) {}

  async *chat(
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): AsyncIterable<ChatChunk> {
    const cfg = this.getConfig();
    if (!cfg.apiKey) throw new Error('No API key configured. Open Settings to add one.');

    const streamId = generateStreamId();

    // Demultiplexing queue: chunks arrive over IPC events keyed by streamId
    // and are surfaced through an async iterator. Resolvers below feed the
    // queue so the consumer's `for await` sleeps until the next event.
    type Pending =
      | { kind: 'chunk'; delta: string; reasoning?: string }
      | { kind: 'done'; finishReason?: string; toolCalls?: ToolCall[]; usage?: TokenUsage }
      | { kind: 'error'; message: string; info?: AiErrorInfo };

    const queue: Pending[] = [];
    let resolveNext: ((v: Pending | null) => void) | null = null;
    let closed = false;

    const push = (item: Pending): void => {
      if (closed) return;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(item);
      } else {
        queue.push(item);
      }
    };

    const offChunk = this.ipc.onAiStreamChunk((evt) => {
      if (evt.streamId !== streamId) return;
      push({ kind: 'chunk', delta: evt.delta, reasoning: evt.reasoning });
    });
    const offDone = this.ipc.onAiStreamDone((evt) => {
      if (evt.streamId !== streamId) return;
      push({ kind: 'done', finishReason: evt.finishReason, toolCalls: evt.toolCalls, usage: evt.usage });
    });
    const offError = this.ipc.onAiStreamError((evt) => {
      if (evt.streamId !== streamId) return;
      push({ kind: 'error', message: evt.message, info: evt.error });
    });

    const cleanup = (): void => {
      closed = true;
      offChunk();
      offDone();
      offError();
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(null);
      }
    };

    let abortHandler: (() => void) | null = null;
    if (opts.signal) {
      if (opts.signal.aborted) {
        cleanup();
        throw new DOMException('Aborted', 'AbortError');
      }
      abortHandler = (): void => {
        void this.ipc.aiChatAbort(streamId);
        push({
          kind: 'error',
          message: 'Aborted',
        });
      };
      opts.signal.addEventListener('abort', abortHandler);
    }

    const request: AiChatStreamRequest = {
      streamId,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: opts.model ?? cfg.chatModel,
      messages,
      options: toRequestOptions(opts),
      timeoutMs: cfg.timeoutMs,
    };

    try {
      await this.ipc.aiChatStream(request);
    } catch (err) {
      cleanup();
      if (opts.signal && abortHandler) {
        opts.signal.removeEventListener('abort', abortHandler);
      }
      // Invoke rejections arrive with Electron's remote-method prefix; wrap
      // them so the orchestrator always sees a structured, prefix-free error.
      throw new AiHarnessError(toAiErrorInfo(err));
    }

    try {
      while (true) {
        const next: Pending | null = await new Promise<Pending | null>((resolve) => {
          const queued = queue.shift();
          if (queued !== undefined) {
            resolve(queued);
            return;
          }
          if (closed) {
            resolve(null);
            return;
          }
          resolveNext = resolve;
        });

        if (next === null) break;

        if (next.kind === 'chunk') {
          // Forward a chunk when EITHER channel has content this line, so a
          // reasoning-only line is not dropped before the answer arrives.
          if (next.delta || next.reasoning) {
            yield { delta: next.delta, done: false, reasoning: next.reasoning };
          }
        } else if (next.kind === 'done') {
          yield {
            delta: '',
            done: true,
            toolCalls: next.toolCalls,
            finishReason: next.finishReason,
            usage: next.usage,
          };
          break;
        } else {
          if (opts.signal?.aborted || next.message === 'Aborted') {
            throw new DOMException('Aborted', 'AbortError');
          }
          throw new AiHarnessError(
            next.info ?? {
              code: 'unknown',
              retryable: false,
              message: stripIpcErrorPrefix(next.message),
            },
          );
        }
      }
    } finally {
      cleanup();
      if (opts.signal && abortHandler) {
        opts.signal.removeEventListener('abort', abortHandler);
      }
    }
  }

  /**
   * Lists the provider's available models via the OpenAI-compatible
   * `GET {baseUrl}/models` endpoint. Takes an explicit config so callers
   * (e.g. the Settings draft) can probe a not-yet-saved base URL / key
   * without going through {@link getConfig}. apiKey may be empty for keyless
   * local providers.
   */
  async listModels(cfg: { baseUrl: string; apiKey: string; timeoutMs?: number }): Promise<AiModelInfo[]> {
    let res: AiListModelsIpcResult;
    try {
      res = await this.ipc.aiListModels({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        timeoutMs: cfg.timeoutMs,
      });
    } catch (err) {
      throw new AiHarnessError(toAiErrorInfo(err));
    }
    if (!res.ok) throw new AiHarnessError(res.error);
    return res.data.models;
  }

  async chatComplete(
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): Promise<ChatCompleteResult> {
    const cfg = this.getConfig();
    if (!cfg.apiKey) throw new Error('No API key configured. Open Settings to add one.');

    // The requestId gives the main process an abort handle for this
    // non-streaming call: a tripped signal forwards through the shared
    // chat-abort channel and cancels the underlying fetch.
    const requestId = generateStreamId();
    const request: AiChatCompleteRequest = {
      requestId,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: opts.model ?? cfg.chatModel,
      messages,
      options: toRequestOptions(opts),
      timeoutMs: cfg.timeoutMs,
    };

    if (opts.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    let abortHandler: (() => void) | null = null;
    if (opts.signal) {
      abortHandler = (): void => {
        void this.ipc.aiChatAbort(requestId);
      };
      opts.signal.addEventListener('abort', abortHandler);
    }

    try {
      const result = await this.ipc.aiChatComplete(request);
      if (opts.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      if (!result.ok) {
        throw new AiHarnessError(result.error);
      }
      return {
        content: result.data.content,
        reasoning: result.data.reasoning,
        toolCalls: result.data.toolCalls,
        finishReason: result.data.finishReason,
        usage: result.data.usage,
      };
    } catch (err) {
      if (err instanceof AiHarnessError || err instanceof DOMException) throw err;
      throw new AiHarnessError(toAiErrorInfo(err));
    } finally {
      if (opts.signal && abortHandler) {
        opts.signal.removeEventListener('abort', abortHandler);
      }
    }
  }
}

export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  private _dim: number | undefined;

  constructor(
    private readonly getConfig: OpenAiConfigGetter,
    private readonly ipc: AiIpcAdapter,
  ) {}

  get model(): string {
    return this.getConfig().embeddingModel;
  }

  get dim(): number | undefined {
    return this._dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const cfg = this.getConfig();
    if (!cfg.apiKey) throw new Error('No API key configured. Open Settings to add one.');
    if (texts.length === 0) return [];

    let res: AiEmbedIpcResult;
    try {
      res = await this.ipc.aiEmbed({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.embeddingModel,
        texts,
        timeoutMs: cfg.timeoutMs,
      });
    } catch (err) {
      throw new AiHarnessError(toAiErrorInfo(err));
    }
    if (!res.ok) {
      throw new AiHarnessError(res.error);
    }

    if (res.data.vectors.length > 0 && this._dim === undefined) {
      this._dim = res.data.dim || res.data.vectors[0]?.length;
    }
    return res.data.vectors;
  }
}
