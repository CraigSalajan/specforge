import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import {
  accumulateToolCallDeltas,
  assembleToolCalls,
  type StreamToolCallDelta,
} from './tool-call-accumulator';
import {
  CONNECT_TIMEOUT_MS,
  RESPONSE_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_MS,
  abortedInfo,
  fetchFailureInfo,
  httpErrorInfo,
  invalidRequestInfo,
  timeoutInfo,
  type AiErrorInfo,
} from './ai-error';

const Channels = {
  ChatStream: 'specforge:ai-chat-stream',
  ChatAbort: 'specforge:ai-chat-abort',
  ChatComplete: 'specforge:ai-chat-complete',
  Embed: 'specforge:ai-embed',
  StreamChunk: 'specforge:ai-stream-chunk',
  StreamDone: 'specforge:ai-stream-done',
  StreamError: 'specforge:ai-stream-error',
} as const;

interface ToolFunctionDef {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

interface ToolDef {
  type: 'function';
  function: ToolFunctionDef;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ChatRequestOptions {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' };
  tools?: ToolDef[];
  tool_choice?: 'auto' | 'none' | 'required';
}

interface ChatStreamRequest {
  streamId: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  options?: ChatRequestOptions;
}

interface ChatCompleteRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  options?: ChatRequestOptions;
  /**
   * Optional caller-generated id registered in {@link activeStreams} so the
   * renderer can abort a non-streaming completion via the ChatAbort channel.
   */
  requestId?: string;
}

interface EmbedRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  texts: string[];
}

interface EmbedResponse {
  vectors: number[][];
  model: string;
  dim: number;
}

interface ChatCompletionStreamPayload {
  choices?: Array<{
    delta?: { content?: string; tool_calls?: StreamToolCallDelta[] };
    finish_reason?: string | null;
  }>;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: ToolCall[] };
    finish_reason?: string | null;
  }>;
}

interface ChatCompleteResult {
  content: string | null;
  toolCalls?: ToolCall[];
  finishReason?: string;
}

/**
 * Discriminated results for the non-streaming handlers. `ipcMain.handle`
 * rejections are stringified by Electron and prefixed with
 * `Error invoking remote method '…'`, so failures travel as data instead —
 * mirrored renderer-side in `src/app/shared/types.ts`.
 */
type ChatCompleteIpcResult =
  | { ok: true; data: ChatCompleteResult }
  | { ok: false; error: AiErrorInfo };

type EmbedIpcResult = { ok: true; data: EmbedResponse } | { ok: false; error: AiErrorInfo };

interface EmbeddingsResponsePayload {
  data?: Array<{ index: number; embedding: number[] }>;
}

interface ActiveStream {
  controller: AbortController;
  sender: WebContents;
}

const activeStreams = new Map<string, ActiveStream>();

/** Internal carrier so a classified provider failure survives a `throw`. */
class AiRequestError extends Error {
  constructor(readonly info: AiErrorInfo) {
    super(info.message);
    this.name = 'AiRequestError';
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function trimBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function assertNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function assertMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('messages must be a non-empty array');
  }
  return value.map((m, i) => {
    if (!m || typeof m !== 'object') {
      throw new Error(`messages[${i}] is not an object`);
    }
    const msg = m as Partial<ChatMessage>;
    if (
      msg.role !== 'system' &&
      msg.role !== 'user' &&
      msg.role !== 'assistant' &&
      msg.role !== 'tool'
    ) {
      throw new Error(`messages[${i}].role is invalid`);
    }
    const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    // Content may be null on an assistant message that only carries tool_calls.
    if (typeof msg.content !== 'string' && !(msg.content === null && hasToolCalls)) {
      throw new Error(`messages[${i}].content must be a string`);
    }
    const out: ChatMessage = { role: msg.role, content: msg.content ?? null };
    if (hasToolCalls) out.tool_calls = msg.tool_calls;
    if (typeof msg.tool_call_id === 'string') out.tool_call_id = msg.tool_call_id;
    if (typeof msg.name === 'string') out.name = msg.name;
    return out;
  });
}

function assertTexts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('texts must be an array');
  }
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string') {
      throw new Error(`texts[${i}] is not a string`);
    }
  }
  return value as string[];
}

function buildChatBody(
  model: string,
  messages: ChatMessage[],
  options: ChatRequestOptions | undefined,
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = { model, messages, stream };
  if (options?.temperature !== undefined) body['temperature'] = options.temperature;
  if (options?.maxTokens !== undefined) body['max_tokens'] = options.maxTokens;
  if (options?.responseFormat) body['response_format'] = options.responseFormat;
  if (options?.tools && options.tools.length > 0) {
    body['tools'] = options.tools;
    body['tool_choice'] = options.tool_choice ?? 'auto';
  }
  return body;
}

function safeSend(sender: WebContents, channel: string, payload: unknown): void {
  if (sender.isDestroyed()) return;
  sender.send(channel, payload);
}

async function readErrorBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

