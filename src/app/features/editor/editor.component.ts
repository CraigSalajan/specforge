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
import { IpcService } from '../../core/ipc.service';
import { richTableField } from './rich-table-field';

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

  readonly filePath = input<string | null>(null);

  readonly saved = output<{ path: string }>();

  private readonly editorHost = viewChild<ElementRef<HTMLDivElement>>('editorHost');

  private readonly _content = signal<string>('');
  private readonly _savedContent = signal<string>('');

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

  constructor() {
    // Reacts to filePath changes: load/clear the document buffer.
    effect(() => {
      const path = this.filePath();
      if (path) {
        void this.loadFile(path);
      } else {
        this._content.set('');
        this._savedContent.set('');
        this.destroyView();
      }
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
    this.destroyView();
  }

  @HostListener('window:keydown', ['$event'])
  onKeydown(evt: KeyboardEvent): void {
    if ((evt.ctrlKey || evt.metaKey) && evt.key.toLowerCase() === 's') {
      evt.preventDefault();
      void this.save();
    }
  }

  async save(): Promise<void> {
    const path = this.filePath();
    if (!path) return;
    if (!this.isDirty()) return;
    const content = this._content();
    try {
      await this.ipc.writeFile(path, content);
      this._savedContent.set(content);
      this.saved.emit({ path });
    } catch (err) {
      window.alert('Failed to save: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  private async loadFile(path: string): Promise<void> {
    try {
      const content = await this.ipc.readFile(path);
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
