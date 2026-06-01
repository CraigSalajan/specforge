import { Injectable, inject, signal } from '@angular/core';
import type { ContextScope } from '../../shared/types';
import { IpcService } from '../../core/ipc.service';
import { SettingsService } from '../../core/settings.service';
import { VaultService } from '../../core/vault.service';
import { AiProviderService } from './providers/ai-provider.service';
import { RetrievalService } from './providers/retrieval.service';
import { ChatService, type UiChatMessage } from './chat.service';
import { assembleSystemMessage, type PinnedFile } from './prompts/system-context';
import { findCommand, type PlanningCommandId } from './prompts';
import type { ChatMessage } from './providers/chat.provider';
import { absToRel, canonicalRelPath, relToAbs, sanitizeFilename } from './providers/path-utils';

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
  private readonly settings = inject(SettingsService);
  private readonly vault = inject(VaultService);
  private readonly providers = inject(AiProviderService);
  private readonly retrieval = inject(RetrievalService);
  private readonly chat = inject(ChatService);

  private readonly _pendingProposal = signal<FileProposal | null>(null);
  readonly pendingProposal = this._pendingProposal.asReadonly();

  private abortController: AbortController | null = null;

  clearPendingProposal(): void {
    this._pendingProposal.set(null);
  }

  stop(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
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

    await this.run({
      userContent: content,
      scope,
      additionalInstructions: isEdit ? EDIT_SYSTEM_PROMPT : ASK_SYSTEM_PROMPT,
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
    const hasSelection = scope.wholeVault || scope.folders.length > 0 || scope.files.length > 0;
    const effectiveScope: ContextScope =
      cmd.mode !== 'general' && !hasSelection ? { ...scope, wholeVault: true } : scope;

    await this.run({
      userContent: userIntent.trim().length > 0 ? userIntent : cmd.description,
      scope: effectiveScope,
      additionalInstructions: cmd.systemPrompt,
      expectsFileProposal: cmd.expectsFileProposal,
      forcedEditRelPath: null,
      defaultFolder: cmd.defaultFolder,
      defaultTitle: cmd.label,
    });
  }

  private async run(opts: {
    userContent: string;
    scope: ContextScope;
    additionalInstructions: string | null;
    expectsFileProposal: boolean;
    /** When set, the resulting proposal is forced to edit this rel-path. */
    forcedEditRelPath: string | null;
    defaultFolder: string | null;
    defaultTitle: string;
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

    const now = Date.now();
    const userUi: UiChatMessage = {
      id: null,
      role: 'user',
      content: opts.userContent,
      streaming: false,
      error: null,
      createdAt: now,
    };
    this.chat.appendLocal(userUi);
    await this.chat.persistMessage(session.id, 'user', opts.userContent);

    const assistantUi: UiChatMessage = {
      id: null,
      role: 'assistant',
      content: '',
      streaming: true,
      error: null,
      citations: [],
      createdAt: Date.now(),
    };
    this.chat.appendLocal(assistantUi);
    this.chat.setStreaming(true);
    this.chat.setError(null);

    const controller = new AbortController();
    this.abortController = controller;

    try {
      const messages = await this.composeMessages({
        scope: opts.scope,
        userContent: opts.userContent,
        additionalInstructions: opts.additionalInstructions,
        vaultPath,
      });

      let accumulated = '';
      if (opts.expectsFileProposal) {
        const text = await this.providers.chat.chatComplete(messages, {
          jsonObject: true,
          signal: controller.signal,
        });
        accumulated = text;
      } else {
        for await (const chunk of this.providers.chat.chat(messages, {
          signal: controller.signal,
        })) {
          if (chunk.delta) {
            accumulated += chunk.delta;
            this.chat.updateLastAssistant({ content: accumulated });
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
      );
      if (persisted) {
        this.chat.updateLastAssistant({ id: persisted.id });
      }
    } catch (err) {
      const isAbort =
        err instanceof DOMException && err.name === 'AbortError';
      const message = isAbort
        ? 'Stopped.'
        : err instanceof Error
          ? err.message
          : String(err);
      this.chat.updateLastAssistant({
        error: isAbort ? null : message,
        streaming: false,
      });
      if (!isAbort) this.chat.setError(message);
    } finally {
      this.abortController = null;
      this.chat.setStreaming(false);
    }

    // Refresh the session list so the most-recently-updated session bubbles up.
    void this.chat.refreshSessions();
    void this.indexFreshFile(vaultPath);
  }

  private async composeMessages(opts: {
    scope: ContextScope;
    userContent: string;
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
        const content = await this.ipc.readFile(relToAbs(opts.vaultPath, canon));
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
          this.composeRetrievalQuery(opts.userContent, activeContent),
          opts.vaultPath,
          topK,
          filter,
        )
      : [];

    const { systemMessage, citations } = assembleSystemMessage(hits, {
      maxContextChars: maxChars,
      additionalInstructions: opts.additionalInstructions ?? undefined,
      pinnedFiles,
    });

    this.chat.updateLastAssistant({ citations });

    const turns = this.chat
      .messages()
      .filter((m) => m.role !== 'assistant' || !m.streaming)
      .filter((m) => m.role !== 'system')
      .map<ChatMessage>((m) => ({ role: m.role, content: m.content }));

    return [systemMessage, ...turns];
  }

  private composeRetrievalQuery(userContent: string, activeContent: string | null): string {
    if (!activeContent) return userContent;
    const firstHeading = activeContent.split(/\r?\n/).find((l) => l.startsWith('#'));
    return [userContent, firstHeading ?? ''].filter((s) => s.trim().length > 0).join('\n');
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
