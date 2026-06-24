/**
 * Builds the REAL production tool registry for the headless harness, so the
 * model is advertised the exact production tool schemas and the real tool
 * validation/execution code path runs.
 *
 * Fidelity approach (the preferred one, and the one this file uses):
 *   We construct a genuine `ToolRegistryService` via `@angular/core`'s
 *   `Injector.create({ providers })`. The five tool classes use `inject()` and
 *   `@Injectable()`; `Injector.create` establishes a real injection context
 *   during construction, so `inject(IpcService)` etc. resolve against the
 *   Node-backed shims we provide. This pulls ZERO DOM/zone.js: `@angular/core`'s
 *   DI subsystem is environment-agnostic, and none of the five tools (or their
 *   shimmed deps) touch `document`/`window` at construction time. Verified by
 *   bundling + running under plain Node (see bench/harness/verify output).
 *
 * The Node-backed shims implement ONLY the methods the tools actually call:
 *   - IpcService.readFile / listFiles            (fs-backed)
 *   - IpcService.skillsReadBody                  (returns a fixture skill body)
 *   - IpcService.skillsReadResource              (stubbed — no case reads resources)
 *   - EditorBufferService.flushIfDirty           (no-op: no editor buffer here)
 *   - RetrievalService.retrieve                  (empty: no vault index here)
 *   - SkillRegistryService.enabled / find        (advertises ONE fixture skill)
 *
 * SKILLS: exactly ONE neutral fixture skill ("mermaid-diagrams") is advertised so
 * the `use_skill` tool is benchmarkable end-to-end. Its name is deliberately
 * unrelated to PRD/ADR work so no other case spuriously invokes it. This mirrors
 * production, where the registry advertises the user's enabled skills.
 *
 * NOTE: `IpcService.listFiles` must return a `FileNode[]` tree shaped exactly as
 * `flattenTreeToRelPaths` expects (`{ path, isDirectory, children? }` with
 * ABSOLUTE `path`s relativized against the vault root). We back it with a
 * recursive fs scan that produces precisely that shape.
 */

import 'reflect-metadata';
// Enables Angular's JIT compiler so `@Injectable()` tool classes compile from
// their emitted decorator metadata at runtime. Without the Angular AOT compiler
// (esbuild does not run it) the classes have no `ɵprov`/`ɵfac`, so DI throws
// "needs to be compiled using the JIT compiler" unless `@angular/compiler` is
// loaded BEFORE any class is resolved. Must precede the `@angular/core` import.
import '@angular/compiler';
import { Injector } from '@angular/core';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { SkillMeta } from '../../src/app/shared/types';
import type { ToolDef } from '../../src/app/features/ai/providers/chat.provider';
import type { Tool } from '../../src/app/features/ai/tools/tool';
import { ToolRegistryService } from '../../src/app/features/ai/tools/tool-registry.service';
import { WriteFileTool } from '../../src/app/features/ai/tools/write-file.tool';
import { ReadFileTool } from '../../src/app/features/ai/tools/read-file.tool';
import { ListFilesTool } from '../../src/app/features/ai/tools/list-files.tool';
import { SearchVaultTool } from '../../src/app/features/ai/tools/search-vault.tool';
import { UseSkillTool } from '../../src/app/features/ai/tools/use-skill.tool';
import { IpcService } from '../../src/app/core/ipc.service';
import { EditorBufferService } from '../../src/app/core/editor-buffer.service';
import { RetrievalService } from '../../src/app/features/ai/providers/retrieval.service';
import { SkillRegistryService } from '../../src/app/features/ai/skills/skill-registry.service';

/** Mirror of `shared/types.ts` `FileNode`, the tree shape the tools expect. */
interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
}

/**
 * The single neutral fixture skill the harness advertises so `use_skill` is
 * exercisable. Its `name` is intentionally unrelated to PRD/ADR so it is never
 * spuriously invoked by the other (document-authoring) cases.
 */
