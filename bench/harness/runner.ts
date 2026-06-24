/**
 * Headless benchmark runner for the SpecForge AI agentic loop.
 *
 * Drives the REAL `runAgenticLoop` outside Angular/Electron and exposes it over
 * a line-delimited JSON protocol on stdin/stdout so an external (e.g. Rust)
 * benchmark driver can use it as the system-under-test.
 *
 * Protocol:
 *   stdout — ONLY protocol JSON, one object per line:
 *     • startup:  {"ready":true}  | {"ready":false,"error":"<msg>"}
 *     • per turn: {"toolCalls":[…],"finalText":"…","error":null|"…",
 *                  "rounds":N,"exhaustedToolRounds":bool,"transcript":[…]}
 *   stdin  — one request per line: {"instruction":"<text>"}
 *   stderr — all diagnostics / logging.
 *
 * Requests are processed strictly sequentially (each awaited fully before the
 * next line is read), so a turn that writes a file can be read back by a later
 * turn against the same temp vault.
 */

import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

import { assembleSystemMessage, TOOL_USAGE_PROMPT } from '../../src/app/features/ai/prompts/system-context';
import { runAgenticLoop } from '../../src/app/features/ai/agentic-loop';
import type { ChatMessage, ToolCall } from '../../src/app/features/ai/providers/chat.provider';
import { NodeChatProvider } from './node-chat-provider';
import { createToolRegistry, type ToolRegistry } from './tools';

/** Resolved, validated runtime configuration from the environment. */
interface BenchConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  vaultPath: string;
  disabledTools: Set<string>;
  maxContextChars: number;
  timeoutMs: number;
}

const DEFAULT_MAX_CONTEXT_CHARS = 8000;
const DEFAULT_TIMEOUT_MS = 60_000;

