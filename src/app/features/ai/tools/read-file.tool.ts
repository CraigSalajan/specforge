import { Injectable, inject } from '@angular/core';
import { EditorBufferService } from '../../../core/editor-buffer.service';
import { IpcService } from '../../../core/ipc.service';
import type { ToolCall, ToolDef } from '../providers/chat.provider';
import { canonicalRelPath, isSafeRelPath, relToAbs } from '../providers/path-utils';
import type { Tool, ToolContext, ToolResult } from './tool';

/** Maximum characters returned in a single `read_file` call before truncation. */
export const READ_FILE_MAX_CHARS = 8000;

interface ReadFileArgs {
  path?: unknown;
  offset?: unknown;
}

/**
 * The `read_file` tool. Reads the full contents of a markdown file inside the
 * active vault so the model can drill into a document when an auto-injected
 * excerpt is insufficient. Read-only: it returns content with NO `proposal`,
 * so the orchestrator passes the result straight back to the model with no
 * confirmation modal. The main-process sandbox (`assertWithinVault`/markdown
 * check) is the final safety net.
 *
 * Large files are capped to {@link READ_FILE_MAX_CHARS}; the optional `offset`
 * param pages through the remainder.
 */
@Injectable({ providedIn: 'root' })
export class ReadFileTool implements Tool {
  private readonly ipc = inject(IpcService);
  private readonly editorBuffer = inject(EditorBufferService);

  readonly name = 'read_file';

  readonly schema: ToolDef = {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        "Read the full contents of a markdown file in the user's vault. Path is " +
        "relative to the vault root and must end in .md (no '..' or drive/absolute " +
        'prefixes). Returns up to 8000 characters; if the file is longer the result ' +
        'is truncated and reports the next `offset` to continue paging. Use this when ' +
        'an excerpt in VAULT CONTEXT is insufficient and you need the whole document.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: "Vault-relative path ending in .md, e.g. 'prd/feature-x.md'.",
          },
          offset: {
            type: 'integer',
            description:
              'Character offset to start reading from (default 0). Use the value reported ' +
              'in a previous truncation note to read the next page.',
            minimum: 0,
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  };

  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const fail = (message: string): ToolResult => ({
      toolCallId: call.id,
      content: `Error: ${message}`,
    });

    let args: ReadFileArgs;
    try {
      args = JSON.parse(call.function.arguments || '{}') as ReadFileArgs;
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
      return fail(`Path "${canon}" must end in .md — only markdown files can be read.`);
    }

    const offset = this.normalizeOffset(args.offset);

    const abs = relToAbs(ctx.vaultPath, canon);
    // Flush-before-read: the model must see unsaved editor buffer content.
    await this.editorBuffer.flushIfDirty(abs);

    let raw: string;
    try {
      raw = await this.ipc.readFile(abs);
    } catch {
      return fail(`File not found or unreadable: ${canon}`);
    }

    const total = raw.length;

    if (offset >= total) {
      return {
        toolCallId: call.id,
        content:
          total === 0
            ? `${canon} is empty (0 characters).`
            : `Offset ${offset} is at or past the end of ${canon} (total length ${total} characters). No more content to read.`,
      };
    }

    const slice = raw.slice(offset, offset + READ_FILE_MAX_CHARS);
    const end = offset + slice.length;
    let content = slice;

    if (end < total) {
      content +=
        `\n\n…(truncated — showing characters ${offset}–${end} of ${total}. ` +
        `Call read_file again with offset=${end} to continue.)`;
    }

    return { toolCallId: call.id, content };
  }

  /** Coerces the `offset` arg to a non-negative integer, defaulting to 0. */
  private normalizeOffset(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
    const n = Math.floor(value);
    return n > 0 ? n : 0;
  }
}
