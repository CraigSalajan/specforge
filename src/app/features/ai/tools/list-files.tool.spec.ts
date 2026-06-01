import { vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { IpcService } from '../../../core/ipc.service';
import type { ToolCall } from '../providers/chat.provider';
import type { FileNode } from '../../../shared/types';
import type { ToolContext } from './tool';
import { LIST_FILES_MAX, ListFilesTool } from './list-files.tool';

/**
 * Builds a `list_files` tool call whose `function.arguments` is the JSON-encoded
 * form of `args`. Pass a raw string to exercise the malformed-JSON guard.
 */
function makeCall(args: unknown, id = 'call_1'): ToolCall {
  return {
    id,
    type: 'function',
    function: {
      name: 'list_files',
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  };
}

/** A file leaf node with an ABSOLUTE path (mirrors the real IPC contract). */
function file(absPath: string): FileNode {
  return { name: absPath.split('/').pop() ?? absPath, path: absPath, isDirectory: false };
}

/** A directory node carrying children. */
function dir(absPath: string, children: FileNode[]): FileNode {
  return { name: absPath.split('/').pop() ?? absPath, path: absPath, isDirectory: true, children };
}

describe('ListFilesTool.execute', () => {
  let tool: ListFilesTool;
  let listFiles: ReturnType<typeof vi.fn>;
  const ctx: ToolContext = { sessionId: 42, vaultPath: '/vault' };

  beforeEach(() => {
    listFiles = vi.fn();
    TestBed.configureTestingModule({
      providers: [{ provide: IpcService, useValue: { listFiles } }],
    });
    tool = TestBed.inject(ListFilesTool);
  });

  it('flattens a nested tree to sorted vault-relative .md paths, dropping non-.md', async () => {
    listFiles.mockResolvedValue([
      dir('/vault/prd', [file('/vault/prd/zeta.md'), file('/vault/prd/alpha.md')]),
      file('/vault/readme.md'),
      file('/vault/notes.txt'), // non-markdown — excluded
      dir('/vault/adr', [
        dir('/vault/adr/auth', [file('/vault/adr/auth/0001.md')]),
        file('/vault/adr/index.md'),
      ]),
    ]);

    const result = await tool.execute(makeCall({}), ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content.startsWith('Error:')).toBe(false);
    expect(result.content.split('\n')).toEqual([
      'adr/auth/0001.md',
      'adr/index.md',
      'prd/alpha.md',
      'prd/zeta.md',
      'readme.md',
    ]);
    expect(result.content).not.toContain('notes.txt');
    expect(listFiles).toHaveBeenCalledWith('/vault');
  });

  it('scopes results to the subpath filter', async () => {
    listFiles.mockResolvedValue([
      dir('/vault/prd', [file('/vault/prd/a.md'), file('/vault/prd/b.md')]),
      file('/vault/readme.md'),
    ]);

    const result = await tool.execute(makeCall({ subpath: 'prd' }), ctx);

    expect(result.content.split('\n')).toEqual(['prd/a.md', 'prd/b.md']);
    expect(result.content).not.toContain('readme.md');
  });

  it('returns the empty-vault message when no markdown files exist', async () => {
    listFiles.mockResolvedValue([file('/vault/notes.txt')]);

    const result = await tool.execute(makeCall({}), ctx);

    expect(result.content).toBe('No markdown files in the vault.');
  });

  it('reports an empty subpath scope distinctly', async () => {
    listFiles.mockResolvedValue([file('/vault/readme.md')]);

    const result = await tool.execute(makeCall({ subpath: 'prd' }), ctx);

    expect(result.content).toBe('No markdown files under "prd".');
  });

  it('caps the listing at LIST_FILES_MAX and appends a truncation note', async () => {
    const many = Array.from({ length: LIST_FILES_MAX + 10 }, (_, i) =>
      // zero-pad so localeCompare ordering is stable/predictable
      file(`/vault/${String(i).padStart(4, '0')}.md`),
    );
    listFiles.mockResolvedValue(many);

    const result = await tool.execute(makeCall({}), ctx);

    const lines = result.content.split('\n');
    // LIST_FILES_MAX path lines + blank separator + note line.
    expect(lines.slice(0, LIST_FILES_MAX).every((l) => l.endsWith('.md'))).toBe(true);
    expect(result.content).toContain(
      `truncated — showing ${LIST_FILES_MAX} of ${LIST_FILES_MAX + 10} files`,
    );
  });

  it('rejects malformed JSON arguments via the guarded parse', async () => {
    const result = await tool.execute(makeCall('{ not valid json '), ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content.startsWith('Error:')).toBe(true);
    expect(result.content).toContain('JSON');
    expect(listFiles).not.toHaveBeenCalled();
  });

  it('returns an error when listing the vault fails', async () => {
    listFiles.mockRejectedValue(new Error('EACCES'));

    const result = await tool.execute(makeCall({}), ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content.startsWith('Error:')).toBe(true);
  });
});
