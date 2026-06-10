import type { AiErrorInfo } from '../../../shared/types';
import { AiHarnessError, stripIpcErrorPrefix, toAiErrorInfo } from './ai-harness-error';

/**
 * Tests the renderer-side error carrier: structured infos pass through
 * untouched, and Electron's "Error invoking remote method '…'" prefix never
 * survives normalization.
 */
describe('ai-harness-error', () => {
  it('strips the Electron remote-method prefix (with and without the inner "Error:")', () => {
    expect(
      stripIpcErrorPrefix("Error invoking remote method 'specforge:ai-chat-complete': Error: boom"),
    ).toBe('boom');
    expect(
      stripIpcErrorPrefix("Error invoking remote method 'specforge:ai-embed': not serializable"),
    ).toBe('not serializable');
    expect(stripIpcErrorPrefix('plain message')).toBe('plain message');
  });

  it('passes a structured AiHarnessError info through unchanged', () => {
    const info: AiErrorInfo = {
      code: 'rate_limit',
      status: 429,
      retryAfterMs: 1500,
      retryable: true,
      message: 'Rate limit exceeded',
    };
    expect(toAiErrorInfo(new AiHarnessError(info))).toBe(info);
  });

  it('normalizes arbitrary errors to a non-retryable unknown with the prefix stripped', () => {
    const info = toAiErrorInfo(
      new Error("Error invoking remote method 'specforge:ai-chat-stream': Error: kaput"),
    );
    expect(info).toEqual({ code: 'unknown', retryable: false, message: 'kaput' });
  });

  it('falls back to a generic message for empty error text', () => {
    const info = toAiErrorInfo(new Error(''));
    expect(info.code).toBe('unknown');
    expect(info.message).toBe('Something went wrong.');
  });
});
