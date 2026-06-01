import { vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { IpcService } from '../../../core/ipc.service';
import type { ToolCall } from '../providers/chat.provider';
import type { ToolContext } from './tool';
import { READ_FILE_MAX_CHARS, ReadFileTool } from './read-file.tool';

/**
 * Builds a `read_file` tool call whose `function.arguments` is the JSON-encoded
 * form of `args`. Pass a raw string to exercise the malformed-JSON guard.
 */
function makeCall(args: unknown, id = 'call_1'): ToolCall {
  return {
    id,
    type: 'function',
    function: {
      name: 'read_file',
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  };
}

describe('ReadFileTool.execute', () => {
  let tool: ReadFileTool;
  let readFile: ReturnType<typeof vi.fn>;
  const ctx: ToolContext = { sessionId: 42, vaultPath: '/vault' };

  beforeEach(() => {
    readFile = vi.fn();
    TestBed.configureTestingModule({
      providers: [{ provide: IpcService, useValue: { readFile } }],
    });
    tool = TestBed.inject(ReadFileTool);
  });

  it('returns the file content for a valid path with no proposal', async () => {
    readFile.mockResolvedValue('# Title\n\nBody.');

    const result = await tool.execute(makeCall({ path: 'prd/feature-x.md' }), ctx);

    expect(result.toolCallId).toBe('call_1');
    expect(result.content).toBe('# Title\n\nBody.');
    expect(result.content.startsWith('Error:')).toBe(false);
    expect(result.proposal).toBeUndefined();
    expect(readFile).toHaveBeenCalledWith('/vault/prd/feature-x.md');
  });

  it('truncates content over the cap and reports the next offset', async () => {
    const total = READ_FILE_MAX_CHARS + 500;
    const raw = 'a'.repeat(total);
    readFile.mockResolvedValue(raw);

    const result = await tool.execute(makeCall({ path: 'big.md' }), ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content.startsWith('a'.repeat(READ_FILE_MAX_CHARS))).toBe(true);
    // Truncation note: characters 0–8000 of 8500, next offset = 8000.
    expect(result.content).toContain(`showing characters 0–${READ_FILE_MAX_CHARS} of ${total}`);
    expect(result.content).toContain(`offset=${READ_FILE_MAX_CHARS}`);
  });

  it('returns the correct slice when paging with offset', async () => {
    const raw = 'HEAD' + 'b'.repeat(READ_FILE_MAX_CHARS) + 'TAIL';
    readFile.mockResolvedValue(raw);

    const result = await tool.execute(makeCall({ path: 'big.md', offset: 4 }), ctx);

    const expectedSlice = raw.slice(4, 4 + READ_FILE_MAX_CHARS);
    expect(result.content.startsWith(expectedSlice)).toBe(true);
    expect(result.content).toContain(`showing characters 4–${4 + READ_FILE_MAX_CHARS}`);
  });

  it('reads the final page without a truncation note when it fits', async () => {
    const raw = 'x'.repeat(100);
    readFile.mockResolvedValue(raw);

    const result = await tool.execute(makeCall({ path: 'small.md', offset: 50 }), ctx);

    expect(result.content).toBe(raw.slice(50));
    expect(result.content).not.toContain('truncated');
  });

  it('returns an end-of-file note when offset is at or past the length', async () => {
    readFile.mockResolvedValue('short');

    const result = await tool.execute(makeCall({ path: 'a.md', offset: 100 }), ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content.startsWith('Error:')).toBe(false);
    expect(result.content).toContain('Offset 100 is at or past the end of a.md');
    expect(result.content).toContain('total length 5 characters');
  });

  it('returns an empty-file note for a zero-length file', async () => {
    readFile.mockResolvedValue('');

    const result = await tool.execute(makeCall({ path: 'a.md' }), ctx);

    expect(result.content).toBe('a.md is empty (0 characters).');
  });

  it('rejects a path containing `..` with an error and no proposal', async () => {
    const result = await tool.execute(makeCall({ path: '../escape.md' }), ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content.startsWith('Error:')).toBe(true);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('rejects a Windows drive-letter absolute path', async () => {
    const result = await tool.execute(makeCall({ path: 'C:\\x.md' }), ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content.startsWith('Error:')).toBe(true);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('rejects a POSIX absolute path', async () => {
    const result = await tool.execute(makeCall({ path: '/x.md' }), ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content.startsWith('Error:')).toBe(true);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('rejects a non-.md extension', async () => {
    const result = await tool.execute(makeCall({ path: 'notes/a.txt' }), ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content.startsWith('Error:')).toBe(true);
    expect(result.content).toContain('.md');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('rejects a missing/empty path', async () => {
    const result = await tool.execute(makeCall({}), ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content.startsWith('Error:')).toBe(true);
  });

  it('reports "File not found or unreadable" when ipc.readFile rejects', async () => {
    readFile.mockRejectedValue(new Error('ENOENT'));

    const result = await tool.execute(makeCall({ path: 'prd/missing.md' }), ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content).toBe('Error: File not found or unreadable: prd/missing.md');
  });

  it('rejects malformed JSON arguments via the guarded parse', async () => {
    const result = await tool.execute(makeCall('{ not valid json '), ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content.startsWith('Error:')).toBe(true);
    expect(result.content).toContain('JSON');
  });
});