/** Emit one protocol line to stdout (the ONLY thing written to stdout). */
function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/** All diagnostics go to stderr so stdout stays a clean protocol stream. */
function log(...args: unknown[]): void {
  console.error('[bench]', ...args);
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseCsvSet(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/** Reads + validates env config. Throws with a precise message on any gap. */
function loadConfig(): BenchConfig {
  const baseUrl = process.env['SPECFORGE_BENCH_BASE_URL'];
  const apiKey = process.env['SPECFORGE_BENCH_API_KEY'];
  const model = process.env['SPECFORGE_BENCH_MODEL'];

  const missing: string[] = [];
  if (!baseUrl) missing.push('SPECFORGE_BENCH_BASE_URL');
  if (!apiKey) missing.push('SPECFORGE_BENCH_API_KEY');
  if (!model) missing.push('SPECFORGE_BENCH_MODEL');
  if (missing.length > 0) {
    throw new Error(`missing required env: ${missing.join(', ')}`);
  }

  const vaultPath =
    process.env['SPECFORGE_BENCH_VAULT'] ||
    fs.mkdtempSync(path.join(os.tmpdir(), 'specforge-bench-'));
  fs.mkdirSync(vaultPath, { recursive: true });

  return {
    baseUrl: baseUrl!,
    apiKey: apiKey!,
    model: model!,
    vaultPath,
    disabledTools: parseCsvSet(process.env['SPECFORGE_BENCH_DISABLED_TOOLS']),
    maxContextChars: parsePositiveInt(
      process.env['SPECFORGE_BENCH_MAX_CONTEXT_CHARS'],
      DEFAULT_MAX_CONTEXT_CHARS,
    ),
    timeoutMs: parsePositiveInt(process.env['SPECFORGE_BENCH_TIMEOUT_MS'], DEFAULT_TIMEOUT_MS),
  };
}

function safeParseJson(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Mirrors `AiOrchestratorService.executeToolCall` (ai-orchestrator.service.ts:
 * 484–535) but AUTO-ACCEPTS write proposals instead of opening a confirm modal.
 *
 * On a proposal, it actually writes the file into the temp vault (so a later
 * turn can read it back) and returns the orchestrator's accepted-outcome text
 * `Created <relPath>.` — preserving the exact tool-message wording the model
 * sees in production on accept.
 */
function makeExecuteToolCall(config: BenchConfig, registry: ToolRegistry) {
  return async (call: ToolCall): Promise<ChatMessage> => {
    const name = call.function.name;

    // Per-tool gating guard: a disabled tool isn't advertised, but the model
    // could still hallucinate a call to one. Refuse to dispatch it.
    if (config.disabledTools.has(name)) {
      return { role: 'tool', tool_call_id: call.id, name, content: `Error: tool "${name}" is disabled.` };
    }

    const tool = registry.get(name);
    if (!tool) {
      return { role: 'tool', tool_call_id: call.id, name, content: `Error: unknown tool "${name}".` };
    }

    const result = await tool.execute(call, { sessionId: null, vaultPath: config.vaultPath });

    // Validation error (or any non-proposal result): pass content straight back.
    if (!result.proposal) {
      return { role: 'tool', tool_call_id: call.id, name, content: result.content };
    }

    // Auto-accept the staged write: realize it on disk so subsequent turns can
    // read it, then return the accepted-outcome message. Constrain the resolved
    // target to the vault root so a `../` in a model-produced relPath can't
    // escape and clobber files outside the temp vault.
    const proposal = result.proposal;
    const vaultRoot = path.resolve(config.vaultPath);
    const abs = path.resolve(vaultRoot, proposal.relPath);
    const rel = path.relative(vaultRoot, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return {
        role: 'tool',
        tool_call_id: call.id,
        name,
        content: `Error: invalid write path "${proposal.relPath}".`,
      };
    }
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, proposal.content, 'utf8');

    return {
      role: 'tool',
      tool_call_id: call.id,
      name,
      content: `Created ${proposal.relPath}.`,
    };
  };
}

/** Runs one instruction through the full agentic loop and emits one result. */
async function processInstruction(
  instruction: string,
  config: BenchConfig,
  provider: NodeChatProvider,
  registry: ToolRegistry,
): Promise<void> {
  const systemMessage = assembleSystemMessage([], {
    maxContextChars: config.maxContextChars,
    additionalInstructions: TOOL_USAGE_PROMPT,
    pinnedFiles: [],
    // Advertise the fixture skill(s) the registry exposes so the `use_skill`
    // case is winnable on a live model — the advertised name must match what
    // `use_skill` accepts, which `availableSkills()` guarantees (same source).
    availableSkills: registry.availableSkills(),
  }).systemMessage;

  const convo: ChatMessage[] = [systemMessage, { role: 'user', content: instruction }];

  const toolSchemas = registry
    .schemas()
    .filter((s) => !config.disabledTools.has(s.function.name));

  const executeToolCall = makeExecuteToolCall(config, registry);

  try {
    const result = await runAgenticLoop(convo, {
      chat: (m, o) => provider.chat(m, o),
      toolSchemas,
      executeToolCall,
      maxRounds: 8,
    });

    emit({
      toolCalls: result.toolCalls.map((c) => ({
        name: c.function.name,
        args: safeParseJson(c.function.arguments),
      })),
      finalText: result.finalText,
      error: result.exhaustedToolRounds
        ? 'stopped after max tool rounds without a final answer'
        : null,
      rounds: result.rounds,
      exhaustedToolRounds: result.exhaustedToolRounds,
      // Completion tokens summed across the case's model turns (eval-core's
      // `RunArtifacts.tokens`); undefined when the backend reported no `usage`.
      tokens: result.usage?.completionTokens,
      // `runAgenticLoop` mutated `convo` in place, so it now holds the full
      // conversation. Drop the leading system message (constant across cases)
      // and ship the rest as the per-case transcript for eval-core's report.
      transcript: convo.slice(1),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('instruction failed:', message);
    // Emit whatever conversation accumulated before the failure (minus the
    // system message): a partial transcript is more useful than none.
    emit({
      toolCalls: [],
      finalText: '',
      error: message,
      rounds: 0,
      exhaustedToolRounds: false,
      transcript: convo.slice(1),
    });
  }
}

async function main(): Promise<void> {
  let config: BenchConfig;
  try {
    config = loadConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ ready: false, error: message });
    process.exit(1);
    return;
  }

  log(`vault: ${config.vaultPath}`);
  log(`model: ${config.model} @ ${config.baseUrl}`);
  if (config.disabledTools.size > 0) {
    log(`disabled tools: ${[...config.disabledTools].join(', ')}`);
  }

  const provider = new NodeChatProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    timeoutMs: config.timeoutMs,
  });

  let registry: ToolRegistry;
  try {
    registry = createToolRegistry(config.vaultPath);
    const advertised = registry.schemas().map((s) => s.function.name);
    log(`tools advertised: ${advertised.join(', ')}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ ready: false, error: `tool registry init failed: ${message}` });
    process.exit(1);
    return;
  }

  emit({ ready: true });

  // Process stdin line-by-line, strictly sequentially. `readline` buffers
  // incoming lines while we await the current instruction, so ordering holds.
  const rl = readline.createInterface({ input: process.stdin });

  // Serialize processing: chain each line onto the previous promise so a fast
  // producer can't interleave turns against the shared vault.
  let chain: Promise<void> = Promise.resolve();
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    chain = chain.then(async () => {
      let parsed: { instruction?: unknown };
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        log('skipping unparseable line');
        emit({ toolCalls: [], finalText: '', error: 'invalid JSON request line', rounds: 0, exhaustedToolRounds: false });
        return;
      }

      if (typeof parsed.instruction !== 'string') {
        emit({ toolCalls: [], finalText: '', error: 'request missing string "instruction"', rounds: 0, exhaustedToolRounds: false });
        return;
      }

      await processInstruction(parsed.instruction, config, provider, registry);
    });
  });

  rl.on('close', () => {
    // Drain the in-flight chain, then exit cleanly. Set exitCode and let the
    // event loop unwind on its own rather than calling process.exit() while
    // stdin/readline handles are still closing — on Windows a forced exit
    // mid-teardown trips a libuv assertion (UV_HANDLE_CLOSING).
    void chain.finally(() => {
      process.exitCode = 0;
      // Detach stdin so no lingering read handle keeps the loop alive.
      process.stdin.pause();
    });
  });
}

void main();
