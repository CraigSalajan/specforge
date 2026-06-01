import { Injectable } from '@angular/core';
import type { ToolCall, ToolDef } from '../providers/chat.provider';
import { canonicalRelPath, isSafeRelPath } from '../providers/path-utils';
import type { Tool, ToolContext, ToolResult } from './tool';

/** Sentinel content returned while the write awaits user confirmation. */
export const PENDING_CONFIRMATION = 'PENDING_CONFIRMATION';

interface WriteFileArgs {
  path?: unknown;
  title?: unknown;
  content?: unknown;
}

/**
 * The `write_file` tool. Creates a new markdown file inside the active vault,
 * gated by the existing confirm modal. The tool itself performs no disk I/O:
 * it validates arguments and returns a `FileProposal` for the orchestrator to
 * stage. The main-process sandbox (`assertWithinVault`/`assertMarkdown`) is the
 * final safety net regardless of what the model asks for.
 */
@Injectable({ providedIn: 'root' })
export class WriteFileTool implements Tool {
  readonly name = 'write_file';

  readonly schema: ToolDef = {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        "Create a new markdown file in the user's vault. Path is relative to the vault " +
        "root, must end in .md, no '..' or drive/absolute prefixes. The user confirms " +
        "every write, so don't ask permission in chat — just call the tool.",
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              "Vault-relative path ending in .md, e.g. 'prd/feature-x.md'. Folders created as needed.",
          },
          title: {
            type: 'string',
            description: 'Short human-readable document title.',
          },
          content: {
            type: 'string',
            description: 'Complete markdown content of the new file.',
          },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  };

  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const fail = (message: string): ToolResult => ({
      toolCallId: call.id,
      content: `Error: ${message}`,
    });

    let args: WriteFileArgs;
    try {
      args = JSON.parse(call.function.arguments || '{}') as WriteFileArgs;
    } catch {
      return fail('Could not parse tool arguments as JSON. Provide valid JSON arguments.');
    }

    if (typeof args.path !== 'string' || args.path.trim().length === 0) {
      return fail('`path` is required and must be a non-empty string.');
    }
    const rawPath = args.path.trim();

    if (!isSafeRelPath(rawPath)) {
      return fail(
        `Path "${rawPath}" is not allowed. Use a vault-relative path with no '..', leading slash, or drive letter.`,
      );
    }

    const canon = canonicalRelPath(rawPath);
    if (!canon) {
      return fail(`Path "${rawPath}" could not be normalized to a safe vault-relative path.`);
    }

    if (!canon.toLowerCase().endsWith('.md')) {
      return fail(`Path "${canon}" must end in .md — only markdown files can be created.`);
    }

    if (typeof args.content !== 'string' || args.content.trim().length === 0) {
      return fail('`content` is required and must be the complete, non-empty markdown of the file.');
    }

    const title =
      typeof args.title === 'string' && args.title.trim().length > 0
        ? args.title.trim()
        : canon;

    return {
      toolCallId: call.id,
      content: PENDING_CONFIRMATION,
      proposal: {
        relPath: canon,
        changeType: 'create',
        title,
        content: args.content,
        sessionId: ctx.sessionId,
      },
    };
  }
}
