import { Injectable, inject } from '@angular/core';
import type { ToolCall, ToolDef } from '../providers/chat.provider';
import { RetrievalService } from '../providers/retrieval.service';
import type { Tool, ToolContext, ToolResult } from './tool';

/** Default number of hits returned when `limit` is omitted. */
export const SEARCH_VAULT_DEFAULT_LIMIT = 6;
/** Hard ceiling on the number of hits a single search may return. */
export const SEARCH_VAULT_MAX_LIMIT = 20;
/** Maximum total characters of formatted output before truncation. */
export const SEARCH_VAULT_MAX_CHARS = 8000;

interface SearchVaultArgs {
  query?: unknown;
  limit?: unknown;
}

/**
 * The `search_vault` tool. Runs the same keyword+vector RRF retrieval used by
 * the auto-injected VAULT CONTEXT block, so results are familiar to the model.
 * Each hit is formatted exactly like a VAULT CONTEXT entry
 * (`[relPath :: headingPath]` header + excerpt). Read-only: returns content
 * with NO `proposal`, so no confirmation modal is shown.
 */
@Injectable({ providedIn: 'root' })
export class SearchVaultTool implements Tool {
  private readonly retrieval = inject(RetrievalService);

  readonly name = 'search_vault';

  readonly schema: ToolDef = {
    type: 'function',
    function: {
      name: 'search_vault',
      description:
        "Search the user's vault for content relevant to a query, returning ranked " +
        'excerpts with their source paths and headings. Use this to find relevant ' +
        'content when you do not already have it in VAULT CONTEXT and do not know which ' +
        'file it lives in. Each result is formatted as [path :: heading] followed by an ' +
        'excerpt.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural-language or keyword query describing what to find.',
          },
          limit: {
            type: 'integer',
            description: 'Maximum number of results (default 6, clamped to 1–20).',
            minimum: 1,
            maximum: SEARCH_VAULT_MAX_LIMIT,
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  };

  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const fail = (message: string): ToolResult => ({
      toolCallId: call.id,
      content: `Error: ${message}`,
    });

    let args: SearchVaultArgs;
    try {
      args = JSON.parse(call.function.arguments || '{}') as SearchVaultArgs;
    } catch {
      return fail('Could not parse tool arguments as JSON. Provide valid JSON arguments.');
    }

    if (typeof args.query !== 'string' || args.query.trim().length === 0) {
      return fail('`query` is required and must be a non-empty string.');
    }
    const query = args.query.trim();
    const limit = this.normalizeLimit(args.limit);

    let hits;
    try {
      hits = await this.retrieval.retrieve(query, ctx.vaultPath, limit);
    } catch {
      return fail('Vault search failed.');
    }

    if (hits.length === 0) {
      return { toolCallId: call.id, content: 'No matches.' };
    }

    const blocks: string[] = [];
    let used = 0;
    for (const hit of hits) {
      const block = `---\n[${hit.relPath} :: ${hit.headingPath || '(file)'}]\n${hit.excerpt}`;
      if (used + block.length > SEARCH_VAULT_MAX_CHARS && blocks.length > 0) break;
      blocks.push(block);
      used += block.length;
    }

    return { toolCallId: call.id, content: blocks.join('\n') };
  }

  /** Coerces the `limit` arg to an integer clamped to 1..SEARCH_VAULT_MAX_LIMIT. */
  private normalizeLimit(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return SEARCH_VAULT_DEFAULT_LIMIT;
    }
    const n = Math.floor(value);
    return Math.max(1, Math.min(n, SEARCH_VAULT_MAX_LIMIT));
  }
}
