import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';

const Channels = {
  ChatStream: 'specforge:ai-chat-stream',
  ChatAbort: 'specforge:ai-chat-abort',
  ChatComplete: 'specforge:ai-chat-complete',
  Embed: 'specforge:ai-embed',
  StreamChunk: 'specforge:ai-stream-chunk',
  StreamDone: 'specforge:ai-stream-done',
  StreamError: 'specforge:ai-stream-error',
} as const;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatRequestOptions {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: { type: 'json_object' };
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
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string | null;
  }>;
}

interface EmbeddingsResponsePayload {
  data?: Array<{ index: number; embedding: number[] }>;
}

interface ActiveStream {
  controller: AbortController;
  sender: WebContents;
}

const activeStreams = new Map<string, ActiveStream>();

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
    if (msg.role !== 'system' && msg.role !== 'user' && msg.role !== 'assistant') {
      throw new Error(`messages[${i}].role is invalid`);
    }
    if (typeof msg.content !== 'string') {
      throw new Error(`messages[${i}].content must be a string`);
    }
    return { role: msg.role, content: msg.content };
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
    try {
      const body = buildChatBody(model, messages, req.options, true);
      const res = await fetch(`${trimBaseUrl(baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const text = await readErrorBody(res);
        throw new Error(
          `Chat request failed: ${res.status} ${res.statusText}${text ? ' — ' + text : ''}`,
        );
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;

      try {
        while (!finished) {
          const { value, done } = await reader.read();
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
              const delta = json.choices?.[0]?.delta?.content ?? '';
              const fr = json.choices?.[0]?.finish_reason ?? null;
              if (fr) finishReason = fr;
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

      safeSend(sender, Channels.StreamDone, { streamId, finishReason });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.name === 'AbortError'
            ? 'Aborted'
            : err.message
          : String(err);
      safeSend(sender, Channels.StreamError, { streamId, message });
    } finally {
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
  _event: IpcMainInvokeEvent,
  req: ChatCompleteRequest,
): Promise<string> {
  if (!req || typeof req !== 'object') throw new Error('Invalid request payload');
  const baseUrl = assertNonEmptyString(req.baseUrl, 'baseUrl');
  const apiKey = assertNonEmptyString(req.apiKey, 'apiKey');
  const model = assertNonEmptyString(req.model, 'model');
  const messages = assertMessages(req.messages);

  const body = buildChatBody(model, messages, req.options, false);
  const res = await fetch(`${trimBaseUrl(baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await readErrorBody(res);
    throw new Error(
      `Chat request failed: ${res.status} ${res.statusText}${text ? ' — ' + text : ''}`,
    );
  }

  const json = (await res.json()) as ChatCompletionResponse;
  return json.choices?.[0]?.message?.content ?? '';
}

async function handleEmbed(_event: IpcMainInvokeEvent, req: EmbedRequest): Promise<EmbedResponse> {
  if (!req || typeof req !== 'object') throw new Error('Invalid request payload');
  const baseUrl = assertNonEmptyString(req.baseUrl, 'baseUrl');
  const apiKey = assertNonEmptyString(req.apiKey, 'apiKey');
  const model = assertNonEmptyString(req.model, 'model');
  const texts = assertTexts(req.texts);

  if (texts.length === 0) {
    return { vectors: [], model, dim: 0 };
  }

  const res = await fetch(`${trimBaseUrl(baseUrl)}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input: texts }),
  });

  if (!res.ok) {
    const text = await readErrorBody(res);
    throw new Error(
      `Embeddings request failed: ${res.status} ${res.statusText}${text ? ' — ' + text : ''}`,
    );
  }

  const json = (await res.json()) as EmbeddingsResponsePayload;
  const data = (json.data ?? []).slice().sort((a, b) => a.index - b.index);
  const vectors = data.map((d) => d.embedding);
  const dim = vectors[0]?.length ?? 0;
  return { vectors, model, dim };
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
