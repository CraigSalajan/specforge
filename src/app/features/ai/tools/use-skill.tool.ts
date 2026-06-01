import { Injectable, inject } from '@angular/core';
import { IpcService } from '../../../core/ipc.service';
import { SkillRegistryService } from '../skills/skill-registry.service';
import type { ToolCall, ToolDef } from '../providers/chat.provider';
import type { Tool, ToolContext, ToolResult } from './tool';

interface UseSkillArgs {
  name?: unknown;
  resource?: unknown;
}

/**
 * The `use_skill` tool. Loads a specialized skill's full instructions (or one
 * of its bundled resource files) on demand, so the system prompt only ever
 * advertises lightweight skill metadata. Read-only: it returns content with NO
 * `proposal`, so the orchestrator feeds the result straight back to the model
 * with no confirmation modal. Skill resolution is enabled-only — a disabled or
 * unknown skill yields a clear (non-throwing) tool message.
 */
@Injectable({ providedIn: 'root' })
export class UseSkillTool implements Tool {
  private readonly ipc = inject(IpcService);
  private readonly skills = inject(SkillRegistryService);

  readonly name = 'use_skill';

  readonly schema: ToolDef = {
    type: 'function',
    function: {
      name: 'use_skill',
      description:
        "Load a specialized skill's full instructions on demand. Call this BEFORE " +
        'doing a task that matches a skill listed under AVAILABLE SKILLS, so you ' +
        'follow its exact guidance. Pass only `name` to read the skill body; pass ' +
        '`resource` as well to read one of the skill\'s bundled resource files ' +
        'instead. Read-only and runs immediately with no confirmation.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The skill name exactly as shown in the AVAILABLE SKILLS list.',
          },
          resource: {
            type: 'string',
            description:
              "Optional. A bundled resource's relative path (as listed in the skill " +
              'body) to read instead of the skill instructions.',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  };

  async execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const result = (content: string): ToolResult => ({ toolCallId: call.id, content });

    let args: UseSkillArgs;
    try {
      args = JSON.parse(call.function.arguments || '{}') as UseSkillArgs;
    } catch {
      return result('Error: could not parse tool arguments as JSON. Provide valid JSON arguments.');
    }

    if (typeof args.name !== 'string' || args.name.trim().length === 0) {
      return result('Error: `name` is required and must be a non-empty string.');
    }
    const skillName = args.name.trim();

    const skill = this.skills.find(skillName);
    if (!skill) {
      return result(`Skill "${skillName}" is not available or is disabled.`);
    }

    const resource =
      typeof args.resource === 'string' && args.resource.trim().length > 0
        ? args.resource.trim()
        : null;

    if (resource) {
      try {
        const text = await this.ipc.skillsReadResource(
          skill.origin,
          skill.name,
          resource,
          ctx.vaultPath || undefined,
        );
        return result(`Resource "${resource}" from skill "${skill.name}":\n\n${text}`);
      } catch {
        return result(
          `Error: could not read resource "${resource}" from skill "${skill.name}".`,
        );
      }
    }

    try {
      const body = await this.ipc.skillsReadBody(
        skill.origin,
        skill.name,
        ctx.vaultPath || undefined,
      );
      let content = body;
      if (skill.resources.length > 0) {
        content +=
          `\n\nBundled resources you can load with use_skill({ name: "${skill.name}", ` +
          `resource: "<path>" }): ${skill.resources.join(', ')}`;
      }
      return result(content);
    } catch {
      return result(`Error: could not load instructions for skill "${skill.name}".`);
    }
  }
}
