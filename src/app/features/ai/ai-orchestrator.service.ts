import { Injectable, inject, signal } from '@angular/core';
import type { AiErrorInfo, ContextScope } from '../../shared/types';
import { EditorBufferService } from '../../core/editor-buffer.service';
import { EditorSelectionService, resolveActiveSelection } from '../../core/editor-selection.service';
import { IpcService } from '../../core/ipc.service';
import { SettingsService } from '../../core/settings.service';
import { VaultService } from '../../core/vault.service';
import { AiProviderService } from './providers/ai-provider.service';
import { toAiErrorInfo } from './providers/ai-harness-error';
import { RetrievalService } from './providers/retrieval.service';
import { ChatService, type UiChatMessage } from './chat.service';
import {
  assembleSystemMessage,
  selectionRangeLabel,
  TOOL_USAGE_PROMPT,
  type PinnedFile,
  type SelectionContext,
} from './prompts/system-context';
import { findCommand, type PlanningCommandId } from './prompts';
import type { ChatMessage, ToolCall } from './providers/chat.provider';
import { runAgenticLoop } from './agentic-loop';
// THE single inline-`<think>` parser, shared with the loop and the IPC layer.
import { splitThinkTags } from '../../../../electron/ipc/think-tag-parser';
import { absToRel, canonicalRelPath, relToAbs, sanitizeFilename } from './providers/path-utils';
import { toVaultRel } from '../../shared/vault-paths';
import { FileChangeService } from './file-change.service';
import { ToolRegistryService } from './tools/tool-registry.service';
import { SkillRegistryService } from './skills/skill-registry.service';
import { SyncService } from '../../core/sync.service';
import { UiStateService } from '../../core/ui-state.service';
import {
  buildProposedContent,
  type ProposedStory,
} from '../../../../electron/sync/story-doc-builder';
import { buildTaskItemsFromContent } from '../../../../electron/sync/task-items';
import { parseMarkedHeadings } from '../../../../electron/sync/story-markers';
import { DECOMPOSE_STORIES_PROMPT } from './prompts/decompose-stories.prompt';

/**
 * System instruction appended when the renderer infers an edit-intent turn.
 * The provider only supports JSON-object mode (no tool-calling), so we ask for
 * a single JSON object whose `content` is the full revised markdown.
 */
const EDIT_SYSTEM_PROMPT = `The user is asking you to edit the PINNED FILE shown above.
Return a single JSON object of the exact shape { "content": "<full revised markdown>" }.
The "content" value MUST be the complete, updated markdown for the file — not a diff,
not a snippet, and not commentary. Preserve everything the user did not ask to change.`;

/**
 * Edit-mode instruction when the user has text selected in the editor: the
 * change is scoped to the selected range, but the proposal pipeline still
 * needs the complete revised file.
 */
function editSelectionSystemPrompt(selection: SelectionContext): string {
  const range = selectionRangeLabel(selection.startLine, selection.endLine);
  return `The user is asking you to edit the PINNED FILE shown above, focused on its SELECTION block (${range}).
Modify ONLY the selected range; preserve everything outside it verbatim.
Return a single JSON object of the exact shape { "content": "<full revised markdown>" }.
The "content" value MUST be the complete, updated markdown for the WHOLE file — not a diff,
not a snippet, and not just the revised selection.`;
}

/**
 * System instruction for Ask-mode turns. Keeps the model in explain/answer mode
 * so a question about the pinned file is never turned into a silent rewrite.
 */
const ASK_SYSTEM_PROMPT = `The user is ASKING a question or requesting an explanation — they are NOT asking you to edit any file.
Answer directly in chat. Do not rewrite, restructure, or output a full revised version of any file.
If you think changes would help, describe them briefly inline and note the user can switch to Edit mode to apply them.`;

/**
 * Imperative editing verbs that, when they appear in the opening words of a
 * message, signal the user wants to modify the active file rather than chat.
 */
const EDIT_VERBS = new Set([
  'edit', 'rewrite', 'update', 'revise', 'change', 'fix', 'add', 'remove',
  'reword', 'tighten', 'expand', 'shorten', 'refactor', 'rename', 'append',
  'insert', 'replace', 'delete', 'reorder', 'clarify', 'simplify', 'polish',
  'restructure',
]);

const THIS_FILE_REFERENCE = /\bthis\s+(file|doc|document|section|page)\b/i;

/** Per-turn composer mode chosen by the user. Ask = answer in chat; Edit = propose a file change. */
export type ComposerMode = 'ask' | 'edit';

/** True when the message reads as a request to edit the active file. */
export function isEditIntent(message: string): boolean {
  const text = message.trim();
  if (text.length === 0) return false;
  if (THIS_FILE_REFERENCE.test(text)) return true;
  const firstWords = text
    .toLowerCase()
    .split(/[\s,.!?:;]+/)
    .filter((w) => w.length > 0)
    .slice(0, 6);
  return firstWords.some((w) => EDIT_VERBS.has(w));
}

export interface FileProposal {
  /** A normalized vault-relative path like "prd/feature-x.md". */
  relPath: string;
  /** "create" by default; the proposal modal may flip to "edit". */
  changeType: 'create' | 'edit';
  title: string;
  content: string;
  /** The originating chat session (null for ad-hoc / unauthenticated). */
  sessionId: number | null;
}

interface CommandResponseJson {
  filename?: string;
  folder?: string;
  title?: string;
  content?: string;
}

/** Outcome of a staged proposal once the user resolves the confirm modal. */
export type ProposalOutcome =
  | { applied: true; relPath: string; absPath: string | null }
  | { applied: false };

/** Upper bound on agentic tool rounds per Ask-mode turn (loop safety). */
const MAX_TOOL_ROUNDS = 8;

/** Max selection chars folded into the retrieval query (see composeRetrievalQuery). */
const RETRIEVAL_SELECTION_CAP = 500;

/** Inputs of a `run()` turn, retained so a failed turn can be retried. */
interface RunTurnOptions {
  userContent: string;
  scope: ContextScope;
  /** Editor selection captured at turn start, replayed verbatim on Retry. */
  selection: SelectionContext | null;
  additionalInstructions: string | null;
  expectsFileProposal: boolean;
  /** When set, the resulting proposal is forced to edit this rel-path. */
  forcedEditRelPath: string | null;
  defaultFolder: string | null;
  defaultTitle: string;
}

