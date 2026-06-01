import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { marked } from 'marked';
import { type ChatSession } from '../../shared/types';
import { VaultService } from '../../core/vault.service';
import { UiStateService } from '../../core/ui-state.service';
import { InputDialogService } from '../../core/input-dialog.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { ChatService } from './chat.service';
import { AiOrchestratorService, isEditIntent, type ComposerMode } from './ai-orchestrator.service';
import { FileChangeService } from './file-change.service';
import { AiProviderService } from './providers/ai-provider.service';
import { PLANNING_COMMANDS, type PlanningCommandId } from './prompts';
import { ContextBarComponent } from './context-bar.component';
import {
  ComposerAutocompleteComponent,
  type AutocompleteGroup,
  type AutocompleteItem,
} from './composer-autocomplete.component';

@Component({
  selector: 'app-ai-panel',
  standalone: true,
  imports: [FormsModule, ContextBarComponent, ComposerAutocompleteComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex h-full flex-col bg-surface-1 text-text-primary">
      <header class="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-text-secondary">AI Harness</h2>
        <button
          type="button"
          class="rounded px-1.5 py-0.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:opacity-50"
          title="Undo last AI change"
          [disabled]="fileChangeUndoing()"
          (click)="onUndoLast()">{{ fileChangeUndoing() ? 'Undoing…' : 'Undo last' }}</button>
      </header>

      @if (actionMessage(); as am) {
        <div class="flex items-center justify-between gap-2 border-b border-border-subtle bg-surface-2 px-3 py-1.5">
          <span
            class="text-xs"
            [class.text-danger]="am.kind === 'error'"
            [class.text-text-secondary]="am.kind === 'info'">{{ am.text }}</span>
          <button
            type="button"
            class="rounded px-1.5 py-0.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary"
            title="Dismiss"
            (click)="dismissActionMessage()">×</button>
        </div>
      }

      <div class="flex items-center gap-2 border-b border-border-subtle bg-surface-2 px-2 py-1.5">
        <select
          class="flex-1 min-w-0 rounded border border-border-subtle bg-surface-1 pl-2 pr-8 py-1 text-sm text-text-primary focus:border-accent focus:outline-none"
          [value]="activeSessionId() ?? ''"
          (change)="onSessionSelect($any($event.target).value)">
          @if (!activeSession()) {
            <option value="">Untitled chat</option>
          }
          @for (s of sessions(); track s.id) {
            <option [value]="s.id">{{ s.title }}</option>
          }
        </select>
        <button
          type="button"
          class="rounded bg-accent px-2 py-1 text-sm font-medium leading-none text-white hover:bg-accent-hover"
          title="New chat"
          (click)="onNewChat()">+</button>
        @if (activeSession(); as a) {
          <button
            type="button"
            class="rounded px-2 py-1 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary"
            title="Rename"
            (click)="onRename(a)">Rename</button>
          <button
            type="button"
            class="rounded px-2 py-1 text-xs text-text-secondary hover:bg-surface-3 hover:text-danger"
            title="Delete"
            (click)="onDelete(a)">Delete</button>
        }
      </div>

      <div class="relative flex min-h-0 flex-1 flex-col">
      <div
        #scroller
        aria-live="polite"
        class="flex-1 overflow-y-auto px-3 py-3"
        (scroll)="onScroll()">
        @if (!apiConfigured()) {
          <div class="flex h-full flex-col items-center justify-center gap-2 text-center">
            <div class="rounded-full border border-border-subtle bg-surface-2 px-3 py-1 text-xs uppercase tracking-wider text-text-muted">
              Not configured
            </div>
            <p class="text-sm text-text-secondary">No AI provider configured</p>
            <button
              type="button"
              class="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
              (click)="onOpenSettings()">Open Settings</button>
          </div>
        } @else if (messages().length === 0) {
          <div class="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p class="text-xs text-text-secondary">Start a conversation, or pick a planning command below.</p>
          </div>
        } @else {
          @for (msg of messages(); track $index; let i = $index) {
            <div class="mb-3 flex flex-col gap-1">
              <div class="text-xs font-semibold uppercase tracking-wider text-text-muted">
                {{ msg.role === 'user' ? 'You' : 'Assistant' }}
                @if (msg.streaming) {
                  <span class="ml-1 text-accent">streaming…</span>
                }
              </div>
              @if (msg.role === 'assistant') {
                <div
                  class="prose-ai rounded border border-border-subtle bg-surface-2 px-3 py-2 text-base leading-relaxed"
                  [innerHTML]="renderAssistant(msg.content)"></div>
                @if (msg.citations && msg.citations.length > 0) {
                  <div class="flex flex-wrap gap-1.5">
                    @for (c of groupCitations(msg.citations); track c.relPath) {
                      <button
                        type="button"
                        class="rounded-sm bg-surface-3 px-1.5 py-0.5 text-xs text-text-secondary hover:bg-accent hover:text-white"
                        [title]="c.title"
                        (click)="onCitationOpen(c.relPath)">{{ c.relPath }}@if (c.count > 1) {<span class="ml-1 text-text-muted">×{{ c.count }}</span>}</button>
                    }
                  </div>
                }
                @if (msg.error) {
                  <p class="text-sm text-danger">Error: {{ msg.error }}</p>
                }
              } @else {
                <div class="whitespace-pre-wrap rounded border border-border-subtle bg-surface-3 px-3 py-2 text-base leading-relaxed text-text-primary">{{ msg.content }}</div>
              }
            </div>
          }
        }
      </div>

      @if (showJumpToLatest()) {
        <button
          type="button"
          class="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full border border-border-subtle bg-surface-2 px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-surface-3 hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          (click)="onJumpToLatest()">
          Jump to latest
          <span aria-hidden="true">↓</span>
        </button>
      }
      </div>

      <div #composer class="border-t border-border-subtle bg-surface-2 px-2 py-2">
        <div class="mb-2 flex items-center gap-2">
          <div
            role="group"
            aria-label="Composer mode"
            class="inline-flex overflow-hidden rounded border border-border-subtle">
            <button
              type="button"
              class="px-2 py-0.5 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
              [class.bg-accent]="composerMode() === 'ask'"
              [class.text-white]="composerMode() === 'ask'"
              [class.text-text-secondary]="composerMode() !== 'ask'"
              [class.hover:bg-surface-3]="composerMode() !== 'ask'"
              [attr.aria-pressed]="composerMode() === 'ask'"
              (click)="setComposerMode('ask')">Ask</button>
            <button
              type="button"
              class="border-l border-border-subtle px-2 py-0.5 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
              [class.bg-accent]="composerMode() === 'edit'"
              [class.text-white]="composerMode() === 'edit'"
              [class.text-text-secondary]="composerMode() !== 'edit'"
              [class.hover:bg-surface-3]="composerMode() !== 'edit'"
              [attr.aria-pressed]="composerMode() === 'edit'"
              (click)="setComposerMode('edit')">Edit</button>
          </div>
          <span class="text-[11px] text-text-muted">
            {{ composerMode() === 'ask' ? 'Answers in chat — files untouched' : 'Proposes an edit to the active file' }}
          </span>
        </div>
        <div class="mb-2">
          <app-context-bar #contextBar (requestContextPicker)="onRequestContextPicker()" />
        </div>

        <app-composer-autocomplete
          #autocompleteRef
          [open]="pickerMode() !== null"
          [anchor]="composerEl()?.nativeElement ?? null"
          [query]="pickerQuery()"
          [groups]="pickerGroups()"
          (select)="onAutocompleteSelect($event)"
          (dismiss)="closePicker()" />

        <div class="flex items-end gap-2">
          <textarea
            #input
            rows="3"
            role="combobox"
            aria-autocomplete="list"
            [attr.aria-expanded]="pickerMode() !== null"
            [attr.aria-controls]="pickerMode() !== null ? 'composer-autocomplete-listbox' : null"
            [attr.aria-activedescendant]="pickerMode() !== null ? autocomplete()?.activeDescendantId() : null"
            class="flex-1 resize-none rounded border border-border-subtle bg-surface-1 px-2 py-1.5 text-xs text-text-primary placeholder:text-text-secondary focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            [placeholder]="composerPlaceholder()"
            [disabled]="!apiConfigured() || streaming()"
            [(ngModel)]="draft"
            (input)="onComposerInput($event)"
            (click)="onComposerInput($event)"
            (keyup)="onComposerCaretMove($event)"
            (keydown)="onComposerKeydown($event)"></textarea>
          @if (streaming()) {
            <button
              type="button"
              class="rounded bg-danger px-3 py-2 text-xs font-medium text-white hover:opacity-90"
              (click)="onStop()">Stop</button>
          } @else {
            <button
              type="button"
              class="rounded bg-accent px-3 py-2 text-xs font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              [disabled]="!canSend()"
              (click)="onSend()">Send</button>
          }
        </div>
        @if (editNudge()) {
          <p class="mt-1 text-xs text-text-secondary">
            This looks like an edit request.
            <button
              type="button"
              class="rounded-sm text-accent hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              (click)="setComposerMode('edit')">Switch to Edit</button>
            to propose changes to the active file.
          </p>
        }
        @if (error(); as err) {
          <p class="mt-1 text-sm text-danger">{{ err }}</p>
        }
      </div>
    </div>
  `,
})
export class AiPanelComponent {
  private readonly chat = inject(ChatService);
  private readonly orchestrator = inject(AiOrchestratorService);
  private readonly fileChange = inject(FileChangeService);
  private readonly vault = inject(VaultService);
  private readonly ui = inject(UiStateService);
  private readonly providers = inject(AiProviderService);
  private readonly inputDialog = inject(InputDialogService);
  private readonly confirmDialog = inject(ConfirmDialogService);

  readonly commands = PLANNING_COMMANDS;

  readonly sessions = this.chat.sessions;
  readonly activeSession = this.chat.activeSession;
  readonly messages = this.chat.messages;
  readonly streaming = this.chat.streaming;
  readonly error = this.chat.error;
  readonly fileChangeUndoing = this.fileChange.undoing;

  readonly apiConfigured = this.providers.isConfigured;

  draft = '';

  /** Which mode the shared autocomplete popover is in, or null (closed). */
  readonly pickerMode = signal<'context' | 'command' | null>(null);
  /** Current query feeding the popover (text after `/` or `@`). */
  readonly pickerQuery = signal('');

  /** Per-turn composer mode. Defaults to Ask so questions never become edits. */
  readonly composerMode = signal<ComposerMode>('ask');
  /**
   * True when the user is in Ask mode but the draft reads like an edit request
   * AND there is an active file that Edit mode could target. Drives a quiet,
   * non-destructive nudge — it never changes mode or sends on the user's behalf.
   */
  readonly editNudge = signal(false);

  /**
   * Command-mode groups for the shared popover: Draft commands (file proposals)
   * and Analyze commands, mapped from the registry and substring-filtered by
   * `query` against label and slug.
   */
  commandGroups(query: string): AutocompleteGroup[] {
    const q = query.trim().toLowerCase();
    const disabled = !this.apiConfigured() || this.streaming();
    const toItem = (c: (typeof PLANNING_COMMANDS)[number]): AutocompleteItem => ({
      id: c.id,
      label: c.label,
      hint: c.description,
      iconType: 'command',
      disabled,
    });
    const matches = (c: (typeof PLANNING_COMMANDS)[number]): boolean =>
      !q || c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q);
    const draftItems = this.commands.filter((c) => c.expectsFileProposal && matches(c)).map(toItem);
    const analyzeItems = this.commands.filter((c) => !c.expectsFileProposal && matches(c)).map(toItem);
    const groups: AutocompleteGroup[] = [];
    if (draftItems.length > 0) groups.push({ heading: 'Draft', items: draftItems });
    if (analyzeItems.length > 0) groups.push({ heading: 'Analyze', items: analyzeItems });
    return groups;
  }

  /** Resolved groups for the current popover mode + query. */
  readonly pickerGroups = computed<AutocompleteGroup[]>(() => {
    const mode = this.pickerMode();
    const query = this.pickerQuery();
    if (mode === 'command') return this.commandGroups(query);
    if (mode === 'context') return this.contextBar()?.contextGroups(query) ?? [];
    return [];
  });

  private readonly _actionMessage = signal<{ kind: 'info' | 'error'; text: string } | null>(null);
  readonly actionMessage = this._actionMessage.asReadonly();

  readonly activeSessionId = computed<number | null>(
    () => this.activeSession()?.id ?? null,
  );

  readonly contextScope = this.chat.contextScope;

  /** Composer placeholder hints whether any vault context is attached. */
  readonly composerPlaceholder = computed<string>(() => {
    const s = this.contextScope();
    const hasActive = s.includeActiveFile && this.vault.activeFilePath() !== null;
    const empty = !s.wholeVault && s.folders.length === 0 && s.files.length === 0 && !hasActive;
    return empty
      ? 'Ask anything — / for commands, @ for context.'
      : 'Ask anything, or pick a command above…';
  });

  readonly canSend = computed(() => {
    if (!this.apiConfigured()) return false;
    if (this.streaming()) return false;
    return this.draft.trim().length > 0;
  });

  private readonly scrollHost = viewChild<ElementRef<HTMLDivElement>>('scroller');
  private readonly contextBar = viewChild<ContextBarComponent>('contextBar');
  protected readonly composerEl = viewChild<ElementRef<HTMLDivElement>>('composer');
  private readonly inputEl = viewChild<ElementRef<HTMLTextAreaElement>>('input');
  protected readonly autocomplete = viewChild<ComposerAutocompleteComponent>('autocompleteRef');

  /**
   * Whether the view should follow new streamed content. Stays true while the
   * user is at (or within a few px of) the bottom; flips to false the moment
   * they scroll up to read, and back to true when they scroll back to the
   * bottom. A signal so the "Jump to latest" button can react. See `onScroll`.
   */
  private readonly pinnedToBottom = signal(true);

  /**
   * Drives the floating "Jump to latest" affordance: the user has scrolled away
   * from the bottom and there is content to jump back to.
   */
  readonly showJumpToLatest = computed(
    () => !this.pinnedToBottom() && this.messages().length > 0,
  );

  /** Px distance from the bottom that still counts as "pinned". */
  private static readonly STICK_THRESHOLD = 24;

  constructor() {
    effect(() => {
      this.vault.vaultPath();
      this.chat.resetForVaultChange();
      void this.chat.refreshSessions();
    });

    effect(() => {
      // Follow new content during a stream, but only while the user hasn't
      // scrolled up to read — otherwise we'd yank them back to the bottom.
      this.messages();
      if (!this.pinnedToBottom()) return;
      const host = this.scrollHost()?.nativeElement;
      if (host) {
        queueMicrotask(() => {
          host.scrollTop = host.scrollHeight;
        });
      }
    });
  }

  /**
   * Recompute whether to keep following new content from the user's current
   * scroll position. Re-enables auto-follow when they return to the bottom and
   * disables it as soon as they scroll up. Our own programmatic scroll lands
   * within the threshold, so it keeps `pinnedToBottom` true rather than
   * fighting itself.
   */
  onScroll(): void {
    const host = this.scrollHost()?.nativeElement;
    if (!host) return;
    const distanceFromBottom = host.scrollHeight - host.scrollTop - host.clientHeight;
    this.pinnedToBottom.set(distanceFromBottom <= AiPanelComponent.STICK_THRESHOLD);
  }

  /** Scroll to the newest content and resume auto-following. */
  onJumpToLatest(): void {
    const host = this.scrollHost()?.nativeElement;
    if (host) host.scrollTop = host.scrollHeight;
    this.pinnedToBottom.set(true);
  }

  groupCitations(
    citations: ReadonlyArray<{ relPath: string; headingPath: string }>,
  ): Array<{ relPath: string; count: number; title: string }> {
    const groups = new Map<string, { count: number; headings: string[] }>();
    for (const c of citations) {
      const group = groups.get(c.relPath) ?? { count: 0, headings: [] };
      group.count += 1;
      if (c.headingPath) group.headings.push(c.headingPath);
      groups.set(c.relPath, group);
    }
    return [...groups.entries()].map(([relPath, group]) => ({
      relPath,
      count: group.count,
      title: group.headings.length > 0 ? group.headings.join('\n') : relPath,
    }));
  }

  renderAssistant(content: string): string {
    if (!content) return '';
    return marked.parse(content, { async: false }) as string;
  }

  onSessionSelect(value: string): void {
    if (!value) {
      this.chat.closeActiveSession();
      return;
    }
    const id = Number(value);
    const session = this.sessions().find((s) => s.id === id);
    if (session) void this.chat.openSession(session);
  }

  onNewChat(): void {
    // Start an ephemeral chat: clear the active session and messages without
    // touching the DB. The session is persisted on the first sent prompt
    // (see onSend), which also derives its title from that prompt.
    this.chat.closeActiveSession();
    this.draft = '';
  }

  async onRename(session: ChatSession): Promise<void> {
    const next = await this.inputDialog.prompt({
      title: 'Rename Session',
      label: 'Session name',
      initialValue: session.title,
      confirmLabel: 'Rename',
    });
    if (next === null) return;
    const trimmed = next.trim();
    if (trimmed.length === 0) return;
    await this.chat.renameSession(session.id, trimmed);
  }

  async onDelete(session: ChatSession): Promise<void> {
    const ok = await this.confirmDialog.confirm({
      title: 'Delete session',
      message: `Delete session "${session.title}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    await this.chat.deleteSession(session.id);
  }

  async onSend(): Promise<void> {
    this._actionMessage.set(null);
    // Sending is explicit intent to follow the reply, regardless of where the
    // user had scrolled to on the previous turn.
    this.pinnedToBottom.set(true);
    const raw = this.draft;

    // A leading `/<known-slug>` runs the matching planning command instead of
    // sending a chat message. Intent (text after the slug) is forwarded; the
    // orchestrator falls back to the command description when it is empty.
    const slash = matchSlashCommand(raw);
    if (slash) {
      this.draft = '';
      this.closePicker();
      await this.orchestrator.runCommand(slash.commandId, slash.intent);
      return;
    }

    const text = raw.trim();
    if (!text) return;
    if (!this.activeSession()) {
      // Mode is retained as a session column for compatibility; context is now
      // driven entirely by the additive ContextScope, so we always pass
      // 'general' here.
      const created = await this.chat.createSession(this.titleFromDraft(text), 'general');
      if (!created) return;
    }
    this.draft = '';
    this.editNudge.set(false);
    this.closePicker();
    await this.orchestrator.sendUserMessage(text, this.composerMode());
  }

  /**
   * Keydown on the composer. While the popover is open it drives combobox
   * navigation (focus stays in the textarea); otherwise it handles send and the
   * empty-composer Backspace-removes-last-chip behavior.
   */
  onComposerKeydown(event: Event): void {
    const e = event as KeyboardEvent;
    const pickerOpen = this.pickerMode() !== null;

    if (pickerOpen) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          this.autocomplete()?.moveHighlight(1);
          return;
        case 'ArrowUp':
          e.preventDefault();
          this.autocomplete()?.moveHighlight(-1);
          return;
        case 'Enter': {
          if (e.shiftKey) return;
          e.preventDefault();
          // With a highlighted item, Enter selects it (inserts/applies, never
          // sends). With an empty/no-match list there is nothing to select, so
          // close the picker and fall through to the normal send path instead
          // of swallowing the keystroke.
          if (this.autocomplete()?.highlightedId()) {
            this.autocomplete()?.selectHighlighted();
            return;
          }
          this.closePicker();
          void this.onSend();
          return;
        }
        case 'Escape':
          e.preventDefault();
          this.closePicker();
          return;
        default:
          break;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void this.onSend();
      return;
    }

    if (e.key === 'Backspace' && this.draft.length === 0 && !pickerOpen) {
      const removed = this.contextBar()?.removeLastChip();
      if (removed) e.preventDefault();
    }
  }

  /**
   * Recomputes the popover mode/query from the caret position on every input or
   * caret move. Command mode wins when the line is a leading `/<query>` token
   * (no space yet); context mode triggers on a trailing `@<query>` token.
   */
  onComposerInput(event: Event): void {
    const el = event.target as HTMLTextAreaElement;
    const caret = el.selectionStart ?? el.value.length;
    const before = el.value.slice(0, caret);
    this.updateEditNudge(el.value);

    // Command mode: the whole input up to the caret is a single leading slash
    // token (`/`, `/cre`, …) with no space — once a space follows the slug the
    // user is typing intent and the menu closes.
    const cmdMatch = /^\/(\S*)$/.exec(before);
    if (cmdMatch) {
      this.pickerMode.set('command');
      this.pickerQuery.set(cmdMatch[1] ?? '');
      return;
    }

    // Context mode: a trailing `@<query>` token at the caret.
    const ctxMatch = /(?:^|\s)@(\S*)$/.exec(before);
    if (ctxMatch) {
      this.pickerMode.set('context');
      this.pickerQuery.set(ctxMatch[1] ?? '');
      return;
    }

    this.closePicker();
  }

  /** Keyup re-evaluates token detection on caret-only moves (arrows, etc.). */
  onComposerCaretMove(event: Event): void {
    const e = event as KeyboardEvent;
    // Navigation/selection keys that move the caret without an `input` event.
    if (
      e.key === 'ArrowLeft' ||
      e.key === 'ArrowRight' ||
      e.key === 'Home' ||
      e.key === 'End'
    ) {
      this.onComposerInput(event);
    }
  }

  /** Opens the popover in context mode (from the chip-row `+` button). */
  onRequestContextPicker(): void {
    // The composer textarea is disabled while unconfigured or streaming; opening
    // the picker then would focus a no-op element and leave a stray `@` the user
    // cannot delete. Guard so the `+` button is inert in those states.
    if (!this.apiConfigured() || this.streaming()) return;
    const el = this.inputEl()?.nativeElement;
    if (!el) return;
    el.focus();
    // Insert an `@` at the caret so the token-detection path takes over.
    const caret = el.selectionStart ?? this.draft.length;
    this.draft = this.draft.slice(0, caret) + '@' + this.draft.slice(caret);
    this.pickerMode.set('context');
    this.pickerQuery.set('');
    queueMicrotask(() => {
      const pos = caret + 1;
      el.setSelectionRange(pos, pos);
    });
  }

  /** Handles a selection from the shared popover for either mode. */
  onAutocompleteSelect(item: AutocompleteItem): void {
    if (this.pickerMode() === 'command') {
      // Insert `/slug ` (slug + trailing space) replacing only the leading `/<query>` token,
      // and preserve text after the caret.
      const el = this.inputEl()?.nativeElement;
      const caret = el?.selectionStart ?? this.draft.length;
      const before = this.draft.slice(0, caret);
      const after = this.draft.slice(caret);
      const stripped = before.replace(/^\s*\/\S*$/, '');
      this.draft = stripped + `/${item.id} ` + after;
      this.closePicker();
      if (el) {
        el.focus();
        queueMicrotask(() => {
          const pos = stripped.length + `/${item.id} `.length;
          el.setSelectionRange(pos, pos);
        });
      }
      return;
    }

    // Context mode: add the chip, then strip the `@<query>` token that opened
    // the popover. The token sits immediately before the caret (which is not
    // necessarily the end of the draft), so we splice it out relative to the
    // caret and reposition rather than anchoring to end-of-string.
    this.contextBar()?.applyContextSelection(item);
    const el = this.inputEl()?.nativeElement;
    const caret = el?.selectionStart ?? this.draft.length;
    const before = this.draft.slice(0, caret);
    const after = this.draft.slice(caret);
    const stripped = before.replace(/(^|\s)@\S*$/, '$1');
    this.draft = stripped + after;
    this.closePicker();
    if (el) {
      el.focus();
      const pos = stripped.length;
      queueMicrotask(() => el.setSelectionRange(pos, pos));
    }
  }

  closePicker(): void {
    this.pickerMode.set(null);
    this.pickerQuery.set('');
  }

  /**
   * Recomputes the Ask-mode edit nudge from the current draft. Called on input
   * and when the mode toggles. Gated on an attached active file so we never
   * suggest Edit when there is nothing for it to target.
   */
  private updateEditNudge(text: string): void {
    const hasActiveTarget =
      this.contextScope().includeActiveFile && this.vault.activeFilePath() !== null;
    this.editNudge.set(
      this.composerMode() === 'ask' && hasActiveTarget && isEditIntent(text),
    );
  }

  /** Sets the composer mode and refreshes the nudge for the current draft. */
  setComposerMode(mode: ComposerMode): void {
    this.composerMode.set(mode);
    this.updateEditNudge(this.draft);
  }

  onStop(): void {
    this.orchestrator.stop();
  }

  async onCitationOpen(relPath: string): Promise<void> {
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) return;
    const sep = vaultPath.includes('\\') && !vaultPath.includes('/') ? '\\' : '/';
    const root = vaultPath.replace(/[\\/]$/, '');
    const cleanRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const abs = [root, ...cleanRel.split('/')].join(sep);
    this.vault.setActiveFile(abs);
  }

  onOpenSettings(): void {
    this.ui.openSettings();
  }

  dismissActionMessage(): void {
    this._actionMessage.set(null);
  }

  async onUndoLast(): Promise<void> {
    this._actionMessage.set(null);
    const ok = await this.confirmDialog.confirm({
      title: 'Undo last change',
      message: 'Undo the most recent AI change?',
      confirmLabel: 'Undo',
      danger: true,
    });
    if (!ok) return;
    try {
      const reverted = await this.fileChange.undoLastApplied();
      if (!reverted) {
        this._actionMessage.set({ kind: 'info', text: 'No AI change to undo.' });
      }
    } catch (err) {
      this._actionMessage.set({
        kind: 'error',
        text: 'Undo failed: ' + (err instanceof Error ? err.message : String(err)),
      });
    }
  }

  private titleFromDraft(draft: string): string {
    const first = draft.split('\n')[0] ?? draft;
    return first.length > 60 ? first.slice(0, 60) + '…' : first;
  }
}

/** Known command slugs derived from the planning-command registry ids. */
const KNOWN_COMMAND_SLUGS = new Set<string>(PLANNING_COMMANDS.map((c) => c.id));

/**
 * Pure helper: when `text` starts with `/<known-slug>` (optionally followed by
 * intent), returns the command id and trimmed intent; otherwise null.
 */
export function matchSlashCommand(
  text: string,
): { commandId: PlanningCommandId; intent: string } | null {
  const match = /^\s*\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return null;
  const slug = match[1]!.toLowerCase();
  if (!KNOWN_COMMAND_SLUGS.has(slug)) return null;
  return {
    commandId: slug as PlanningCommandId,
    intent: (match[2] ?? '').trim(),
  };
}

