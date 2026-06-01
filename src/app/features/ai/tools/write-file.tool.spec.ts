import type { ToolCall } from '../providers/chat.provider';
import type { ToolContext } from './tool';
import { PENDING_CONFIRMATION, WriteFileTool } from './write-file.tool';

/**
 * Builds a `write_file` tool call whose `function.arguments` is the JSON-encoded
 * form of `args`. Pass a raw string to exercise the malformed-JSON guard.
 */
function makeCall(args: unknown, id = 'call_1'): ToolCall {
  return {
    id,
    type: 'function',
    function: {
      name: 'write_file',
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  };
}

describe('WriteFileTool.execute', () => {
  let tool: WriteFileTool;
  const ctx: ToolContext = { sessionId: 42, vaultPath: '/vault' };

  beforeEach(() => {
    tool = new WriteFileTool();
  });

  it('returns a create proposal for valid args (no error)', async () => {
    const call = makeCall({
      path: 'prd/feature-x.md',
      title: 'Feature X',
      content: '# Feature X\n\nBody.',
    });

    const result = await tool.execute(call, ctx);

    expect(result.toolCallId).toBe('call_1');
    expect(result.content).toBe(PENDING_CONFIRMATION);
    expect(result.content.startsWith('Error:')).toBe(false);
    expect(result.proposal).toBeTruthy();
    expect(result.proposal).toEqual({
      relPath: 'prd/feature-x.md',
      changeType: 'create',
      title: 'Feature X',
      content: '# Feature X\n\nBody.',
      sessionId: 42,
    });
  });

  it('defaults the title to the canonical path when title is omitted', async () => {
    const call = makeCall({ path: 'notes/a.md', content: 'hello' });

    const result = await tool.execute(call, ctx);

    expect(result.proposal?.title).toBe('notes/a.md');
  });

  it('canonicalizes backslash separators in the proposal relPath', async () => {
    const call = makeCall({ path: 'prd\\nested\\x.md', content: 'x' });

    const result = await tool.execute(call, ctx);

    expect(result.proposal?.relPath).toBe('prd/nested/x.md');
  });

  it('rejects a path containing `..` with an error and no proposal', async () => {
    const call = makeCall({ path: '../escape.md', content: 'x' });

    const result = await tool.execute(call, ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content.startsWith('Error:')).toBe(true);
    expect(result.toolCallId).toBe('call_1');
  });

  it('rejects a Windows drive-letter absolute path', async () => {
    const call = makeCall({ path: 'C:\\x.md', content: 'x' });

    const result = await tool.execute(call, ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content.startsWith('Error:')).toBe(true);
  });

  it('rejects a POSIX absolute path', async () => {
    const call = makeCall({ path: '/x.md', content: 'x' });

    const result = await tool.execute(call, ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content.startsWith('Error:')).toBe(true);
  });

  it('rejects a non-.md extension', async () => {
    const call = makeCall({ path: 'notes/a.txt', content: 'x' });

    const result = await tool.execute(call, ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content.startsWith('Error:')).toBe(true);
    expect(result.content).toContain('.md');
  });

  it('rejects malformed JSON arguments via the guarded parse', async () => {
    const call = makeCall('{ not valid json ');

    const result = await tool.execute(call, ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content.startsWith('Error:')).toBe(true);
    expect(result.content).toContain('JSON');
  });

  it('rejects empty content', async () => {
    const call = makeCall({ path: 'a.md', content: '   ' });

    const result = await tool.execute(call, ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content.startsWith('Error:')).toBe(true);
  });

  it('rejects missing content', async () => {
    const call = makeCall({ path: 'a.md' });

    const result = await tool.execute(call, ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content.startsWith('Error:')).toBe(true);
  });

  it('rejects a missing/empty path', async () => {
    const call = makeCall({ content: 'x' });

    const result = await tool.execute(call, ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content.startsWith('Error:')).toBe(true);
  });
});
