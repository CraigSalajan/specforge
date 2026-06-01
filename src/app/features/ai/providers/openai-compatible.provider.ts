import type {
  AiChatCompleteRequest,
  AiChatRequestOptions,
  AiChatStreamRequest,
  AiEmbedRequest,
  AiEmbedResponse,
  AiStreamChunkEvent,
  AiStreamDoneEvent,
  AiStreamErrorEvent,
} from '../../../shared/types';
import type { ChatChunk, ChatMessage, ChatOptions, ChatProvider } from './chat.provider';
import type { EmbeddingProvider } from './embedding.provider';

export interface OpenAiCompatibleConfig {
  baseUrl: string;
  apiKey: string;
  chatModel: string;
  embeddingModel: string;
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
  aiChatComplete(req: AiChatCompleteRequest): Promise<string>;
  aiEmbed(req: AiEmbedRequest): Promise<AiEmbedResponse>;
  onAiStreamChunk(cb: (evt: AiStreamChunkEvent) => void): () => void;
  onAiStreamDone(cb: (evt: AiStreamDoneEvent) => void): () => void;
  onAiStreamError(cb: (evt: AiStreamErrorEvent) => void): () => void;
}

function toRequestOptions(opts: ChatOptions): AiChatRequestOptions | undefined {
  const out: AiChatRequestOptions = {};
  if (opts.temperature !== undefined) out.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) out.maxTokens = opts.maxTokens;
  if (opts.jsonObject) out.responseFormat = { type: 'json_object' };
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
      | { kind: 'chunk'; delta: string }
      | { kind: 'done'; finishReason?: string }
      | { kind: 'error'; message: string };

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
      push({ kind: 'chunk', delta: evt.delta });
    });
    const offDone = this.ipc.onAiStreamDone((evt) => {
      if (evt.streamId !== streamId) return;
      push({ kind: 'done', finishReason: evt.finishReason });
    });
    const offError = this.ipc.onAiStreamError((evt) => {
      if (evt.streamId !== streamId) return;
      push({ kind: 'error', message: evt.message });
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
    };

    try {
      await this.ipc.aiChatStream(request);
    } catch (err) {
      cleanup();
      if (opts.signal && abortHandler) {
        opts.signal.removeEventListener('abort', abortHandler);
      }
      throw err instanceof Error ? err : new Error(String(err));
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
          if (next.delta) yield { delta: next.delta, done: false };
        } else if (next.kind === 'done') {
          yield { delta: '', done: true };
          break;
        } else {
          if (opts.signal?.aborted || next.message === 'Aborted') {
            throw new DOMException('Aborted', 'AbortError');
          }
          throw new Error(next.message);
        }
      }
    } finally {
      cleanup();
      if (opts.signal && abortHandler) {
        opts.signal.removeEventListener('abort', abortHandler);
      }
    }
  }

  async chatComplete(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const cfg = this.getConfig();
    if (!cfg.apiKey) throw new Error('No API key configured. Open Settings to add one.');

    const request: AiChatCompleteRequest = {
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: opts.model ?? cfg.chatModel,
      messages,
      options: toRequestOptions(opts),
    };

    // Honor caller-side cancellation: if the signal is already tripped, fail
    // fast; otherwise the main process holds no abort handle for the
    // non-streaming path (callers use streaming for cancellable turns).
    if (opts.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const result = await this.ipc.aiChatComplete(request);
    if (opts.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    return result;
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

    const res = await this.ipc.aiEmbed({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.embeddingModel,
      texts,
    });

    if (res.vectors.length > 0 && this._dim === undefined) {
      this._dim = res.dim || res.vectors[0]?.length;
    }
    return res.vectors;
  }
}