/**
 * Snapshot of the last failed turn's inputs. `retryLastFailed()` re-runs it
 * without re-appending or re-persisting the user message, reusing the failed
 * assistant bubble. Scoped to a session so a retry can never graft a turn
 * onto a different conversation.
 */
type FailedTurn =
  | {
      kind: 'tools';
      sessionId: number;
      userContent: string;
      scope: ContextScope;
      selection: SelectionContext | null;
    }
  | { kind: 'run'; sessionId: number; opts: RunTurnOptions };

/**
 * Orchestrates a single chat turn: retrieves context, composes the system
 * prompt, streams the assistant response, and (for planning commands)
 * extracts a structured file proposal at the end.
 *
 * The orchestrator owns the AbortController for the active stream so the
 * UI can wire a Stop button without leaking it into the chat service.
 */
@Injectable({ providedIn: 'root' })
export class AiOrchestratorService {
  private readonly ipc = inject(IpcService);
  private readonly editorBuffer = inject(EditorBufferService);
  private readonly editorSelection = inject(EditorSelectionService);
  private readonly settings = inject(SettingsService);
  private readonly vault = inject(VaultService);
  private readonly providers = inject(AiProviderService);
  private readonly retrieval = inject(RetrievalService);
  private readonly chat = inject(ChatService);
  private readonly fileChange = inject(FileChangeService);
  private readonly tools = inject(ToolRegistryService);
  private readonly skillRegistry = inject(SkillRegistryService);
  private readonly sync = inject(SyncService);
  private readonly ui = inject(UiStateService);

  private readonly _pendingProposal = signal<FileProposal | null>(null);
  readonly pendingProposal = this._pendingProposal.asReadonly();

  /** True when a failed turn is retained and can be re-run via Retry. */
  private readonly _retryAvailable = signal(false);
  readonly retryAvailable = this._retryAvailable.asReadonly();

  /** Inputs of the last failed turn, retained for {@link retryLastFailed}. */
  private lastFailedTurn: FailedTurn | null = null;

  /** Resolver for the in-flight proposal promise, settled by the modal. */
  private pendingResolver: ((outcome: ProposalOutcome) => void) | null = null;

  private abortController: AbortController | null = null;

  /**
   * Stages a proposal in the confirm modal and resolves once the user applies
   * or cancels it. Used by the tool loop so an Ask-mode turn can await user
   * confirmation before continuing the round-trip.
   */
  proposeAndAwait(proposal: FileProposal): Promise<ProposalOutcome> {
    // Settle any prior in-flight proposal as not-applied before replacing it,
    // so a stale resolver can never linger.
    this.settlePending({ applied: false });
    this._pendingProposal.set(proposal);
    return new Promise<ProposalOutcome>((resolve) => {
      this.pendingResolver = resolve;
    });
  }

  /** Called by the modal on apply/cancel to clear and settle the proposal. */
  resolveProposal(outcome: ProposalOutcome): void {
    this._pendingProposal.set(null);
    this.settlePending(outcome);
  }

  private settlePending(outcome: ProposalOutcome): void {
    const resolver = this.pendingResolver;
    this.pendingResolver = null;
    if (resolver) resolver(outcome);
  }

  clearPendingProposal(): void {
    this._pendingProposal.set(null);
    // A dismissed proposal must never leave the tool loop hanging.
    this.settlePending({ applied: false });
  }

  stop(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    // An aborted turn with the modal still open must both close the modal and
    // release the awaiting loop — otherwise a stale proposal dialog lingers on
    // screen after Stop while the loop unwinds.
    this._pendingProposal.set(null);
    this.settlePending({ applied: false });
  }

  /**
   * Re-runs the last failed turn with its original inputs. The user message
   * is neither re-appended nor re-persisted; the failed assistant bubble is
   * reset to a fresh streaming state and reused.
   */
  async retryLastFailed(): Promise<void> {
    const turn = this.lastFailedTurn;
    if (!turn || this.chat.streaming()) return;
    const session = this.chat.activeSession();
    if (!session || session.id !== turn.sessionId) {
      // The failed turn belongs to a closed or different session; retrying
      // here would graft its inputs onto the wrong conversation.
      this.lastFailedTurn = null;
      this._retryAvailable.set(false);
      return;
    }
    if (turn.kind === 'tools') {
      await this.runWithTools({
        userContent: turn.userContent,
        scope: turn.scope,
        selection: turn.selection,
        retry: true,
      });
    } else {
      await this.run({ ...turn.opts, retry: true });
    }
  }

  /**
   * Sends a free-form user message. Context is driven by the session's
   * additive scope (not its vestigial `mode`). When the active file is in
   * scope and the message reads as an edit request, this runs an edit turn
   * that produces a file proposal targeting the active file; otherwise it
   * streams a normal answer.
   */
  async sendUserMessage(content: string, mode: ComposerMode = 'ask'): Promise<void> {
    const session = this.chat.activeSession();
    if (!session) return;
    if (!content.trim()) return;

    const scope = this.chat.contextScope();
    const vaultPath = this.vault.vaultPath();
    const activeAbs = this.vault.activeFilePath();

    // An edit turn requires the user to explicitly choose Edit mode AND have the
    // active file in scope and open. Intent is no longer guessed from wording:
    // an Ask-mode message always answers in chat, even if it reads like an edit.
    const editTargetRel =
      scope.includeActiveFile && activeAbs && vaultPath
        ? canonicalRelPath(absToRel(vaultPath, activeAbs))
        : null;
    const isEdit = mode === 'edit' && editTargetRel !== null;

    // Editor selection focus, snapshotted once at turn start so the prompt is
    // stable for the whole turn (and replayed verbatim on Retry) even if the
    // user keeps selecting while the model streams.
    const selection = this.captureSelection(scope);

    // Ask-mode turns with tools enabled go through the agentic tool loop so the
    // model can create files via the `write_file` tool. Edit-mode turns keep the
    // existing JSON-proposal path untouched. Tools are skipped when disabled in
    // settings, which makes behavior identical to the legacy plain-chat path.
    if (!isEdit && this.settings.aiToolsEnabled()) {
      await this.runWithTools({ userContent: content, scope, selection });
      return;
    }

    await this.run({
      userContent: content,
      scope,
      selection,
      additionalInstructions: isEdit
        ? selection
          ? editSelectionSystemPrompt(selection)
          : EDIT_SYSTEM_PROMPT
        : ASK_SYSTEM_PROMPT,
      expectsFileProposal: isEdit,
      forcedEditRelPath: isEdit ? editTargetRel : null,
      defaultFolder: null,
      defaultTitle: 'Draft',
    });
  }

