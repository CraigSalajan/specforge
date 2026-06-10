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
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { GFM } from '@lezer/markdown';
import {
  codeBlockField,
  collapseOnSelectionFacet,
  editorTheme,
  imageField,
  initHighlighter,
  linkPlugin,
  livePreviewPlugin,
  markdownStylePlugin,
  mouseSelectingField,
  setMouseSelecting,
} from 'codemirror-live-markdown';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { IpcService } from '../../core/ipc.service';
import { PdfExportService } from '../../core/pdf-export.service';
import { SettingsService } from '../../core/settings.service';
import { richTableField } from './rich-table-field';
import { taskListField } from './task-list-field';

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

@Component({
  selector: 'app-editor',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex h-full flex-col bg-surface-0 text-text-primary">
      <div class="flex items-center justify-between border-b border-border-subtle bg-surface-1 px-3 py-2">
        <div class="flex items-center gap-2 truncate">
          @if (filePath()) {
            <span class="truncate text-xs font-mono text-text-secondary" [title]="filePath() ?? ''">{{ displayName() }}</span>
            @if (isDirty()) {
              <span class="h-1.5 w-1.5 rounded-full bg-accent" title="Unsaved changes"></span>
            }
          } @else {
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

      <div class="relative flex-1 overflow-hidden">
        @if (!filePath()) {
          <div class="flex h-full flex-col items-center justify-center gap-2 text-text-muted">
            <p class="text-sm">Select a file from the vault to start editing</p>
            <p class="text-xs">Ctrl+S to save · Markdown renders live as you type</p>
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

  readonly filePath = input<string | null>(null);

  readonly saved = output<{ path: string }>();

  private readonly editorHost = viewChild<ElementRef<HTMLDivElement>>('editorHost');

  private readonly _content = signal<string>('');
  private readonly _savedContent = signal<string>('');

  readonly exporting = signal(false);

  readonly isDirty = computed(() => this._content() !== this._savedContent());
  readonly displayName = computed(() => {
    const p = this.filePath();
    if (!p) return '';
    return p.split(/[\\/]/).pop() ?? p;
  });

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
    effect(() => {
      const host = this.editorHost()?.nativeElement;
      const content = this._content();
      if (!host) {
        // Host removed (file closed) — view is torn down by the filePath effect.
        return;
      }
      this.ensureView(host);
      this.applyContentToView(content);
    });
  }

  ngOnDestroy(): void {
    this.clearAutoSaveTimer();
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
    await this.flushDirtyBuffer();
  }

  async exportPdf(): Promise<void> {
    const path = this.filePath();
    if (!path || this.exporting()) return;
    this.exporting.set(true);
    try {
      const result = await this.pdfExport.exportMarkdown(this._content(), path);
      if (!result.success && !result.canceled) {
        window.alert('Failed to export PDF: ' + (result.error ?? 'Unknown error'));
      }
    } catch (err) {
      window.alert('Failed to export PDF: ' + (err instanceof Error ? err.message : String(err)));
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

    // Any pending debounced save is superseded: either we flush immediately
    // below, or the buffer is clean and there is nothing to write.
    this.clearAutoSaveTimer();

    const oldPath = this.loadedPath;
    const oldContent = this._content();
    const dirty = oldPath !== null && oldContent !== this._savedContent();

    if (dirty && oldPath !== nextPath) {
      if (this.autoSaveEnabled()) {
        // Fire-and-forget: the captured (path, content) pair keeps the write
        // consistent regardless of what loads into the buffer afterwards.
        void this.writeTo(oldPath, oldContent);
      } else {
        const fileName = oldPath.split(/[\\/]/).pop() ?? oldPath;
        const shouldSave = await this.confirmDialog.confirm({
          title: 'Unsaved changes',
          message: `You have unsaved changes in ${fileName}. Save them?`,
          confirmLabel: 'Save',
          cancelLabel: 'Discard',
        });
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
      }
      this.saved.emit({ path });
    } catch (err) {
      // Buffer and dirty state are left untouched, so nothing is lost and the
      // user can retry (manual save or the next auto-save attempt).
      window.alert('Failed to save: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  private scheduleAutoSave(): void {
    if (!this.autoSaveEnabled()) return;
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
      this.loadedPath = path;
      // Writing _content drives the mount/sync effect, which creates the view
      // (once the host has rendered) and dispatches the new document.
      this._content.set(content);
      this._savedContent.set(content);
    } catch (err) {
      window.alert('Failed to read file: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  private ensureView(host: HTMLDivElement): void {
    if (this.view) return;

    // Begin loading the code highlighter (no-op after the first call).
    ensureHighlighter();

    const state = EditorState.create({
      doc: this._content(),
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
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
        codeBlockField({ copyButton: true }),
        linkPlugin(),
        imageField(),
        editorTheme,
        this.appTheme,
        EditorView.updateListener.of((update) => {
          // Skip writes triggered by our own programmatic doc replacement;
          // only user edits should flow back into the signal.
          if (update.docChanged && !this.isApplyingExternal) {
            this._content.set(update.state.doc.toString());
            this.scheduleAutoSave();
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

  private applyContentToView(content: string): void {
    const view = this.view;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === content) return;
    this.isApplyingExternal = true;
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: content },
      });
    } finally {
      this.isApplyingExternal = false;
    }
  }

  private destroyView(): void {
    const view = this.view;
    if (!view) return;
    view.contentDOM.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('mouseup', this.onMouseUp);
    view.destroy();
    this.view = null;
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
