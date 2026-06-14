import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { EditorSelection, EditorState, Prec, Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { search, searchKeymap } from '@codemirror/search';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import {
  codeBlockField,
  collapseOnSelectionFacet,
  editorTheme,
  imageField,
  initHighlighter,
  livePreviewPlugin,
  markdownStylePlugin,
  mouseSelectingField,
  setMouseSelecting,
} from 'codemirror-live-markdown';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { EditorBufferService, type EditorBufferDelegate } from '../../core/editor-buffer.service';
import { EditorNavigationService } from '../../core/editor-navigation.service';
import { EditorSelectionService } from '../../core/editor-selection.service';
import { EditorStatusService } from '../../core/editor-status.service';
import { IpcService } from '../../core/ipc.service';
import { PdfExportService } from '../../core/pdf-export.service';
import { SettingsService } from '../../core/settings.service';
import { UiStateService } from '../../core/ui-state.service';
import { VaultService } from '../../core/vault.service';
import { computeMinimalChange, threeWayMerge } from '../../shared/merge-utils';
import { normalizePath, samePath } from '../../shared/path-utils';
import type { FileChangeEvent } from '../../shared/types';
import { appLinkPlugin, refreshLinkResolution } from './link-plugin';
import {
  frontmatterCollapsedField,
  frontmatterField,
  frontmatterValueSource,
  setFrontmatterCollapsed,
} from './frontmatter-field';
import { mermaidField } from './mermaid-field';
import { REVEAL_HIGHLIGHT_MS, revealLineExtension, setRevealHighlight } from './reveal-line';
import { richTableField } from './rich-table-field';
import { taskListField } from './task-list-field';
import { wikiLinkAutocomplete } from './wikilink-autocomplete';
import { WikilinkNavigationService } from './wikilink-navigation.service';
import {
  buildResolvableStems,
  buildWikiCompletionEntries,
  collectMarkdownFiles,
  isTargetResolvable,
  splitWikiTarget,
} from './wikilink-utils';

// Kick off async syntax-highlighter init (lowlight + highlight.js) exactly once
// for the whole app. codeBlockField consults the highlighter lazily, so fenced
// code blocks still render (just without token colors) until/if this resolves.
// We deliberately never await it — a missing or failing highlighter must never
// block editor creation. Failures degrade gracefully to plain code blocks.
let highlighterInit: Promise<boolean> | null = null;
function ensureHighlighter(): void {
  if (highlighterInit) return;
  try {
    highlighterInit = initHighlighter();
    highlighterInit.catch(() => {
      /* highlighting unavailable — code blocks still render plainly */
    });
  } catch {
    /* initHighlighter threw synchronously — ignore */
  }
}

// Auto-save debounce. Every write triggers the chokidar watcher (tree refresh
// at 120ms, index-status refresh at 800ms), so saving more aggressively than
// ~1s would churn the watcher pipeline on every keystroke pause.
const AUTO_SAVE_DEBOUNCE_MS = 1000;

// Coalesces watcher event bursts (chokidar can emit several events for one
// logical save) before the buffer is reconciled with disk.
const RECONCILE_DEBOUNCE_MS = 80;

// Debounce for publishing the editor selection to EditorSelectionService
// (plain setTimeout — no RxJS in this app). Long enough that a mouse drag
// doesn't churn the signal on every pixel, short enough to feel immediate.
const SELECTION_PUBLISH_DEBOUNCE_MS = 150;

// Lifetime of the auto-dismissing "Merged changes from disk" hint.
const MERGE_NOTICE_MS = 4000;

// Baseline sentinel installed while the loaded file is deleted on disk. It
// can never equal real buffer content, so isDirty stays true and every
// explicit flush path (manual save, switch-away) writes the buffer back —
// while the suspended auto-save can't silently resurrect the file.
const DELETED_BASELINE = '\0specforge:deleted-on-disk\0';

// Session-only cap on remembered per-file selection/scroll states (tab
// switches restore them). Map insertion order doubles as the eviction order.
const VIEW_STATE_CACHE_MAX = 50;

/**
 * Selection (state JSON) + the document position at the top of the viewport,
 * captured when switching away from a file. A doc anchor (not a pixel offset)
 * is used because CM estimates off-screen line heights, so a raw scrollTop
 * restores to the wrong place and drifts on every toggle.
 */
interface PerFileViewState {
  selection: unknown;
  topPos: number;
}

@Component({
  selector: 'app-editor',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex h-full flex-col bg-surface-0 text-text-primary">
      <div class="flex items-center justify-between border-b border-border-subtle bg-surface-1 px-3 py-2">
        <div class="flex items-center gap-2 truncate">
          @if (!filePath()) {
            <span class="text-xs text-text-muted">No file open</span>
          }
        </div>
        @if (filePath()) {
          <div class="flex items-center gap-1">
            <button
              type="button"
              class="rounded px-2 py-1 text-sm text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:opacity-50"
              [disabled]="exporting()"
              (click)="exportPdf()">{{ exporting() ? 'Exporting…' : 'Export PDF' }}</button>
            <button
              type="button"
              class="rounded bg-accent px-2 py-1 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              [disabled]="!isDirty()"
              (click)="save()">Save</button>
          </div>
        }
      </div>

      @if (deletedOnDisk()) {
        <div role="status" class="flex items-center justify-between gap-3 border-b border-border-subtle bg-surface-1 px-3 py-1.5">
          <span class="text-xs text-text-secondary">File was deleted on disk.</span>
          <button
            type="button"
            class="shrink-0 rounded px-2 py-0.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary"
            (click)="restoreDeleted()">Keep &amp; restore</button>
        </div>
      } @else if (conflict()) {
        <div role="alert" class="flex items-center justify-between gap-3 border-b border-border-subtle bg-surface-1 px-3 py-1.5">
          <span class="truncate text-xs text-text-secondary">File changed on disk and conflicts with your unsaved edits.</span>
          <div class="flex shrink-0 items-center gap-1">
            <button
              type="button"
              class="rounded px-2 py-0.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary"
              (click)="keepMine()">Keep mine</button>
            <button
              type="button"
              class="rounded px-2 py-0.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary"
              (click)="useDisk()">Use disk</button>
          </div>
        </div>
      } @else if (mergeNotice(); as notice) {
        <div role="status" class="border-b border-border-subtle bg-surface-1 px-3 py-1.5">
          <span class="text-xs text-text-muted">{{ notice }}</span>
        </div>
      }

      <div class="relative flex-1 overflow-hidden">
        @if (!filePath()) {
          <div class="flex h-full flex-col items-center justify-center gap-2 text-text-muted">
            <p class="text-sm">Select a file from the vault to start editing</p>
            <p class="text-xs">Ctrl+S to save · Markdown renders live as you type</p>
            <p class="text-xs">Ctrl+P to open files · Ctrl+Shift+P for commands</p>
          </div>
        } @else {
          <div #editorHost class="absolute inset-0 overflow-hidden"></div>
        }
      </div>
    </div>
  `,
})
export class EditorComponent implements OnDestroy {
  private readonly ipc = inject(IpcService);
  private readonly pdfExport = inject(PdfExportService);
  private readonly settings = inject(SettingsService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly editorBuffer = inject(EditorBufferService);
  private readonly editorNav = inject(EditorNavigationService);
  private readonly editorSelection = inject(EditorSelectionService);
  private readonly editorStatus = inject(EditorStatusService);
  private readonly ui = inject(UiStateService);
  private readonly vault = inject(VaultService);
  private readonly wikilinkNav = inject(WikilinkNavigationService);

  readonly filePath = input<string | null>(null);

  readonly saved = output<{ path: string }>();

  private readonly editorHost = viewChild<ElementRef<HTMLDivElement>>('editorHost');

  private readonly _content = signal<string>('');
  private readonly _savedContent = signal<string>('');

  readonly exporting = signal(false);

  // The loaded file changed on disk in a way that overlaps unsaved buffer
  // edits; auto-save is suspended until the user picks a side via the banner
  // (or saves manually, which means "keep mine").
  readonly conflict = signal(false);

  // The loaded file was deleted on disk while open. The buffer is preserved
  // and auto-save suspended; only an explicit flush recreates the file.
  readonly deletedOnDisk = signal(false);

  // Auto-dismissing hint shown after a clean three-way merge from disk.
  readonly mergeNotice = signal<string | null>(null);

  readonly isDirty = computed(() => this._content() !== this._savedContent());

  // Vault markdown corpus for the wikilink features. The tree signal is kept
  // fresh by the watcher (120ms debounce), so both derivations below are
  // near-live: a created/deleted/renamed file updates unresolved marks and
  // the [[ completion list without any extra IPC.
  private readonly vaultMarkdownFiles = computed(() => {
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) return [];
    return collectMarkdownFiles(this.vault.tree(), vaultPath);
  });

  /** Segment-aligned stems for the synchronous unresolved-wikilink check. */
  private readonly resolvableStems = computed(() =>
    buildResolvableStems(this.vaultMarkdownFiles().map((f) => f.relPath)),
  );

  /** `[[` completion corpus (duplicate basenames pre-disambiguated). */
  private readonly wikiCompletionEntries = computed(() =>
    buildWikiCompletionEntries(this.vaultMarkdownFiles()),
  );

  private view: EditorView | null = null;
  // True while we are programmatically replacing the document (file load).
  // CM's updateListener fires synchronously during dispatch; this flag stops
  // that callback from writing back into _content (avoids redundant signal
  // writes during change detection).
  private isApplyingExternal = false;

  // Path whose content currently lives in the buffer. Set once a load
  // completes; flushes (auto-save timer, switch, destroy, unload) write to
  // THIS path — never the filePath() input, which may already point at the
  // next file by the time an async flush runs.
  private loadedPath: string | null = null;

  // Pending debounced auto-save (plain setTimeout — no RxJS in this app).
  private autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // Pending debounced selection publish (same setTimeout pattern). The
  // snapshot is read from live view state when the timer fires, so coalesced
  // updates always publish the final selection, never an intermediate one.
  private selectionPublishTimer: ReturnType<typeof setTimeout> | null = null;

  // Monotonic token bumped on every file switch. Async work (file reads, the
  // unsaved-changes prompt) compares its captured token against the current
  // one and bails when superseded, so rapid switches are strictly latest-wins
  // and a stale read can never clobber a newer buffer.
  private loadToken = 0;

  // Tail of the write queue. Disk writes are strictly serialized through this
  // chain — otherwise a debounced auto-save racing a switch-triggered flush
  // for the same file could land out of order and leave older content on
  // disk. Each link handles its own errors, so the chain never rejects.
  private writeChain: Promise<void> = Promise.resolve();

  // Watcher unsubscribe + debounced disk reconcile (same setTimeout pattern
  // as auto-save). Reconciles are serialized through their own chain so two
  // overlapping runs can't apply stale disk reads out of order.
  private unsubscribeFileChange: (() => void) | null = null;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileChain: Promise<void> = Promise.resolve();

  // True when the most recent watcher event for the loaded file was `unlink`.
  // Atomic-save tools emit unlink+add pairs, so only a trailing unlink (still
  // set when the debounced reconcile finds the file unreadable) is a deletion.
  private pendingUnlink = false;

  // Baseline captured when entering the deleted-on-disk state, restored if
  // the file reappears so the normal reconcile can diff against it.
  private preDeleteBaseline: string | null = null;

  private mergeNoticeTimer: ReturnType<typeof setTimeout> | null = null;

  // Pending removal of the transient jump-to-line flash decoration (same
  // setTimeout pattern as the other editor timers).
  private revealHighlightTimer: ReturnType<typeof setTimeout> | null = null;

  // Per-file selection/scroll memory for tab switches, keyed by normalized
  // path. Session-only — undo history is NOT preserved across switches (the
  // view is reused; doc replacement is excluded from history instead).
  private readonly viewStateCache = new Map<string, PerFileViewState>();

  // View state waiting to be restored once the target document is actually in
  // the view (same handshake shape as the pending reveal). Cleared by any
  // newer switch; a pending reveal for the same file always wins over it.
  private pendingViewState: (PerFileViewState & { path: string }) | null = null;

  // Last UiStateService focus-request seq this editor has honored. Requests
  // arriving before the view exists (file still loading) are consumed by the
  // focus effect once the host/content effect has created the view.
  private consumedFocusSeq = 0;

  // Registered with EditorBufferService so AI read paths can flush this
  // buffer before reading from disk. While in conflict (or deleted-on-disk)
  // a flush would silently pick a winner, so the delegate declines and
  // callers see disk truth instead.
  private readonly bufferDelegate: EditorBufferDelegate = {
    loadedPath: () => this.loadedPath,
    isDirty: () => this.isDirty(),
    flush: async () => {
      if (this.conflict() || this.deletedOnDisk()) return;
      this.clearAutoSaveTimer();
      await this.flushDirtyBuffer();
    },
  };

  constructor() {
    // Reacts to filePath changes: flush unsaved work, then load/clear the
    // document buffer. Everything except filePath() is read inside
    // untracked() so dirty-state and settings changes don't re-trigger it.
    effect(() => {
      const path = this.filePath();
      untracked(() => {
        void this.switchTo(path);
      });
    });

    // Mounts (and syncs) the CodeMirror view. Runs as part of change
    // detection, so the #editorHost view-child signal is guaranteed to be
    // populated once the @if (filePath()) branch has rendered the host. This
    // is required in a zoneless app, where a one-shot microtask after a signal
    // write is not ordered relative to the framework's render flush.
    //
    // The pending-reveal read is intentionally tracked: a jump request for the
    // ALREADY-open file changes no other signal, and this effect is where the
    // view is guaranteed to hold the target document.
    effect(() => {
      // filePath() is read FIRST so this effect both re-runs across open/close
      // transitions and can decline to (re)mount a view while no file is open.
      // That guard is essential: closing the last file calls destroyView(), but
      // the _content.set('') in that same teardown re-triggers this effect while
      // the #editorHost view-child can still resolve to the OLD host for one
      // flush (the @if has not detached it yet). Building a view there would
      // orphan it in a to-be-detached host, and the next open would find
      // ensureView() short-circuiting on that non-null view — dispatching the
      // document into a detached editor that never renders.
      const path = this.filePath();
      const host = this.editorHost()?.nativeElement;
      const content = this._content();
      if (!path || !host) {
        // No file open (or host not yet rendered) — the view is owned and torn
        // down by the filePath effect; never mount one here.
        return;
      }
      this.ensureView(host);
      this.applyContentToView(content);
      // Restore before reveal: consumePendingViewState declines (and drops
      // its state) when a reveal targets the loaded file, so a jump request
      // is never clobbered by a remembered scroll position.
      this.consumePendingViewState();
      this.consumePendingReveal();
    });

    // Publishes dirty state for chrome outside the editor (tab bar dirty
    // dot). Background tabs are never dirty — the buffer is flushed on every
    // switch — so this single signal fully describes tab dirty state.
    effect(() => {
      this.editorStatus.setActiveDirty(this.isDirty());
    });

    // Focus requests from the command palette ("Focus editor") and the quick
    // switcher (file open). Declared AFTER the mount/sync effect and tracking
    // the same host/content signals, so a request issued while a file is
    // still loading fires once that effect has created the view.
    effect(() => {
      const seq = this.ui.editorFocusRequests();
      this.editorHost();
      this._content();
      if (seq === this.consumedFocusSeq) return;
      if (!this.view) return;
      this.consumedFocusSeq = seq;
      this.view.focus();
    });

    // The wikilink plugin resolves targets synchronously against
    // resolvableStems at decoration build time; when the vault's file set
    // changes with no doc/selection change (file created, deleted, renamed),
    // nothing would trigger a rebuild — this effect tells the view to
    // re-evaluate so unresolved marks flip immediately.
    effect(() => {
      this.resolvableStems();
      untracked(() => {
        this.view?.dispatch({ effects: refreshLinkResolution.of(null) });
      });
    });

    this.editorBuffer.register(this.bufferDelegate);

    if (this.ipc.isAvailable) {
      this.unsubscribeFileChange = this.ipc.onFileChange((evt) => this.onWatcherEvent(evt));
    }
  }

  ngOnDestroy(): void {
    this.unsubscribeFileChange?.();
    this.unsubscribeFileChange = null;
    this.editorBuffer.unregister(this.bufferDelegate);
    this.clearReconcileTimer();
    this.clearMergeNoticeTimer();
    this.clearAutoSaveTimer();
    this.clearSelectionPublishTimer();
    this.clearRevealHighlightTimer();
    this.editorSelection.clear();
    this.editorStatus.setActiveDirty(false);
    if (this.autoSaveEnabled()) {
      // Best effort: the component is going away, so we can't await the write.
      void this.flushDirtyBuffer();
    }
    this.destroyView();
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(evt: KeyboardEvent): void {
    if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === 's') {
      evt.preventDefault();
      void this.save();
    }
  }

  // Best-effort flush when the window closes. ipcRenderer.invoke sends the
  // message to the main process synchronously, so the write typically lands
  // even though the renderer won't see the promise resolve.
  @HostListener('window:beforeunload')
  onBeforeUnload(): void {
    this.clearAutoSaveTimer();
    if (this.autoSaveEnabled()) {
      void this.flushDirtyBuffer();
    }
  }

  async save(): Promise<void> {
    this.clearAutoSaveTimer();
    // Manual save is explicit intent: the buffer wins over whatever is on
    // disk, so an open conflict is resolved as "keep mine".
    this.conflict.set(false);
    await this.flushDirtyBuffer();
  }

  async exportPdf(): Promise<void> {
    const path = this.filePath();
    if (!path || this.exporting()) return;
    this.exporting.set(true);
    try {
      const result = await this.pdfExport.exportMarkdown(this._content(), path);
      if (!result.success && !result.canceled) {
        await this.confirmDialog.notice({
          title: 'PDF export failed',
          message: result.error ?? 'Unknown error',
        });
      }
    } catch (err) {
      await this.confirmDialog.notice({
        title: 'PDF export failed',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.exporting.set(false);
    }
  }

  /**
   * Handles a filePath() change: flushes (or prompts about) unsaved work in
   * the OLD buffer before the new file is loaded, so switching files can no
   * longer silently drop edits (issue #2).
   *
   * The old path + content are captured synchronously up front, which means
   * the flush write can never race the reload — even though we deliberately
   * don't await it (auto-save case) before loading the new file.
   */
  private async switchTo(nextPath: string | null): Promise<void> {
    const token = ++this.loadToken;

    // Remember the outgoing file's selection + scroll (synchronously, while
    // the view still holds its document) so returning to its tab restores
    // the exact spot. Any not-yet-consumed restore is stale once a newer
    // switch begins.
    this.captureViewState();
    this.pendingViewState = null;

    // Any pending debounced save is superseded: either we flush immediately
    // below, or the buffer is clean and there is nothing to write.
    this.clearAutoSaveTimer();

    // The published selection belongs to the outgoing file; drop it (and any
    // pending publish) before the next document loads.
    this.clearSelectionPublishTimer();
    this.editorSelection.clear();

    // A pending reconcile belongs to the previous file; drop it. An already
    // in-flight reconcile aborts on its own token/path guards. Banner state
    // is reset only after the new file loads, so the deleted-on-disk
    // sentinel still makes the dirty check below flush the old buffer.
    this.clearReconcileTimer();
    this.pendingUnlink = false;

    // A pending reveal targeting some OTHER file is stale (e.g. its load
    // failed and the user has navigated on); drop it so it can't fire on a
    // much later, unrelated open of that file.
    const staleReveal = this.editorNav.pendingReveal();
    if (staleReveal && (!nextPath || !samePath(staleReveal.filePath, nextPath))) {
      this.editorNav.consume(staleReveal);
    }

    const oldPath = this.loadedPath;
    const oldContent = this._content();
    const dirty = oldPath !== null && oldContent !== this._savedContent();

    if (dirty && oldPath !== nextPath) {
      // While conflicted, a silent flush would resolve the conflict as "keep
      // mine" without the arbitration the banner exists for, so even with
      // auto-save enabled the user is asked which side wins.
      const conflicted = this.conflict();
      if (this.autoSaveEnabled() && !conflicted) {
        // Fire-and-forget: the captured (path, content) pair keeps the write
        // consistent regardless of what loads into the buffer afterwards.
        void this.writeTo(oldPath, oldContent);
      } else {
        const fileName = oldPath.split(/[\\/]/).pop() ?? oldPath;
        const shouldSave = await this.confirmDialog.confirm(
          conflicted
            ? {
                title: 'Conflicting changes',
                message: `${fileName} changed on disk and conflicts with your unsaved edits. Keep your version?`,
                confirmLabel: 'Keep mine',
                cancelLabel: 'Use disk',
              }
            : {
                title: 'Unsaved changes',
                message: `You have unsaved changes in ${fileName}. Save them?`,
                confirmLabel: 'Save',
                cancelLabel: 'Discard',
              },
        );
        // Honor an explicit Save even if a newer switch arrived meanwhile.
        // (A newer switch force-resolves this prompt with `false` via
        // ConfirmDialogService, so `true` always reflects a real user click.)
        if (shouldSave) {
          void this.writeTo(oldPath, oldContent);
        }
      }
    }

    // A newer switch happened while we awaited the prompt — it owns loading.
    if (token !== this.loadToken) return;

    if (nextPath) {
      await this.loadFile(nextPath, token);
    } else {
      this.loadedPath = null;
      this._content.set('');
      this._savedContent.set('');
      this.resetDiskSyncState();
      this.destroyView();
    }
  }

  /**
   * Writes the buffer to the currently loaded file if it has unsaved changes.
   * Shared by manual save, the debounced auto-save, destroy and beforeunload.
   */
  private async flushDirtyBuffer(): Promise<void> {
    const path = this.loadedPath;
    if (!path) return;
    const content = this._content();
    if (content === this._savedContent()) return;
    await this.writeTo(path, content);
  }

  private writeTo(path: string, content: string): Promise<void> {
    const write = this.writeChain.then(() => this.performWrite(path, content));
    this.writeChain = write;
    return write;
  }

  private async performWrite(path: string, content: string): Promise<void> {
    try {
      await this.ipc.writeFile(path, content);
      // Only advance the dirty baseline if the buffer still holds this file —
      // a flush for the previous file must not clobber the next file's state.
      if (this.loadedPath === path) {
        this._savedContent.set(content);
        // A successful write means the file exists again.
        if (this.deletedOnDisk()) {
          this.deletedOnDisk.set(false);
          this.preDeleteBaseline = null;
        }
      }
      this.saved.emit({ path });
    } catch (err) {
      // Buffer and dirty state are left untouched, so nothing is lost and the
      // user can retry (manual save or the next auto-save attempt). The notice
      // is fire-and-forget: awaiting dismissal here would stall the serialized
      // write chain behind user input.
      void this.confirmDialog.notice({
        title: 'Save failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private scheduleAutoSave(): void {
    if (!this.autoSaveEnabled()) return;
    // Suspended while the buffer disagrees with disk in a way only the user
    // can arbitrate — auto-saving would silently pick a winner.
    if (this.conflict() || this.deletedOnDisk()) return;
    this.clearAutoSaveTimer();
    this.autoSaveTimer = setTimeout(() => {
      this.autoSaveTimer = null;
      void this.flushDirtyBuffer();
    }, AUTO_SAVE_DEBOUNCE_MS);
  }

  private clearAutoSaveTimer(): void {
    if (this.autoSaveTimer !== null) {
      clearTimeout(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  private autoSaveEnabled(): boolean {
    return this.settings.editorAutoSave();
  }

  private async loadFile(path: string, token: number): Promise<void> {
    try {
      // Let any in-flight flush land first: switching away from a dirty file
      // (and quickly back) fires a write without awaiting it, and reading
      // before that write resolves would load stale pre-write content while
      // performWrite advances the dirty baseline past it.
      await this.writeChain;
      if (token !== this.loadToken) return;
      const content = await this.ipc.readFile(path);
      // A newer switch superseded this load — drop the stale content so a
      // slow read can never overwrite the buffer of the newer file.
      if (token !== this.loadToken) return;
      // Collapse any selection carried over from the previous document. The
      // minimal-change dispatch in applyContentToView maps selections through
      // the edit, so a selection inside a region both files happen to share
      // would survive the switch — and the debounced publish would resurrect
      // the just-cleared selection focus in a file the user never selected in.
      const isFileChange = this.loadedPath !== path;
      if (this.view && isFileChange) {
        this.view.dispatch({ selection: { anchor: 0 } });
        // Reset the frontmatter form to collapsed so every file opens with the
        // compact summary bar. Gated on an actual file-path change (the view is
        // reused across files, so a per-widget flag would leak the previous
        // file's expanded state); same-file disk reloads/merges go through
        // applyContentToView directly and are deliberately left untouched.
        this.view.dispatch({ effects: setFrontmatterCollapsed.of(true) });
      }
      this.loadedPath = path;
      // Arm the per-file selection/scroll restore (consumed once the view
      // holds this document; a pending reveal for this file outranks it).
      // The view is reused across files, so a genuine switch to a file with no
      // remembered position must reset scroll to the top — otherwise the new
      // document inherits the previous file's scroll offset. Synthesizing a
      // top-of-document pending state reuses the same restore plumbing
      // (requestMeasure timing + pending-reveal guard) as a cached restore.
      const cached = this.viewStateCache.get(normalizePath(path));
      this.pendingViewState = cached
        ? { ...cached, path }
        : isFileChange
          ? { path, selection: EditorSelection.single(0).toJSON(), topPos: 0 }
          : null;
      // Apply the document to the (reused) view directly, then sync the
      // signal — mirroring the disk-reconcile paths. Relying on the
      // mount/sync effect alone is unsafe: it only re-runs when the _content
      // signal VALUE changes, so opening a file whose content is byte-
      // identical to what the view currently shows (common with empty/
      // templated files) would leave the document unpopulated. applyContentToView
      // is a no-op when the view doesn't exist yet (first open, no host) — the
      // effect + ensureView still cover that case — and when the text already
      // matches, so this is safe and idempotent in every path.
      this.applyContentToView(content);
      this._content.set(content);
      this._savedContent.set(content);
      this.resetDiskSyncState();
      // The view now holds this document, so the per-file view-state restore
      // and any pending reveal apply correctly here. (The mount/sync effect
      // also runs these whenever _content changed; both are guarded/idempotent.)
      this.consumePendingViewState();
      this.consumePendingReveal();
    } catch (err) {
      void this.confirmDialog.notice({
        title: 'Could not read file',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Clears all disk-sync state; used whenever the buffer changes files. */
  private resetDiskSyncState(): void {
    this.clearReconcileTimer();
    this.pendingUnlink = false;
    this.preDeleteBaseline = null;
    this.conflict.set(false);
    this.deletedOnDisk.set(false);
    this.clearMergeNoticeTimer();
    this.mergeNotice.set(null);
  }

  /** Routes watcher events for the loaded file into the debounced reconcile. */
  private onWatcherEvent(evt: FileChangeEvent): void {
    if (evt.type !== 'add' && evt.type !== 'change' && evt.type !== 'unlink') return;
    const loaded = this.loadedPath;
    if (!loaded || !samePath(evt.path, loaded)) return;
    this.pendingUnlink = evt.type === 'unlink';
    this.scheduleReconcile();
  }

  private scheduleReconcile(): void {
    this.clearReconcileTimer();
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      // reconcileWithDisk handles its own errors, so the chain never rejects.
      this.reconcileChain = this.reconcileChain.then(() => this.reconcileWithDisk());
    }, RECONCILE_DEBOUNCE_MS);
  }

  private clearReconcileTimer(): void {
    if (this.reconcileTimer !== null) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  /**
   * Brings the buffer back in sync after the loaded file changed on disk
   * (AI apply, external tools). Echoes of our own writes are filtered by
   * comparing disk against the saved baseline; real external changes are
   * adopted directly (clean buffer) or three-way merged (dirty buffer), and
   * overlapping edits surface the conflict banner instead of losing a side.
   */
  private async reconcileWithDisk(): Promise<void> {
    const path = this.loadedPath;
    if (!path) return;
    const token = this.loadToken;

    // Let an in-flight own write settle so we diff against final disk state.
    await this.writeChain;
    if (token !== this.loadToken || this.loadedPath !== path) return;

    const expectMissing = this.pendingUnlink;
    const chainBeforeRead = this.writeChain;
    let diskContent: string | null = null;
    try {
      diskContent = await this.ipc.readFile(path);
    } catch {
      diskContent = null;
    }
    if (token !== this.loadToken || this.loadedPath !== path) return;
    if (this.writeChain !== chainBeforeRead) {
      // An own write (auto-save timer firing, manual save) was enqueued while
      // we read disk, so the snapshot may predate it — and performWrite may
      // already have advanced the saved baseline past it. Diffing now could
      // adopt the stale snapshot into the buffer; re-run against settled disk.
      this.scheduleReconcile();
      return;
    }

    if (diskContent === null) {
      // Only a trailing unlink event means deletion; otherwise the read raced
      // a replace and the follow-up event re-runs the reconcile.
      if (expectMissing) this.enterDeletedState();
      return;
    }

    if (this.deletedOnDisk()) {
      // The file reappeared (recreated or renamed back): leave the deleted
      // state and reconcile against the pre-delete baseline.
      this.deletedOnDisk.set(false);
      this._savedContent.set(this.preDeleteBaseline ?? '');
      this.preDeleteBaseline = null;
      // Deletion suspended auto-save; re-arm it for surviving buffer edits so
      // they don't sit unsaved until the next keystroke. (scheduleAutoSave
      // declines while a pre-delete conflict is still open, and the conflict
      // path below re-clears the timer if the reappeared content overlaps.)
      if (this.isDirty()) this.scheduleAutoSave();
    }

    // Everything below is synchronous, so the captured buffer state cannot
    // be invalidated by user keystrokes mid-reconcile.
    const base = this._savedContent();
    if (diskContent === base) return; // own-write echo or no-op change

    const mine = this._content();
    if (mine === base || mine === diskContent) {
      // Clean buffer (or buffer already matching disk): adopt disk wholesale.
      this.applyContentToView(diskContent);
      this._content.set(diskContent);
      this._savedContent.set(diskContent);
      this.conflict.set(false);
      return;
    }

    const merged = threeWayMerge(base, mine, diskContent);
    if (merged.ok) {
      this.applyContentToView(merged.text);
      this._content.set(merged.text);
      this._savedContent.set(diskContent);
      if (!this.conflict()) {
        this.showMergeNotice('Merged changes from disk');
        // Dirty by exactly the user's edits now; converge back to disk.
        if (this.isDirty()) this.scheduleAutoSave();
      }
      return;
    }

    // Overlapping edits: keep the user's buffer untouched, record disk truth
    // as the baseline, and let the user arbitrate via the conflict banner.
    this._savedContent.set(diskContent);
    this.clearAutoSaveTimer();
    this.conflict.set(true);
  }

  private enterDeletedState(): void {
    if (this.deletedOnDisk()) return;
    this.clearAutoSaveTimer();
    this.preDeleteBaseline = this._savedContent();
    this._savedContent.set(DELETED_BASELINE);
    this.deletedOnDisk.set(true);
  }

  /** Conflict banner: keep the buffer; the next save overwrites disk. */
  keepMine(): void {
    this.conflict.set(false);
    if (this.isDirty()) this.scheduleAutoSave();
  }

  /** Conflict banner: discard buffer edits and adopt the on-disk content. */
  useDisk(): void {
    this.conflict.set(false);
    const disk = this._savedContent();
    this.applyContentToView(disk);
    this._content.set(disk);
  }

  /** Deleted banner: write the buffer back to disk, restoring the file. */
  async restoreDeleted(): Promise<void> {
    await this.save();
  }

  private showMergeNotice(text: string): void {
    this.clearMergeNoticeTimer();
    this.mergeNotice.set(text);
    this.mergeNoticeTimer = setTimeout(() => {
      this.mergeNoticeTimer = null;
      this.mergeNotice.set(null);
    }, MERGE_NOTICE_MS);
  }

  private clearMergeNoticeTimer(): void {
    if (this.mergeNoticeTimer !== null) {
      clearTimeout(this.mergeNoticeTimer);
      this.mergeNoticeTimer = null;
    }
  }

  private ensureView(host: HTMLDivElement): void {
    // Reuse a live view already mounted in THIS host. A view whose DOM is no
    // longer parented by `host` is an orphan (built against a host that was
    // then detached) — destroy it and rebuild in the live host, otherwise its
    // document would be dispatched into a detached editor and never render.
    if (this.view) {
      if (this.view.dom.parentElement === host) return;
      this.destroyView();
    }

    // Begin loading the code highlighter (no-op after the first call).
    ensureHighlighter();

    const state = EditorState.create({
      doc: this._content(),
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap]),
        // In-file find/replace: Ctrl/Cmd+F opens the panel (which includes the
        // replace row), Enter/Shift+Enter step through matches, Esc closes.
        // `top: true` docks the panel above the document instead of below it.
        // Panel chrome is themed in styles.css (.cm-panels / .cm-search).
        search({ top: true }),
        EditorView.lineWrapping,
        // GFM enables table, strikethrough, task-list and autolink parsing in
        // the lezer markdown grammar. Without it, table pipes (and ~~strike~~)
        // are parsed as plain text and the feature fields below have nothing to
        // decorate.
        markdown({ extensions: [GFM] }),
        // Live-preview core (codemirror-live-markdown 0.5.1-alpha.1)
        collapseOnSelectionFacet.of(true),
        mouseSelectingField,
        livePreviewPlugin,
        markdownStylePlugin,
        // GFM feature renderers — placed after the core live-preview plugins,
        // matching the package README. richTableField renders read-focused HTML
        // tables (source shown while the cursor is inside the table), rendering
        // inline markdown inside cells via marked.parseInline.
        richTableField,
        taskListField, // GFM task checkboxes (- [ ] / - [x]) — package has no task-list support
        // ```mermaid fences render as diagrams (mermaid-field.ts; mermaid is
        // lazy-loaded on first render). Prec.high + placement before
        // codeBlockField: the package field decorates every fence except
        // `math`, so it emits a competing block replace over mermaid fences —
        // overlapping replace decorations resolve by precedence, and the
        // diagram must win. In source mode both fields only emit line classes,
        // which coexist.
        // Leading YAML frontmatter renders as an inline property editor when the
        // cursor is outside it (frontmatter-field.ts). Prec.high so the form's
        // block replace, sitting at the very top of the document, out-prioritizes
        // any thematic-break/HR line decoration the live-markdown package emits
        // for the `---` delimiter lines. frontmatterCollapsedField holds the
        // summary-bar/expanded toggle (default collapsed) the form reads — it
        // must be registered for the form to find it.
        frontmatterCollapsedField,
        // Per-property VALUE autocomplete for the frontmatter form: the widget
        // reads this facet to suggest values already used for the SAME property
        // elsewhere in the vault (scoped + per-property via the doc-properties
        // index). Decoupled from Angular — the widget never imports a service.
        frontmatterValueSource.of((key) => this.frontmatterValueSuggestions(key)),
        Prec.high(frontmatterField),
        Prec.high(mermaidField),
        codeBlockField({ copyButton: true }),
        // In-repo replacement for the package's linkPlugin (see link-plugin.ts):
        // wikilinks navigate on click (create-on-confirm when unresolved) and
        // carry cm-wikilink-unresolved when their target doesn't exist.
        appLinkPlugin({
          isWikiTargetResolved: (raw) => {
            const { target } = splitWikiTarget(raw);
            // [[#Heading]] targets the active file itself — always resolved.
            return target === '' || isTargetResolvable(target, this.resolvableStems());
          },
          onWikiLinkClick: (raw) => {
            void this.wikilinkNav.open(raw);
          },
        }),
        // Typing `[[` offers the vault's markdown files (wikilink-autocomplete.ts).
        wikiLinkAutocomplete(() => this.wikiCompletionEntries()),
        imageField(),
        // Transient jump-to-line flash (AI citation navigation).
        revealLineExtension,
        editorTheme,
        this.appTheme,
        EditorView.updateListener.of((update) => {
          // Skip writes triggered by our own programmatic doc replacement;
          // only user edits should flow back into the signal.
          if (update.docChanged && !this.isApplyingExternal) {
            this._content.set(update.state.doc.toString());
            this.scheduleAutoSave();
          }
          // Selection publishing is debounced so drag-selection doesn't churn
          // the signal. Doc changes also re-publish: edits move or collapse
          // selections (including external applies, where CM maps the range),
          // and the timer reads settled view state when it fires.
          if (update.selectionSet || update.docChanged) {
            this.scheduleSelectionPublish();
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: host });
    this.view = view;

    // Required by codemirror-live-markdown: track drag-selection state so
    // decorations don't flicker / rebuild mid-drag.
    view.contentDOM.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('mouseup', this.onMouseUp);
  }

  /**
   * Vault-scoped, per-property value suggestions for the frontmatter form's
   * autocomplete (injected via the frontmatterValueSource facet). `key` is the
   * doc-properties index key the widget derives from the edited property's path
   * (e.g. `tags`, `status`, `author.name`). Resolves to `[]` when no vault is
   * open or IPC is unavailable, and swallows lookup failures — autocomplete is
   * additive and must never surface an error into the editor.
   */
  private frontmatterValueSuggestions(key: string): Promise<string[]> {
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath || !this.ipc.isAvailable) return Promise.resolve([]);
    return this.ipc.docPropertiesValues(vaultPath, key).catch(() => []);
  }

  // Single code path for programmatic content application. Dispatching only
  // the differing range (instead of replacing the whole document) lets
  // CodeMirror map the user's selection and scroll position through external
  // updates (disk reloads, merges). External applies are excluded from undo
  // history: with a reused view, a recorded file-switch replacement would let
  // Ctrl+Z resurrect the PREVIOUS file's content into this one (undo bleed) —
  // existing user edits are still mapped through the change and stay undoable.
  private applyContentToView(content: string): void {
    const view = this.view;
    if (!view) return;
    const change = computeMinimalChange(view.state.doc.toString(), content);
    if (!change) return;
    this.isApplyingExternal = true;
    try {
      view.dispatch({ changes: change, annotations: Transaction.addToHistory.of(false) });
    } finally {
      this.isApplyingExternal = false;
    }
  }

  /**
   * Snapshots the loaded file's selection + scroll into the per-file cache
   * (insertion-ordered LRU, capped). Called at the start of every switch,
   * before the view's document is replaced.
   */
  private captureViewState(): void {
    const view = this.view;
    const path = this.loadedPath;
    if (!view || !path) return;
    const key = normalizePath(path);
    // Resolve the doc position at the top edge of the viewport. precise:false
    // makes posAtCoords return a (clamped) number rather than null when the
    // point falls in padding/empty space.
    const rect = view.scrollDOM.getBoundingClientRect();
    const topPos = view.posAtCoords({ x: rect.left + 1, y: rect.top + 1 }, false);
    this.viewStateCache.delete(key);
    this.viewStateCache.set(key, {
      selection: view.state.selection.toJSON(),
      topPos,
    });
    if (this.viewStateCache.size > VIEW_STATE_CACHE_MAX) {
      const oldest = this.viewStateCache.keys().next().value;
      if (oldest !== undefined) this.viewStateCache.delete(oldest);
    }
  }

  /**
   * Restores the remembered selection + scroll once the target document is in
   * the view (same doc-sync guard as the pending reveal). A pending reveal
   * for this file wins: it places its own cursor and centers its own line, so
   * the remembered state is dropped instead of fighting it.
   */
  private consumePendingViewState(): void {
    const pending = this.pendingViewState;
    if (!pending) return;
    const view = this.view;
    const path = this.loadedPath;
    if (!view || !path) return;
    if (!samePath(pending.path, path)) {
      this.pendingViewState = null;
      return;
    }
    if (view.state.doc.toString() !== this._content()) return;
    this.pendingViewState = null;
    const reveal = this.editorNav.pendingReveal();
    if (reveal && samePath(reveal.filePath, path)) return;
    const docLen = view.state.doc.length;
    try {
      // The doc may have changed on disk since the state was captured (or the
      // JSON may be malformed); clamp every range and bail on parse failure.
      const stored = EditorSelection.fromJSON(pending.selection);
      const clamped = EditorSelection.create(
        stored.ranges.map((r) =>
          EditorSelection.range(Math.min(r.anchor, docLen), Math.min(r.head, docLen)),
        ),
        stored.mainIndex,
      );
      view.dispatch({ selection: clamped });
    } catch {
      // Unusable stored selection — scroll restore below still applies.
    }
    const topPos = Math.min(pending.topPos, docLen);
    // Use CM's scrollIntoView effect rather than writing scrollDOM.scrollTop:
    // it measures the real line around topPos and scrolls precisely, so the
    // restore is stable even while off-screen line heights are still estimated
    // (a raw scrollTop write clamps against a stale, estimated height).
    view.dispatch({ effects: EditorView.scrollIntoView(topPos, { y: 'start', yMargin: 0 }) });
  }

  /**
   * Applies a pending jump-to-line request once the target document is
   * actually in the view. Called from the mount/sync effect (which tracks the
   * pendingReveal signal, covering the file-already-open case) and from
   * loadFile (covering a switch between files with identical content, where
   * the content signal never changes). The doc-sync guard keeps a reveal from
   * firing against the PREVIOUS document while the target file's content has
   * yet to be applied to the view.
   */
  private consumePendingReveal(): void {
    const request = this.editorNav.pendingReveal();
    if (!request) return;
    const view = this.view;
    const path = this.loadedPath;
    if (!view || !path || !samePath(request.filePath, path)) return;
    if (view.state.doc.toString() !== this._content()) return;
    this.editorNav.consume(request);
    this.revealLine(request.line);
  }

  /**
   * Centers the given 1-based line (clamped to the document), places the
   * cursor at its start, and flashes the line. The flash decoration is
   * removed on a timer matching the fade duration — which under
   * prefers-reduced-motion is what ends the static (non-animated) highlight.
   */
  private revealLine(line: number): void {
    const view = this.view;
    if (!view) return;
    const doc = view.state.doc;
    const lineNo = Math.max(1, Math.min(Math.floor(line), doc.lines));
    const pos = doc.line(lineNo).from;
    this.clearRevealHighlightTimer();
    view.dispatch({
      selection: { anchor: pos },
      effects: [EditorView.scrollIntoView(pos, { y: 'center' }), setRevealHighlight.of(pos)],
    });
    // Navigation lands the user in the editor: focus makes the placed cursor
    // visible and keeps the keyboard-first flow (read, then edit) intact.
    view.focus();
    this.revealHighlightTimer = setTimeout(() => {
      this.revealHighlightTimer = null;
      this.view?.dispatch({ effects: setRevealHighlight.of(null) });
    }, REVEAL_HIGHLIGHT_MS);
  }

  private clearRevealHighlightTimer(): void {
    if (this.revealHighlightTimer !== null) {
      clearTimeout(this.revealHighlightTimer);
      this.revealHighlightTimer = null;
    }
  }

  private destroyView(): void {
    const view = this.view;
    if (!view) return;
    this.clearSelectionPublishTimer();
    this.clearRevealHighlightTimer();
    this.editorSelection.clear();
    view.contentDOM.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('mouseup', this.onMouseUp);
    view.destroy();
    this.view = null;
  }

  private scheduleSelectionPublish(): void {
    this.clearSelectionPublishTimer();
    this.selectionPublishTimer = setTimeout(() => {
      this.selectionPublishTimer = null;
      this.publishSelection();
    }, SELECTION_PUBLISH_DEBOUNCE_MS);
  }

  private clearSelectionPublishTimer(): void {
    if (this.selectionPublishTimer !== null) {
      clearTimeout(this.selectionPublishTimer);
      this.selectionPublishTimer = null;
    }
  }

  /**
   * Publishes the current selection to EditorSelectionService, or clears it
   * when the selection is empty. Runs from the debounce timer, so it always
   * reads settled view state rather than a mid-drag intermediate.
   */
  private publishSelection(): void {
    // Defensive: never publish mid-external-apply (the flag is only true
    // synchronously during dispatch, so this should be unreachable from the
    // timer). The post-apply update schedules a fresh publish anyway.
    if (this.isApplyingExternal) return;
    const view = this.view;
    const path = this.loadedPath;
    if (!view || !path) {
      this.editorSelection.clear();
      return;
    }
    const range = view.state.selection.main;
    if (range.empty) {
      this.editorSelection.clear();
      return;
    }
    const doc = view.state.doc;
    // A selection ending exactly at a line start (full-line / triple-click
    // selections include the trailing newline) selects nothing on that line,
    // so report the previous line as the last selected one.
    const endPos =
      range.to > range.from && doc.lineAt(range.to).from === range.to
        ? range.to - 1
        : range.to;
    this.editorSelection.set({
      filePath: path,
      text: view.state.sliceDoc(range.from, range.to),
      from: range.from,
      to: range.to,
      startLine: doc.lineAt(range.from).number,
      endLine: doc.lineAt(endPos).number,
    });
  }

  private readonly onMouseDown = (): void => {
    this.view?.dispatch({ effects: setMouseSelecting.of(true) });
  };

  private readonly onMouseUp = (): void => {
    requestAnimationFrame(() => {
      this.view?.dispatch({ effects: setMouseSelecting.of(false) });
    });
  };

  // Dark theme matching the SpecForge palette. This is a prose editor now,
  // so .cm-content uses the app sans/system font; code uses --font-mono.
  private readonly appTheme = EditorView.theme(
    {
      '&': {
        height: '100%',
        backgroundColor: 'var(--color-surface-0)',
        color: 'var(--color-text-primary)',
      },
      '.cm-scroller': {
        overflow: 'auto',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        lineHeight: '1.6',
        padding: '1.5rem 2rem',
      },
      '.cm-content': {
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: '16px',
        caretColor: 'var(--color-accent-hover)',
        maxWidth: '900px',
      },
      '.cm-line': {
        padding: '0 2px',
      },
      '&.cm-focused': {
        outline: 'none',
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: 'var(--color-accent-hover)',
      },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection':
        {
          backgroundColor: 'rgba(99, 102, 241, 0.3)',
        },
      '.cm-gutters': {
        backgroundColor: 'var(--color-surface-0)',
        color: 'var(--color-text-muted)',
        border: 'none',
      },
      // Inline code + code blocks use the monospace stack.
      '.cm-code, .cm-inline-code, code, .cm-codeblock': {
        fontFamily: 'var(--font-mono)',
        fontSize: '0.9em',
      },
    },
    { dark: true },
  );
}