  /**
   * Runs a planning command (PRD/ADR/etc) using its registered prompt
   * template. Creates a new session if none is open.
   *
   * Grounding preservation: commands that historically required vault context
   * (`mode !== 'general'`) fall back to whole-vault retrieval for the turn when
   * the user's scope has no retrieval selection. Free-form turns get no such
   * fallback (empty scope means general chat).
   */
  async runCommand(commandId: PlanningCommandId, userIntent: string): Promise<void> {
    const cmd = findCommand(commandId);
    const session = this.chat.activeSession() ?? (await this.chat.createSession(cmd.label, cmd.mode));
    if (!session) return;

    const scope = this.chat.contextScope();

    // Force-edit commands (e.g. /decompose-stories) revise the ACTIVE markdown
    // file in place rather than drafting a new document. Resolve the target rel
    // BEFORE touching the model so a missing active file fails fast with a clear
    // error instead of an unhelpful model round-trip. Any folder is fine — the AI
    // does the decomposition, so the source file's location is irrelevant.
    if (cmd.forceEditActiveFile) {
      const vaultPath = this.vault.vaultPath();
      const activeAbs = this.vault.activeFilePath();
      const activeRel = vaultPath && activeAbs ? toVaultRel(vaultPath, activeAbs) : null;
      const canonActiveRel = activeRel !== null ? canonicalRelPath(activeRel) : null;
      if (canonActiveRel === null) {
        this.chat.setError('Open a markdown file to decompose into stories.');
        return;
      }

      // Pin the active file (post-unsaved-edits content) into the turn so the
      // model sees the full epic it must reproduce + extend. `includeActiveFile`
      // drives composeMessages' active-file pin; adding the rel to `files`
      // guarantees the pin even if the active-file derivation differs.
      const forceEditScope: ContextScope = {
        ...scope,
        includeActiveFile: true,
        files: scope.files.includes(canonActiveRel)
          ? scope.files
          : [...scope.files, canonActiveRel],
      };

      await this.run({
        userContent: userIntent.trim().length > 0 ? userIntent : cmd.description,
        selection: null,
        scope: forceEditScope,
        additionalInstructions: cmd.systemPrompt,
        expectsFileProposal: cmd.expectsFileProposal,
        forcedEditRelPath: canonActiveRel,
        defaultFolder: cmd.defaultFolder,
        defaultTitle: cmd.label,
      });
      return;
    }

    const hasSelection = scope.wholeVault || scope.folders.length > 0 || scope.files.length > 0;
    const effectiveScope: ContextScope =
      cmd.mode !== 'general' && !hasSelection ? { ...scope, wholeVault: true } : scope;

    await this.run({
      userContent: userIntent.trim().length > 0 ? userIntent : cmd.description,
      scope: effectiveScope,
      // Planning commands draft whole documents from templates; an editor
      // selection would only mislead that flow, so it is not threaded here.
      selection: null,
      additionalInstructions: cmd.systemPrompt,
      expectsFileProposal: cmd.expectsFileProposal,
      forcedEditRelPath: null,
      defaultFolder: cmd.defaultFolder,
      defaultTitle: cmd.label,
    });
  }

  /**
   * The combined `/decompose-stories` action (TER-37): break the active feature
   * document into AI-authored, ID-tagged user stories AND push them to Linear,
   * behind ONE review.
   *
   * Data flow (the rework's whole point): the model is fed the ENTIRE document as
   * context and returns a flat list of actionable user stories (NOT a heading
   * parse — the epic, background/goals/context prose, and themes stay in the doc).
   * Those stories are appended under a plain `## User Stories` section as
   * `### <title> <!-- sf:id <id> -->` headings with stable marker ids; and the push
   * comes from ONLY those ID-tagged stories — pushed as FLAT Linear issues (no
   * epic/theme/parent), idempotency anchored on the explicit marker ids (via
   * `sync_links.specItemId`). The doc is written FIRST on approve, then the
   * per-file push re-plans from the written file (the SAME flat tagged-story
   * extractor), so a create-then-rerun UPDATES rather than duplicates.
   *
   * Steps:
   *  1. Gate: active file, an enabled Linear connection, and a configured provider.
   *  2. Flush unsaved editor edits, read the FULL file, collect existing tagged
   *     story titles to feed the model so it proposes only NEW stories.
   *  3. Call the model (jsonObject) with the full doc as context → parse
   *     `{ stories: [...] }`.
   *  4. Build the proposed file content in-memory (existing content preserved
   *     verbatim, new stories appended tagged under `## User Stories`).
   *  5. Compute the push preview from the FLAT tagged-story items (only stories —
   *     no epic/themes/prose) resolved against the connection's SyncLinks, and open
   *     the single combined review modal.
   *  6. On approve: write the doc (via FileChangeService — three-way-merge guard),
   *     then run the per-file push. On discard: nothing is written or pushed.
   */
  async decomposeAndPushActiveFile(userIntent: string): Promise<void> {
    const session =
      this.chat.activeSession() ??
      (await this.chat.createSession('Decompose & Push', 'draft'));
    if (!session) return;

    // Gate 1a: AI provider configured (mirrors the run()/runWithTools() guard).
    if (!this.providers.isConfigured()) {
      this.chat.setError('No API key configured. Open Settings to add one.');
      return;
    }

    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) {
      this.chat.setError('Pick a vault before decomposing.');
      return;
    }

