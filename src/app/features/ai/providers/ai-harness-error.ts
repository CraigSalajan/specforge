import type { AiErrorInfo } from '../../../shared/types';

/**
 * Electron stringifies errors rejected from `ipcMain.handle` and prepends
 * `Error invoking remote method '<channel>': Error: `. That prefix is an
 * implementation detail and must never reach the user.
 */
const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/;

export function stripIpcErrorPrefix(message: string): string {
  return message.replace(IPC_ERROR_PREFIX, '');
}

/**
 * Renderer-side carrier for a classified AI request failure. Thrown by the
 * provider layer so the orchestrator can surface `info` (code, retryability,
 * Retry-After hint) instead of a raw message string.
 */
export class AiHarnessError extends Error {
  constructor(readonly info: AiErrorInfo) {
    super(info.message);
    this.name = 'AiHarnessError';
  }
}

/**
 * Normalizes any thrown value into an {@link AiErrorInfo}. Structured errors
 * pass through; everything else becomes a non-retryable `unknown` with the
 * IPC prefix stripped from its message.
 */
export function toAiErrorInfo(err: unknown): AiErrorInfo {
  if (err instanceof AiHarnessError) return err.info;
  const raw = err instanceof Error ? err.message : String(err);
  const message = stripIpcErrorPrefix(raw).trim();
  return {
    code: 'unknown',
    retryable: false,
    message: message.length > 0 ? message : 'Something went wrong.',
  };
}
