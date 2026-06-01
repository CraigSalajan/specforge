import { Injectable, inject } from '@angular/core';
import { IpcService } from '../../../core/ipc.service';
import type { ToolCall, ToolDef } from '../providers/chat.provider';
import { canonicalRelPath, flattenTreeToRelPaths, isSafeRelPath } from '../providers/path-utils';
import type { Tool, ToolContext, ToolResult } from './tool';

/** Maximum number of file paths returned in a single `list_files` call. */
export const LIST_FILES_MAX = 500;

interface ListFilesArgs {
  subpath?: unknown;
}

/**
 * The `list_files` tool. Lists the vault-relative paths of every markdown file
 * in the active vault so the model can discover what documents exist. An
 * optional `subpath` scopes the listing to a folder. Read-only: returns content
 * with NO `proposal`, so no confirmation modal is shown.
 */
@Injectable({ providedIn: 'root' })
export class ListFilesTool implements Tool {
  private readonly ipc = inject(IpcService);

  readonly name = 'list_files';

  readonly schema: ToolDef = {
    type: 'function',
    function: {
      name: 'list_files',
      description:
        "List the markdown files in the user's vault as vault-relative paths. Use this " +
        'to discover what documents exist when you do not know where relevant content ' +
        'lives. Optionally pass `subpath` to scope the listing to a folder. Returns up ' +
        'to 500 paths.',
      parameters: {
        type: 'object',
        properties: {
          subpath: {
            type: 'string',
            description:
              "Optional vault-relative folder to scope the listing, e.g. 'prd' or 'adr/auth'.",
          },
        },
        required: [],
        additionalProperties: false,
      },
    },
  };

  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const fail = (message: string): ToolResult => ({
      toolCallId: call.id,
      content: `Error: ${message}`,
    });

    let args: ListFilesArgs;
    try {
      args = JSON.parse(call.function.arguments || '{}') as ListFilesArgs;
    } catch {
      return fail('Could not parse tool arguments as JSON. Provide valid JSON arguments.');
    }

    // Optional folder filter; canonicalize so casing/slashes match the listing.
    let prefix: string | null = null;
    if (typeof args.subpath === 'string' && args.subpath.trim().length > 0) {
      const trimmed = args.subpath.trim();
      if (!isSafeRelPath(trimmed)) {
        return fail(`subpath "${args.subpath}" is not a valid vault-relative folder.`);
      }
      const canon = canonicalRelPath(trimmed);
      if (!canon) {
        return fail(`subpath "${args.subpath}" is not a valid vault-relative folder.`);
      }
      prefix = `${canon.toLowerCase()}/`;
    }

    let tree;
    try {
      tree = await this.ipc.listFiles(ctx.vaultPath);
    } catch {
      return fail('Could not list vault files.');
    }

    let paths = flattenTreeToRelPaths(ctx.vaultPath, tree).filter((p) =>
      p.toLowerCase().endsWith('.md'),
    );

    if (prefix) {
      paths = paths.filter((p) => p.toLowerCase().startsWith(prefix));
    }

    if (paths.length === 0) {
      return {
        toolCallId: call.id,
        content: prefix
          ? `No markdown files under "${args.subpath}".`
          : 'No markdown files in the vault.',
      };
    }

    paths.sort((a, b) => a.localeCompare(b));

    const total = paths.length;
    const truncated = total > LIST_FILES_MAX;
    const shown = truncated ? paths.slice(0, LIST_FILES_MAX) : paths;

    let content = shown.join('\n');
    if (truncated) {
      content += `\n\n…(truncated — showing ${LIST_FILES_MAX} of ${total} files. Use \`subpath\` to narrow the listing.)`;
    }

    return { toolCallId: call.id, content };
  }
}