    // Gate 1b: an active markdown file to decompose (any folder).
    const activeAbs = this.vault.activeFilePath();
    const activeRel = activeAbs ? toVaultRel(vaultPath, activeAbs) : null;
    const relPath = activeRel !== null ? canonicalRelPath(activeRel) : null;
    if (relPath === null || activeAbs === null) {
      this.chat.setError('Open a markdown file to decompose into stories.');
      return;
    }

    // Gate 1c: an enabled Linear connection for this vault (mirrors
    // hasEnabledLinearConnection in app.component.ts). One scan resolves both the
    // gate and the connection the push targets.
    const connection = this.settings
      .connectionsForVault(vaultPath)
      .find((c) => c.provider === 'linear' && c.enabled);
    if (!connection) {
      this.chat.setError(
        'No enabled Linear connection for this vault. Add one in Settings → Integrations.',
      );
      return;
    }

    // Step 2: flush unsaved edits, read the file, collect existing tagged titles.
    let existingContent: string;
    try {
      await this.editorBuffer.flushIfDirty(activeAbs);
      existingContent = await this.ipc.readFile(activeAbs);
    } catch {
      this.chat.setError('Could not read the active file to decompose.');
      return;
    }

    const existingStoryTitles = parseMarkedHeadings(existingContent)
      .filter((h) => h.level === 3 && h.id !== null)
      .map((h) => h.title);

    // Step 3: call the model for the structured story list.
    await this.beginTurn(session.id, this.decomposeUserMessage(userIntent), false);
    const controller = new AbortController();
    this.abortController = controller;

    let stories: ProposedStory[];
    try {
      const messages = await this.composeMessages({
        scope: this.decomposeScope(relPath),
        userContent: this.decomposeUserMessage(userIntent),
        selection: null,
        additionalInstructions: this.decomposeInstructions(existingStoryTitles),
        vaultPath,
      });
      const result = await this.providers.chat.chatComplete(messages, {
        jsonObject: true,
        signal: controller.signal,
      });
      stories = parseStoriesResponse(result.content ?? '');
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      if (isAbort) {
        this.chat.updateLastAssistant({ error: null, streaming: false });
      } else {
        this.chat.updateLastAssistant({ error: toAiErrorInfo(err), streaming: false });
        this.chat.setTurnError(toAiErrorInfo(err));
      }
      this.abortController = null;
      this.chat.setStreaming(false);
      return;
    }
    this.abortController = null;
    this.chat.setStreaming(false);

    // Step 4: build the proposed file content in-memory.
    let proposed: ReturnType<typeof buildProposedContent>;
    try {
      proposed = buildProposedContent(existingContent, stories);
    } catch (err) {
      this.chat.updateLastAssistant({
        content: err instanceof Error ? err.message : 'Could not build the decomposed document.',
        streaming: false,
      });
      return;
    }

    if (proposed.storiesAdded === 0) {
      // Already fully covered — nothing to write or push. Surface it in chat and
      // never open the review modal.
      this.chat.updateLastAssistant({
        content: 'This epic is already fully decomposed — no new stories to add.',
        streaming: false,
      });
      await this.chat.persistMessage(
        session.id,
        'assistant',
        'This epic is already fully decomposed — no new stories to add.',
        null,
      );
      void this.chat.refreshSessions();
      return;
    }

    // Step 5: compute the FLAT, stories-only items from the proposed content (ONLY
    // the AI-tagged stories — never the epic/themes/prose) and open the combined
    // review. The same flat extractor backs the eventual per-file execute, so the
    // preview matches exactly what is pushed.
    const items = buildTaskItemsFromContent(relPath, proposed.content);
    this.chat.updateLastAssistant({
      content:
        `Proposed **${proposed.storiesAdded}** new ` +
        `${proposed.storiesAdded === 1 ? 'story' : 'stories'} for \`${relPath}\`. ` +
        `Review and confirm in the combined dialog.`,
      streaming: false,
    });
    await this.chat.persistMessage(
      session.id,
      'assistant',
      `Proposed ${proposed.storiesAdded} new ${proposed.storiesAdded === 1 ? 'story' : 'stories'} for ${relPath}.`,
      null,
    );
    void this.chat.refreshSessions();

