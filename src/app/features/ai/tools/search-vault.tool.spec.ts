import { vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import type { ToolCall } from '../providers/chat.provider';
import type { IndexSearchHit } from '../../../shared/types';
import { RetrievalService } from '../providers/retrieval.service';
import type { ToolContext } from './tool';
import {
  SEARCH_VAULT_DEFAULT_LIMIT,
  SEARCH_VAULT_MAX_LIMIT,
  SearchVaultTool,
} from './search-vault.tool';

/**
 * Builds a `search_vault` tool call whose `function.arguments` is the
 * JSON-encoded form of `args`. Pass a raw string to exercise the malformed-JSON
 * guard.
 */
function makeCall(args: unknown, id = 'call_1'): ToolCall {
  return {
    id,
    type: 'function',
    function: {
      name: 'search_vault',
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  };
}

function hit(partial: Partial<IndexSearchHit>): IndexSearchHit {
  return {
    relPath: 'prd/x.md',
    headingPath: 'Overview',
    excerpt: 'excerpt text',
    score: 1,
    ...partial,
  };
}

describe('SearchVaultTool.execute', () => {
  let tool: SearchVaultTool;
  let retrieve: ReturnType<typeof vi.fn>;
  const ctx: ToolContext = { sessionId: 42, vaultPath: '/vault' };

  beforeEach(() => {
    retrieve = vi.fn();
    TestBed.configureTestingModule({
      providers: [{ provide: RetrievalService, useValue: { retrieve } }],
    });
    tool = TestBed.inject(SearchVaultTool);
  });

  it('formats hits as [relPath :: heading] blocks separated by ---', async () => {
    retrieve.mockResolvedValue([
      hit({ relPath: 'prd/a.md', headingPath: 'Goals', excerpt: 'goal body' }),
      hit({ relPath: 'adr/b.md', headingPath: 'Decision', excerpt: 'decision body' }),
    ]);

    const result = await tool.execute(makeCall({ query: 'auth' }), ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content.startsWith('Error:')).toBe(false);
    expect(result.content).toBe(
      '---\n[prd/a.md :: Goals]\ngoal body\n---\n[adr/b.md :: Decision]\ndecision body',
    );
    expect(retrieve).toHaveBeenCalledWith('auth', '/vault', SEARCH_VAULT_DEFAULT_LIMIT);
  });

  it('uses the (file) placeholder when the heading path is empty', async () => {
    retrieve.mockResolvedValue([hit({ relPath: 'notes/c.md', headingPath: '', excerpt: 'body' })]);

    const result = await tool.execute(makeCall({ query: 'x' }), ctx);

    expect(result.content).toBe('---\n[notes/c.md :: (file)]\nbody');
  });

  it('returns "No matches." when retrieval yields no hits', async () => {
    retrieve.mockResolvedValue([]);

    const result = await tool.execute(makeCall({ query: 'nothing here' }), ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content).toBe('No matches.');
  });

  it('clamps a limit above the ceiling and passes it to retrieve', async () => {
    retrieve.mockResolvedValue([]);

    await tool.execute(makeCall({ query: 'q', limit: 999 }), ctx);

    expect(retrieve).toHaveBeenCalledWith('q', '/vault', SEARCH_VAULT_MAX_LIMIT);
  });

  it('clamps a limit below 1 up to 1', async () => {
    retrieve.mockResolvedValue([]);

    await tool.execute(makeCall({ query: 'q', limit: 0 }), ctx);

    expect(retrieve).toHaveBeenCalledWith('q', '/vault', 1);
  });

  it('honors an in-range limit', async () => {
    retrieve.mockResolvedValue([]);

    await tool.execute(makeCall({ query: 'q', limit: 3 }), ctx);

    expect(retrieve).toHaveBeenCalledWith('q', '/vault', 3);
  });

  it('rejects a missing query with an error and never calls retrieve', async () => {
    const result = await tool.execute(makeCall({}), ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content.startsWith('Error:')).toBe(true);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('rejects a blank query', async () => {
    const result = await tool.execute(makeCall({ query: '   ' }), ctx);

    expect(result.content.startsWith('Error:')).toBe(true);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('returns an error when retrieval throws', async () => {
    retrieve.mockRejectedValue(new Error('boom'));

    const result = await tool.execute(makeCall({ query: 'q' }), ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content.startsWith('Error:')).toBe(true);
  });

  it('rejects malformed JSON arguments via the guarded parse', async () => {
    const result = await tool.execute(makeCall('{ not valid json '), ctx);

    expect(result.proposal).toBeUndefined();
    expect(result.content.startsWith('Error:')).toBe(true);
    expect(result.content).toContain('JSON');
    expect(retrieve).not.toHaveBeenCalled();
  });
});