async function handleChatStream(
  event: IpcMainInvokeEvent,
  req: ChatStreamRequest,
): Promise<void> {
  if (!req || typeof req !== 'object') throw new Error('Invalid request payload');
  const streamId = assertNonEmptyString(req.streamId, 'streamId');
  const baseUrl = assertNonEmptyString(req.baseUrl, 'baseUrl');
  const apiKey = assertNonEmptyString(req.apiKey, 'apiKey');
  const model = assertNonEmptyString(req.model, 'model');
  const messages = assertMessages(req.messages);

  if (activeStreams.has(streamId)) {
    throw new Error(`Duplicate active streamId: ${streamId}`);
  }

  const sender = event.sender;
  const controller = new AbortController();
  activeStreams.set(streamId, { controller, sender });

  const cleanupOnSenderDestroyed = (): void => {
    const active = activeStreams.get(streamId);
    if (active) {
      active.controller.abort();
      activeStreams.delete(streamId);
    }
  };
  sender.once('destroyed', cleanupOnSenderDestroyed);

  // Kick off the streaming fetch in the background. We resolve the IPC invoke
  // immediately so the renderer is free to wire up listeners and react to
  // events; everything from here is event-driven.
  void (async (): Promise<void> => {
    let finishReason: string | undefined;
    // Accumulates streamed tool_call fragments by their `index`. OpenAI emits
    // the `id`/`function.name` once and then streams `function.arguments` in
    // pieces, all keyed by the same index.
    const toolAccumulator = new Map<number, { id: string; name: string; args: string }>();

    // Watchdog: aborts the fetch when the provider goes silent — first while
    // waiting for response headers, then between streamed chunks. `timedOut`
    // lets the catch block tell a watchdog abort apart from a user Stop.
    let timedOut: 'connect' | 'idle' | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const armWatchdog = (kind: 'connect' | 'idle', ms: number): void => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        timedOut = kind;
        controller.abort();
      }, ms);
    };
    const disarmWatchdog = (): void => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = null;
    };

    try {
      const body = buildChatBody(model, messages, req.options, true);
      armWatchdog('connect', CONNECT_TIMEOUT_MS);
      const res = await fetch(`${trimBaseUrl(baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      armWatchdog('idle', STREAM_IDLE_TIMEOUT_MS);

      if (!res.ok || !res.body) {
        const text = await readErrorBody(res);
        throw new AiRequestError(
          httpErrorInfo(res.status, res.statusText, text, res.headers.get('retry-after')),
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;

      try {
        while (!finished) {
          const { value, done } = await reader.read();
          armWatchdog('idle', STREAM_IDLE_TIMEOUT_MS);
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const newlineIdx = buffer.lastIndexOf('\n');
          if (newlineIdx === -1) continue;
          const ready = buffer.slice(0, newlineIdx);
          buffer = buffer.slice(newlineIdx + 1);
          for (const line of ready.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.length === 0 || !trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') {
              finished = true;
              break;
            }
            try {
              const json = JSON.parse(payload) as ChatCompletionStreamPayload;
              const choice = json.choices?.[0];
              const delta = choice?.delta?.content ?? '';
              const fr = choice?.finish_reason ?? null;
              if (fr) finishReason = fr;
              accumulateToolCallDeltas(toolAccumulator, choice?.delta?.tool_calls);
              if (delta) {
                safeSend(sender, Channels.StreamChunk, { streamId, delta });
              }
            } catch {
              // Skip malformed SSE payloads rather than crashing the stream.
            }
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
      }

      const toolCalls = assembleToolCalls(toolAccumulator);

      safeSend(sender, Channels.StreamDone, { streamId, finishReason, toolCalls });
    } catch (err) {
      if (err instanceof AiRequestError) {
        safeSend(sender, Channels.StreamError, {
          streamId,
          message: err.info.message,
          error: err.info,
        });
      } else if (isAbortError(err) && timedOut) {
        const info = timeoutInfo(timedOut);
        safeSend(sender, Channels.StreamError, { streamId, message: info.message, error: info });
      } else if (isAbortError(err)) {
        // User-initiated Stop: the renderer translates this back into an
        // AbortError and keeps any partial text without surfacing an error.
        safeSend(sender, Channels.StreamError, { streamId, message: 'Aborted' });
      } else {
        const info = fetchFailureInfo(err);
        safeSend(sender, Channels.StreamError, { streamId, message: info.message, error: info });
      }
    } finally {
      disarmWatchdog();
      activeStreams.delete(streamId);
      sender.removeListener('destroyed', cleanupOnSenderDestroyed);
    }
  })();
}

async function handleChatAbort(_event: IpcMainInvokeEvent, streamId: unknown): Promise<void> {
  if (typeof streamId !== 'string' || streamId.length === 0) return;
  const active = activeStreams.get(streamId);
  if (!active) return;
  active.controller.abort();
  activeStreams.delete(streamId);
}

async function handleChatComplete(
  event: IpcMainInvokeEvent,
  req: ChatCompleteRequest,
): Promise<ChatCompleteIpcResult> {
  let baseUrl: string;
  let apiKey: string;
  let model: string;
  let messages: ChatMessage[];
  try {
    if (!req || typeof req !== 'object') throw new Error('Invalid request payload');
    baseUrl = assertNonEmptyString(req.baseUrl, 'baseUrl');
    apiKey = assertNonEmptyString(req.apiKey, 'apiKey');
    model = assertNonEmptyString(req.model, 'model');
    messages = assertMessages(req.messages);
  } catch (err) {
    return { ok: false, error: invalidRequestInfo(err instanceof Error ? err.message : String(err)) };
  }

  const requestId =
    typeof req.requestId === 'string' && req.requestId.length > 0 && !activeStreams.has(req.requestId)
      ? req.requestId
      : null;
  const controller = new AbortController();
  if (requestId) activeStreams.set(requestId, { controller, sender: event.sender });

  let timedOut: 'connect' | 'response' | null = null;
  let timer = setTimeout(() => {
    timedOut = 'connect';
    controller.abort();
  }, CONNECT_TIMEOUT_MS);

  try {
    const body = buildChatBody(model, messages, req.options, false);
    const res = await fetch(`${trimBaseUrl(baseUrl)}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    // Headers arrived: swap the connect watchdog for a body-completion bound.
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = 'response';
      controller.abort();
    }, RESPONSE_TIMEOUT_MS);

    if (!res.ok) {
      const text = await readErrorBody(res);
      return {
        ok: false,
        error: httpErrorInfo(res.status, res.statusText, text, res.headers.get('retry-after')),
      };
    }

    const json = (await res.json()) as ChatCompletionResponse;
    const choice = json.choices?.[0];
    const toolCalls = choice?.message?.tool_calls;
    return {
      ok: true,
      data: {
        content: choice?.message?.content ?? '',
        toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
        finishReason: choice?.finish_reason ?? undefined,
      },
    };
  } catch (err) {
    if (isAbortError(err)) {
      return { ok: false, error: timedOut ? timeoutInfo(timedOut) : abortedInfo() };
    }
    return { ok: false, error: fetchFailureInfo(err) };
  } finally {
    clearTimeout(timer);
    if (requestId) activeStreams.delete(requestId);
  }
}