    const sessionId = session.id;
    this.ui.openCombinedPushReview({
      filePath: relPath,
      items,
      summary: {
        storiesAdded: proposed.storiesAdded,
        sectionCreated: proposed.sectionCreated,
      },
      // Step 6: write-then-push. Write FIRST (FileChangeService's edit path runs
      // the three-way-merge / conflict guard so a concurrent edit is never silently
      // clobbered), so the doc stays the source of truth for any later re-push.
      // THEN push the EXACT in-memory `items` we already previewed — NOT a disk
      // re-read. Re-reading would re-extract through the file readers and could
      // diverge from the preview (an apply-time merge / EOL transform reshaping the
      // written content, or — for a degraded routing — the whole-vault converter
      // dropping the structured description/open-questions/risks). Pushing the
      // previewed items guarantees Linear == preview == doc. Idempotency is
      // unchanged: each item's `localId` is its `sf:id` marker id, so a re-run
      // UPDATES rather than duplicates via `sync_links`.
      onApprove: async (onProgress) => {
        const before = await this.fileChange.resolveBeforeContent(relPath);
        await this.fileChange.apply({
          sessionId,
          relPath,
          changeType: 'edit',
          beforeContent: before,
          afterContent: proposed.content,
        });
        // Forward the modal's live-progress sink so the push fills in a per-item
        // list as it runs (TER-37 live progress).
        return this.sync.executePushFromItems(connection.connectionId, items, onProgress);
      },
    });
  }

  /** The user-visible message recorded for a decompose turn. */
  private decomposeUserMessage(userIntent: string): string {
    const intent = userIntent.trim();
    return intent.length > 0
      ? `Decompose & push this file. ${intent}`
      : 'Decompose & push this file.';
  }

  /**
   * The scope for a decompose turn: pin the active file so the model sees the full
   * epic it must decompose. Mirrors the force-edit scope the old flow used.
   */
  private decomposeScope(relPath: string): ContextScope {
    const scope = this.chat.contextScope();
    return {
      ...scope,
      includeActiveFile: true,
      files: scope.files.includes(relPath) ? scope.files : [...scope.files, relPath],
    };
  }

  /**
   * The system instructions for a decompose turn: the structured-output prompt
   * plus the titles of the stories already tagged in the file, so the model
   * proposes only NEW stories (re-runs add, never duplicate).
   */
  private decomposeInstructions(existingStoryTitles: string[]): string {
    if (existingStoryTitles.length === 0) {
      return `${DECOMPOSE_STORIES_PROMPT}\n\nEXISTING STORIES: (none yet — propose the full decomposition.)`;
    }
    const list = existingStoryTitles.map((t) => `- ${t}`).join('\n');
    return `${DECOMPOSE_STORIES_PROMPT}\n\nEXISTING STORIES (do NOT duplicate these):\n${list}`;
  }

  /**
   * Ask-mode turn with native function-calling. Streams the assistant reply
   * and, when the model emits `tool_calls`, executes each tool, stages any
   * resulting proposal in the confirm modal, feeds the tool results back, and
   * re-invokes the model — bounded by {@link MAX_TOOL_ROUNDS}.
   *
   * OpenAI ordering contract: every assistant message that carries `tool_calls`
   * is immediately followed by exactly one `tool`-role message per
   * `tool_call_id` before the next model call.
   */
  private async runWithTools(opts: {
    userContent: string;
    scope: ContextScope;
    selection: SelectionContext | null;
    retry?: boolean;
  }): Promise<void> {
    const session = this.chat.activeSession();
    if (!session) return;
    if (!this.providers.isConfigured()) {
      this.chat.setError('No API key configured. Open Settings to add one.');
      return;
    }

    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) {
      this.chat.setError('Pick a vault before chatting.');
      return;
    }

    await this.beginTurn(session.id, opts.userContent, opts.retry === true);

    const controller = new AbortController();
    this.abortController = controller;

    // Mirrors the visible assistant content so the catch block can persist
    // whatever partial text exists when the turn fails mid-stream.
    let liveText = '';
    // Mirrors the accumulated reasoning so a failed turn can persist whatever
    // thinking text streamed in before the failure.
    let liveReasoning = '';

    try {
      // Base conversation: system prompt (with tool guidance) + persisted turns.
      const convo = await this.composeMessages({
        scope: opts.scope,
        userContent: opts.userContent,
        selection: opts.selection,
        additionalInstructions: TOOL_USAGE_PROMPT,
        vaultPath,
      });

      // Per-tool gating: drop schemas for tools the user disabled so they are
      // never advertised to the model. The global `ai.toolsEnabled` switch
      // (checked by the caller) still acts as the master gate above this.
      const disabledTools = new Set(this.settings.disabledTools());
      const toolSchemas = this.tools
        .schemas()
        .filter((schema) => !disabledTools.has(schema.function.name));

      // The loop algorithm itself lives in the framework-free runAgenticLoop so
      // the headless benchmark harness runs the exact same code path. The app
      // owns the streaming-text mirror (liveText, for the catch block + bubble)
      // and the modal-gated tool execution via executeToolCall.
      const loopResult = await runAgenticLoop(convo, {
        chat: (messages, callOpts) => this.providers.chat.chat(messages, callOpts),
        toolSchemas,
        signal: controller.signal,
        executeToolCall: (call) =>
          this.executeToolCall(call, { sessionId: session.id, vaultPath }),
        onText: (text) => {
          liveText = text;
          this.chat.updateLastAssistant({ content: text });
        },
        onReasoning: (text) => {
          liveReasoning = text;
          this.chat.updateLastAssistant({ reasoning: text });
        },
        maxRounds: MAX_TOOL_ROUNDS,
      });
      const finalText = loopResult.finalText;
      const finalReasoning = loopResult.finalReasoning;
      const exhaustedToolRounds = loopResult.exhaustedToolRounds;
      liveText = finalText;
      liveReasoning = finalReasoning;

      if (exhaustedToolRounds) {
        // The model was still requesting tools when the cap hit. Surface an
        // honest, retryable notice instead of pretending the turn finished.
        const notice: AiErrorInfo = {
          code: 'unknown',
          retryable: true,
          message: `Stopped after ${MAX_TOOL_ROUNDS} tool rounds without a final answer.`,
        };
        this.chat.updateLastAssistant({ content: finalText, streaming: false });
        await this.failTurn(notice, session.id, finalText, finalReasoning, {
          kind: 'tools',
          sessionId: session.id,
          userContent: opts.userContent,
          scope: opts.scope,
          selection: opts.selection,
        });
      } else {
        const displayContent =
          finalText.trim().length > 0
            ? finalText
            : 'Done.';

        this.chat.updateLastAssistant({ content: displayContent, streaming: false });

        const persisted = await this.chat.persistMessage(
          session.id,
          'assistant',
          displayContent,
          finalReasoning || null,
        );
        if (persisted) {
          this.chat.updateLastAssistant({ id: persisted.id });
        }
      }
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === 'AbortError';
      if (isAbort) {
        // User Stop: keep the partial text, no error surface.
        this.chat.updateLastAssistant({ error: null, streaming: false });
      } else {
        await this.failTurn(toAiErrorInfo(err), session.id, liveText, liveReasoning, {
          kind: 'tools',
          sessionId: session.id,
          userContent: opts.userContent,
          scope: opts.scope,
          selection: opts.selection,
        });
      }
    } finally {
      this.abortController = null;
      this.chat.setStreaming(false);
    }

    void this.chat.refreshSessions();
    void this.indexFreshFile(vaultPath);
  }

  /**
   * Runs a single tool call: dispatches to the registered tool, and if it
   * stages a proposal, opens the confirm modal and waits for the user. The
   * modal performs the actual write + undo recording on accept — the
   * orchestrator never writes to disk itself. Returns the `tool`-role message
   * to feed back to the model.
   */
  private async executeToolCall(
    call: ToolCall,
    ctx: { sessionId: number | null; vaultPath: string },
  ): Promise<ChatMessage> {
    const name = call.function.name;

    // Per-tool gating guard: even though disabled tools aren't advertised, a
    // model could still hallucinate a call to one. Refuse to dispatch it.
    if (this.settings.disabledTools().includes(name)) {
      return {
        role: 'tool',
        tool_call_id: call.id,
        name,
        content: `Error: tool "${name}" is disabled.`,
      };
    }

    const tool = this.tools.get(name);
    if (!tool) {
      return {
        role: 'tool',
        tool_call_id: call.id,
        name,
        content: `Error: unknown tool "${name}".`,
      };
    }

    const result = await tool.execute(call, ctx);

    // Validation error (or any non-proposal result): pass content straight back.
    if (!result.proposal) {
      return {
        role: 'tool',
        tool_call_id: call.id,
        name,
        content: result.content,
      };
    }

    // Stage the proposal in the confirm modal and wait for the user.
    const outcome = await this.proposeAndAwait(result.proposal);
    const content = outcome.applied
      ? `Created ${outcome.relPath}.`
      : 'The user rejected this file creation. Do not retry; acknowledge briefly and continue.';

    return {
      role: 'tool',
      tool_call_id: call.id,
      name,
      content,
    };
  }

  /**
   * Seeds the chat state for a turn. Fresh turns append + persist the user
   * message and append a streaming assistant bubble; retries skip both and
   * reset the failed assistant bubble in place instead.
   */
  private async beginTurn(sessionId: number, userContent: string, retry: boolean): Promise<void> {
    // Starting any turn invalidates the previous failed-turn snapshot.
    this.lastFailedTurn = null;
    this._retryAvailable.set(false);

    const assistantUi: UiChatMessage = {
      id: null,
      role: 'assistant',
      content: '',
      reasoning: undefined,
      streaming: true,
      error: null,
      citations: [],
      createdAt: Date.now(),
    };

    if (retry) {
      // Reuse the failed assistant bubble: reset it to a fresh streaming
      // state (it is filtered out of the recomposed conversation while
      // streaming, exactly like a brand-new bubble).
      const messages = this.chat.messages();
      const last = messages[messages.length - 1];
      if (last && last.role === 'assistant') {
        this.chat.updateLastAssistant({
          id: null,
          content: '',
          reasoning: undefined,
          streaming: true,
          error: null,
          citations: [],
        });
      } else {
        this.chat.appendLocal(assistantUi);
      }
    } else {
      const userUi: UiChatMessage = {
        id: null,
        role: 'user',
        content: userContent,
        streaming: false,
        error: null,
        createdAt: Date.now(),
      };
      this.chat.appendLocal(userUi);
      await this.chat.persistMessage(sessionId, 'user', userContent);
      this.chat.appendLocal(assistantUi);
    }

    this.chat.setStreaming(true);
    this.chat.setError(null);
    this.chat.setTurnError(null);
  }

  /**
   * Marks the current assistant turn as failed: attaches the structured error
   * to the bubble and the composer surface, retains the turn inputs for
   * Retry, and persists any partial text.
   *
   * Persistence policy: `chat_messages` has no error column, so the partial
   * content is persisted as a plain assistant message — this keeps a reload
   * from showing an orphaned user question. A turn is persisted when EITHER
   * partial content OR partial reasoning streamed in, so a turn that produced
   * only reasoning (native, or a cleaned `<think>` block) before failing keeps
   * that thinking on reload instead of dropping the row. Turns with neither are
   * skipped rather than writing a blank row.
   */
  private async failTurn(
    info: AiErrorInfo,
    sessionId: number,
    partialContent: string,
    partialReasoning: string,
    failedTurn: FailedTurn,
  ): Promise<void> {
    this.chat.updateLastAssistant({ error: info, streaming: false });
    this.chat.setTurnError(info);
    this.lastFailedTurn = failedTurn;
    this._retryAvailable.set(true);

    if (partialContent.trim().length > 0 || partialReasoning.trim().length > 0) {
      const persisted = await this.chat.persistMessage(
        sessionId,
        'assistant',
        partialContent,
        partialReasoning || null,
      );
      if (persisted) {
        this.chat.updateLastAssistant({ id: persisted.id });
      }
    }
  }

  private async run(opts: RunTurnOptions & { retry?: boolean }): Promise<void> {
    const session = this.chat.activeSession();
    if (!session) return;
    if (!this.providers.isConfigured()) {
      this.chat.setError('No API key configured. Open Settings to add one.');
      return;
    }

    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) {
      this.chat.setError('Pick a vault before chatting.');
      return;
    }

    await this.beginTurn(session.id, opts.userContent, opts.retry === true);

    const controller = new AbortController();
    this.abortController = controller;

    // Declared outside the try so the catch block can persist whatever
    // partial text / reasoning streamed in before the failure. `accumulated`
    // is the CLEAN content (inline `<think>` already stripped); `rawContent`
    // is the unsplit buffer the split runs over; `accumulatedReasoning` is the
    // MERGED reasoning (native sibling channel + inline `<think>`).
    let accumulated = '';
    let rawContent = '';
    let nativeReasoning = '';
    let accumulatedReasoning = '';

    try {
      const messages = await this.composeMessages({
        scope: opts.scope,
        userContent: opts.userContent,
        selection: opts.selection,
        additionalInstructions: opts.additionalInstructions,
        vaultPath,
      });

      if (opts.expectsFileProposal) {
        const result = await this.providers.chat.chatComplete(messages, {
          jsonObject: true,
          signal: controller.signal,
        });
        rawContent = result.content ?? '';
        nativeReasoning = result.reasoning ?? '';
        // Split inline `<think>` out so parseProposal sees CLEAN JSON: a leading
        // reasoning block would otherwise break the proposal's JSON parsing.
        const split = mightContainThink(rawContent)
          ? splitThinkTags(rawContent)
          : { reasoning: '', content: rawContent };
        accumulated = split.content;
        accumulatedReasoning = mergeReasoning('', nativeReasoning, split.reasoning);
        if (accumulatedReasoning) {
          this.chat.updateLastAssistant({ reasoning: accumulatedReasoning });
        }
      } else {
        for await (const chunk of this.providers.chat.chat(messages, {
          signal: controller.signal,
        })) {
          if (chunk.delta) {
            rawContent += chunk.delta;
            // ONE parser: peel inline `<think>` reasoning out of the content so
            // the live bubble shows clean text and the think block lands on the
            // reasoning channel. Guarded so the common no-tags case is untouched.
            const split = mightContainThink(rawContent)
              ? splitThinkTags(rawContent)
              : { reasoning: '', content: rawContent };
            accumulated = split.content;
            accumulatedReasoning = mergeReasoning('', nativeReasoning, split.reasoning);
            this.chat.updateLastAssistant({
              content: accumulated,
              reasoning: accumulatedReasoning || undefined,
            });
          }
          if (chunk.reasoning) {
            nativeReasoning += chunk.reasoning;
            const split = mightContainThink(rawContent)
              ? splitThinkTags(rawContent)
              : { reasoning: '', content: rawContent };
            accumulatedReasoning = mergeReasoning('', nativeReasoning, split.reasoning);
            this.chat.updateLastAssistant({ reasoning: accumulatedReasoning });
          }
          if (chunk.done) break;
        }
      }

      let displayContent = accumulated;
      if (opts.expectsFileProposal) {
        const proposal = this.parseProposal(
          accumulated,
          opts.defaultFolder,
          opts.defaultTitle,
          session.id,
          opts.forcedEditRelPath,
        );
        if (proposal) {
          this._pendingProposal.set(proposal);
          displayContent =
            `Proposed **${proposal.changeType}** \`${proposal.relPath}\` — _${proposal.title}_\n\n` +
            `Review and confirm in the proposal dialog. The full markdown is staged there.`;
        } else {
          displayContent =
            'The assistant did not return a parsable file proposal. Raw response:\n\n```\n' +
            accumulated +
            '\n```';
        }
      }

      this.chat.updateLastAssistant({
        content: displayContent,
        streaming: false,
      });

      const persisted = await this.chat.persistMessage(
        session.id,
        'assistant',
        displayContent,
        accumulatedReasoning || null,
      );
      if (persisted) {
        this.chat.updateLastAssistant({ id: persisted.id });
      }
    } catch (err) {
      const isAbort =
        err instanceof DOMException && err.name === 'AbortError';
      if (isAbort) {
        // User Stop: keep the partial text, no error surface.
        this.chat.updateLastAssistant({ error: null, streaming: false });
      } else {
        // Proposal turns are all-or-nothing (no streamed partial), so the
        // partial passed here is empty and nothing gets persisted for them.
        await this.failTurn(toAiErrorInfo(err), session.id, accumulated, accumulatedReasoning, {
          kind: 'run',
          sessionId: session.id,
          opts: {
            userContent: opts.userContent,
            scope: opts.scope,
            selection: opts.selection,
            additionalInstructions: opts.additionalInstructions,
            expectsFileProposal: opts.expectsFileProposal,
            forcedEditRelPath: opts.forcedEditRelPath,
            defaultFolder: opts.defaultFolder,
            defaultTitle: opts.defaultTitle,
          },
        });
      }
    } finally {
      this.abortController = null;
      this.chat.setStreaming(false);
    }

    // Refresh the session list so the most-recently-updated session bubbles up.
    void this.chat.refreshSessions();
    void this.indexFreshFile(vaultPath);
  }

  /**
   * Captures the current editor selection for a turn, or null when no valid
   * selection applies: the scope must include the active file (otherwise the
   * SELECTION block would reference content the model cannot see), and the
   * snapshot must belong to that file with non-whitespace text.
   */
  private captureSelection(scope: ContextScope): SelectionContext | null {
    const activeFilePath = this.vault.activeFilePath();
    const snapshot = resolveActiveSelection(
      this.editorSelection.selection(),
      activeFilePath,
      scope.includeActiveFile,
    );
    if (!snapshot || !activeFilePath) return null;
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) return null;
    // Derive the rel-path from the active-file path — the exact string
    // composeMessages keys the pinned file by — not from the snapshot's path.
    // resolveActiveSelection only guarantees the two are samePath-equal
    // (case/separator-insensitive), while the PINNED FILE / SELECTION title
    // match in assembleSystemMessage is strict, casing-preserving equality.
    const relPath = canonicalRelPath(absToRel(vaultPath, activeFilePath));
    if (!relPath) return null;
    return {
      relPath,
      text: snapshot.text,
      startLine: snapshot.startLine,
      endLine: snapshot.endLine,
    };
  }

  private async composeMessages(opts: {
    scope: ContextScope;
    userContent: string;
    selection: SelectionContext | null;
    additionalInstructions: string | null;
    vaultPath: string;
  }): Promise<ChatMessage[]> {
    const maxChars = this.settings.aiMaxContextChars();
    const topK = this.settings.aiTopK();
    const scope = opts.scope;

    // 1. Gather pinned files: the active file (if opted in) then each scoped
    //    file. Read verbatim and key them by their canonical vault-rel path.
    const pinnedFiles: PinnedFile[] = [];
    const seenPinned = new Set<string>();

    const addPinned = async (relPath: string): Promise<void> => {
      const canon = canonicalRelPath(relPath);
      if (!canon || seenPinned.has(canon)) return;
      try {
        const abs = relToAbs(opts.vaultPath, canon);
        // Flush-before-read: pinned context must include unsaved editor edits.
        await this.editorBuffer.flushIfDirty(abs);
        const content = await this.ipc.readFile(abs);
        pinnedFiles.push({ title: canon, content });
        seenPinned.add(canon);
      } catch {
        // Missing/unreadable files are skipped rather than failing the turn.
      }
    };

    let activeContent: string | null = null;
    if (scope.includeActiveFile) {
      const activeAbs = this.vault.activeFilePath();
      if (activeAbs) {
        const activeRel = absToRel(opts.vaultPath, activeAbs);
        await addPinned(activeRel);
        const canonActive = canonicalRelPath(activeRel);
        if (canonActive) {
          activeContent =
            pinnedFiles.find((p) => p.title === canonActive)?.content ?? null;
        }
      }
    }
    for (const file of scope.files) {
      await addPinned(file);
    }

    // 2. Retrieval runs only when the scope opts into a search surface.
    const needsContext = scope.wholeVault || scope.folders.length > 0 || scope.files.length > 0;
    // Whole-vault search uses no path filter; a narrower selection passes the
    // folders/files through as the filter.
    const hasNarrowing = scope.folders.length > 0 || scope.files.length > 0;
    const filter = hasNarrowing
      ? { folders: scope.folders, files: scope.files }
      : undefined;

    const hits = needsContext
      ? await this.retrieval.retrieve(
          this.composeRetrievalQuery(opts.userContent, activeContent, opts.selection),
          opts.vaultPath,
          topK,
          filter,
        )
      : [];

    const { systemMessage, citations } = assembleSystemMessage(hits, {
      maxContextChars: maxChars,
      additionalInstructions: opts.additionalInstructions ?? undefined,
      pinnedFiles,
      availableSkills: this.skillRegistry.enabled(),
      selection: opts.selection ?? undefined,
    });

    this.chat.updateLastAssistant({ citations });

    const turns = this.chat
      .messages()
      .filter((m) => m.role !== 'assistant' || !m.streaming)
      .filter((m) => m.role !== 'system')
      .map<ChatMessage>((m) => ({ role: m.role, content: m.content }));

    return [systemMessage, ...turns];
  }

  private composeRetrievalQuery(
    userContent: string,
    activeContent: string | null,
    selection: SelectionContext | null,
  ): string {
    // Selection text is what the user is actually working on, so it sharpens
    // retrieval more than the file's first heading; capped so a select-all
    // can't swamp the search query.
    const selectionBoost = selection ? selection.text.slice(0, RETRIEVAL_SELECTION_CAP) : '';
    const firstHeading =
      activeContent?.split(/\r?\n/).find((l) => l.startsWith('#')) ?? '';
    return [userContent, selectionBoost, firstHeading]
      .filter((s) => s.trim().length > 0)
      .join('\n');
  }

  private parseProposal(
    raw: string,
    defaultFolder: string | null,
    defaultTitle: string,
    sessionId: number,
    forcedEditRelPath: string | null,
  ): FileProposal | null {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;

    let json: CommandResponseJson | null = null;
    try {
      json = JSON.parse(trimmed) as CommandResponseJson;
    } catch {
      const match = trimmed.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          json = JSON.parse(match[0]) as CommandResponseJson;
        } catch {
          json = null;
        }
      }
    }
    if (!json) return null;

    const content = typeof json.content === 'string' ? json.content : '';
    if (content.trim().length === 0) return null;

    // Edit-intent turns force the target to the active file as an in-place edit.
    if (forcedEditRelPath) {
      return {
        relPath: forcedEditRelPath,
        changeType: 'edit',
        title: typeof json.title === 'string' ? json.title : forcedEditRelPath,
        content,
        sessionId,
      };
    }

    const folder = (json.folder && typeof json.folder === 'string' ? json.folder : defaultFolder) ?? '';
    const filenameRaw = typeof json.filename === 'string' && json.filename.length > 0
      ? json.filename
      : `${slugify(json.title ?? defaultTitle)}.md`;
    const filename = sanitizeFilename(filenameRaw);

    const folderClean = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const relPath = folderClean.length === 0 ? filename : `${folderClean}/${filename}`;

    return {
      relPath,
      changeType: 'create',
      title: typeof json.title === 'string' ? json.title : defaultTitle,
      content,
      sessionId,
    };
  }

  /**
   * After an assistant turn, if a brand-new file was created via the proposal
   * flow it will be picked up by the watcher and indexed. This method is a
   * placeholder for future hook points (e.g. eager embedding of newly created
   * files when embeddings are enabled).
   */
  private async indexFreshFile(_vaultPath: string): Promise<void> {
    // Reserved for Phase 4 enhancement.
  }
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'untitled';
}

