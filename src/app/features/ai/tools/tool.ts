import type { ToolCall, ToolDef } from '../providers/chat.provider';
import type { FileProposal } from '../ai-orchestrator.service';

/**
 * Execution context handed to every tool. Scoped to the active chat session
 * and vault so tools can never act outside the user's current workspace.
 */
export interface ToolContext {
  /** The originating chat session id (null for ad-hoc turns). */
  sessionId: number | null;
  /** Absolute path of the currently opened vault root. */
  vaultPath: string;
}

/**
 * Result of a single tool invocation.
 *
 * `content` is the string fed back to the model as the `tool`-role message.
 * `proposal`, when present, signals the orchestrator to stage a confirm-modal
 * before the tool's effect is realized — tools NEVER touch disk themselves.
 */
export interface ToolResult {
  /** The tool_call id this result answers (OpenAI ordering contract). */
  toolCallId: string;
  /** Text surfaced back to the model as the tool message content. */
  content: string;
  /** A staged file change awaiting user confirmation in the modal. */
  proposal?: FileProposal;
}

/**
 * A function-callable capability offered to the model. Implementations are
 * registered with `ToolRegistryService` and resolved by `name`.
 */
export interface Tool {
  /** Must match `schema.function.name`. */
  readonly name: string;
  /** OpenAI-style function schema advertised to the model. */
  readonly schema: ToolDef;
  /** Validate args, optionally stage a proposal, and return a tool message. */
  execute(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
}