async function handleEmbed(_event: IpcMainInvokeEvent, req: EmbedRequest): Promise<EmbedIpcResult> {
  let baseUrl: string;
  let apiKey: string;
  let model: string;
  let texts: string[];
  try {
    if (!req || typeof req !== 'object') throw new Error('Invalid request payload');
    baseUrl = assertNonEmptyString(req.baseUrl, 'baseUrl');
    apiKey = assertNonEmptyString(req.apiKey, 'apiKey');
    model = assertNonEmptyString(req.model, 'model');
    texts = assertTexts(req.texts);
  } catch (err) {
    return { ok: false, error: invalidRequestInfo(err instanceof Error ? err.message : String(err)) };
  }

  if (texts.length === 0) {
    return { ok: true, data: { vectors: [], model, dim: 0 } };
  }

  const controller = new AbortController();
  let timedOut: 'connect' | 'response' | null = null;
  let timer = setTimeout(() => {
    timedOut = 'connect';
    controller.abort();
  }, CONNECT_TIMEOUT_MS);

  try {
    const res = await fetch(`${trimBaseUrl(baseUrl)}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, input: texts }),
      signal: controller.signal,
    });

    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = 'response';
      controller.abort();
    }, RESPONSE_TIMEOUT_MS);

    if (!res.ok) {
      const text = await readErrorBody(res);
      return {
        ok: false,
        error: httpErrorInfo(res.status, res.statusText, text, res.headers.get('retry-after')),
      };
    }

    const json = (await res.json()) as EmbeddingsResponsePayload;
    const data = (json.data ?? []).slice().sort((a, b) => a.index - b.index);
    const vectors = data.map((d) => d.embedding);
    const dim = vectors[0]?.length ?? 0;
    return { ok: true, data: { vectors, model, dim } };
  } catch (err) {
    if (isAbortError(err)) {
      return { ok: false, error: timedOut ? timeoutInfo(timedOut) : abortedInfo() };
    }
    return { ok: false, error: fetchFailureInfo(err) };
  } finally {
    clearTimeout(timer);
  }
}

export function registerAiHandlers(): void {
  ipcMain.handle(Channels.ChatStream, handleChatStream);
  ipcMain.handle(Channels.ChatAbort, handleChatAbort);
  ipcMain.handle(Channels.ChatComplete, handleChatComplete);
  ipcMain.handle(Channels.Embed, handleEmbed);
}

export function disposeAiHandlers(): void {
  for (const [, active] of activeStreams) {
    try {
      active.controller.abort();
    } catch {
      // ignore
    }
  }
  activeStreams.clear();
}