/**
 * Parses the model's `{ "stories": [...] }` response into {@link ProposedStory}[],
 * tolerating the model wrapping the JSON in prose / a code fence the way
 * `parseProposal` does (extract the first `{…}` object). Each story is coerced to
 * the expected shape; malformed entries are dropped. Returns `[]` for an
 * unparsable response or an explicit empty `stories` array.
 */
export function parseStoriesResponse(raw: string): ProposedStory[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        parsed = null;
      }
    }
  }
  if (parsed === null || typeof parsed !== 'object') return [];

  const storiesRaw = (parsed as { stories?: unknown }).stories;
  if (!Array.isArray(storiesRaw)) return [];

  const out: ProposedStory[] = [];
  for (const entry of storiesRaw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const title = typeof e['title'] === 'string' ? e['title'].trim() : '';
    const role = typeof e['role'] === 'string' ? e['role'] : '';
    const capability = typeof e['capability'] === 'string' ? e['capability'] : '';
    const benefit = typeof e['benefit'] === 'string' ? e['benefit'] : '';
    const description = typeof e['description'] === 'string' ? e['description'] : '';
    // A story needs SOMETHING to title it — a plain title or, failing that, an
    // "As a …"-derivable capability. An entry with neither is too empty to render.
    if (title.length === 0 && capability.trim().length === 0) continue;
    out.push({
      title,
      role,
      capability,
      benefit,
      description,
      acceptanceCriteria: stringArray(e['acceptanceCriteria']),
      openQuestions: stringArray(e['openQuestions']),
      risks: stringArray(e['risks']),
    });
  }
  return out;
}

/** Coerces an unknown JSON value into a string[] — drops non-string entries; `[]` when not an array. */
function stringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((c): c is string => typeof c === 'string') : [];
}

/**
 * Joins the NATIVE sibling reasoning with any INLINE `<think>` reasoning peeled
 * out by `splitThinkTags`. Native is concatenated onto `base` without a
 * separator; inline, when present, is appended on a new line. Mirrors the
 * helper in the shared agentic loop so both paths fold reasoning identically.
 */
function mergeReasoning(base: string, native: string, inline: string): string {
  let out = base + native;
  if (inline) out = out.length > 0 ? `${out}\n${inline}` : inline;
  return out;
}

/**
 * Cheap guard so `splitThinkTags` only scans the accumulated text when it could
 * actually carry an inline think block — keyed off a closing `</think>` or an
 * explicit leading `<think>`, matching the loop's guard.
 */
function mightContainThink(raw: string): boolean {
  return raw.includes('</think>') || raw.replace(/^\s+/, '').startsWith('<think>');
}