const FIXTURE_SKILL: SkillMeta = {
  name: 'mermaid-diagrams',
  description: 'Render a Mermaid diagram code block from a short textual spec.',
  origin: 'global',
  dir: '(benchmark fixture)',
  resources: [],
};

export interface ToolRegistry {
  /** OpenAI-style tool schemas for every registered tool, registration order. */
  schemas(): ToolDef[];
  /** Resolve a tool by name (the exact production registry semantics). */
  get(name: string): Tool | undefined;
  /**
   * The skills advertised to the model — the same list `use_skill` accepts.
   * The runner feeds these into `assembleSystemMessage`'s `availableSkills` so
   * the advertised skill name stays consistent with what `use_skill` resolves.
   */
  availableSkills(): SkillMeta[];
}

/**
 * Recursively scans `dir` into a `FileNode[]` tree with ABSOLUTE `path`s, the
 * exact shape `flattenTreeToRelPaths` walks. Hidden entries (dot-prefixed) are
 * skipped to match the vault watcher's defaults closely enough for listing.
 */
async function scanTree(dir: string): Promise<FileNode[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: FileNode[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: abs,
        isDirectory: true,
        children: await scanTree(abs),
      });
    } else if (entry.isFile()) {
      nodes.push({ name: entry.name, path: abs, isDirectory: false });
    }
  }
  return nodes;
}

/** Node-backed `IpcService` shim: only the methods the tools invoke. */
function createIpcShim(vaultPath: string): Partial<IpcService> {
  return {
    async readFile(absPath: string): Promise<string> {
      return fs.readFile(absPath, 'utf8');
    },
    async listFiles(root: string): Promise<FileNode[]> {
      return scanTree(root || vaultPath);
    },
    // The fixture skill's body, returned when `use_skill` loads instructions.
    // The content is neutral and self-describing so the case's follow-up answer
    // can summarize what the skill is for.
    async skillsReadBody(): Promise<string> {
      return '# Mermaid Diagrams\n\nDescribe the diagram in words and emit a fenced ```mermaid code block.';
    },
    // No case reads a bundled resource; return empty (non-throwing) for safety.
    async skillsReadResource(): Promise<string> {
      return '';
    },
  } as Partial<IpcService>;
}

/**
 * Constructs a real {@link ToolRegistryService} wired to Node-backed shims and
 * returns the narrow {@link ToolRegistry} surface the runner needs.
 */
export function createToolRegistry(vaultPath: string): ToolRegistry {
  // One fixture skill registry shim, shared as both the DI value `use_skill`
  // resolves against AND the source the runner advertises via `availableSkills`.
  // Typed by the narrow surface the tools + runner actually call (`enabled()` /
  // `find()`), not the full `SkillRegistryService` whose `enabled` is a branded
  // `Signal`. Both call sites only invoke these as plain functions.
  const skillRegistry = {
    enabled: (): SkillMeta[] => [FIXTURE_SKILL],
    find: (n: string): SkillMeta | undefined =>
      n === FIXTURE_SKILL.name ? FIXTURE_SKILL : undefined,
  };

  const injector = Injector.create({
    providers: [
      // Real tool classes + the registry: resolved with full DI fidelity.
      WriteFileTool,
      ReadFileTool,
      ListFilesTool,
      SearchVaultTool,
      UseSkillTool,
      ToolRegistryService,
      // Node-backed dependency shims (only the called methods are implemented).
      { provide: IpcService, useValue: createIpcShim(vaultPath) },
      { provide: EditorBufferService, useValue: { flushIfDirty: async () => {} } },
      { provide: RetrievalService, useValue: { retrieve: async () => [] } },
      {
        provide: SkillRegistryService,
        useValue: skillRegistry,
      },
    ],
  });

  const registry = injector.get(ToolRegistryService);
  return {
    schemas: () => registry.schemas(),
    get: (name: string) => registry.get(name),
    // Single source of truth: the same `enabled()` list `use_skill` resolves
    // against, so the names the model is advertised always match what it accepts.
    availableSkills: () => skillRegistry.enabled(),
  };
}
