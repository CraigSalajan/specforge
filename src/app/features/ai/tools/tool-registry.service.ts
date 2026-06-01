import { Injectable, inject } from '@angular/core';
import type { ToolDef } from '../providers/chat.provider';
import { ListFilesTool } from './list-files.tool';
import { ReadFileTool } from './read-file.tool';
import { SearchVaultTool } from './search-vault.tool';
import type { Tool } from './tool';
import { UseSkillTool } from './use-skill.tool';
import { WriteFileTool } from './write-file.tool';

/**
 * Central registry of function-calling tools available to the AI harness.
 *
 * This is the reusable seam for future tools: register a `Tool` here and it is
 * automatically advertised to the model (`schemas()`) and dispatchable by name
 * (`get()`). The orchestrator owns the round-trip; tools own validation and
 * proposal staging.
 */
@Injectable({ providedIn: 'root' })
export class ToolRegistryService {
  private readonly tools = new Map<string, Tool>();

  constructor() {
    this.register(inject(WriteFileTool));
    this.register(inject(ReadFileTool));
    this.register(inject(ListFilesTool));
    this.register(inject(SearchVaultTool));
    this.register(inject(UseSkillTool));
  }

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Every registered tool, in registration order. */
  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** OpenAI-style tool schemas for every registered tool. */
  schemas(): ToolDef[] {
    return [...this.tools.values()].map((t) => t.schema);
  }
}
