import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { EditorNavigationService } from '../../core/editor-navigation.service';
import { IpcService } from '../../core/ipc.service';
import { VaultService } from '../../core/vault.service';
import { parseHeadings, type MarkdownHeading } from '../../shared/heading-parser';
import { samePath } from '../../shared/path-utils';

/** Coalesce bursty watcher events (rename-and-write saves) into one read. */
const RELOAD_DEBOUNCE_MS = 150;

/**
 * Live outline of the active file's headings (left-sidebar Outline view,
 * Obsidian-style). Reads disk truth via the vault read IPC — never the
 * editor buffer — and re-parses on active-file changes plus watcher change
 * events for that file. The editor auto-saves, so unsaved keystrokes show
 * up here after the next auto-save; that lag is accepted to keep this
 * panel fully decoupled from the editor.
 */
@Component({
  selector: 'app-outline-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex h-full flex-col bg-surface-1 text-text-primary">
      <div class="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-text-secondary">Outline</h2>
      </div>

      @if (!activeFile()) {
        <div class="px-3 py-3 text-xs text-text-muted">No file open. Open a file to see its headings.</div>
      } @else {
        <div
          class="truncate border-b border-border-subtle px-3 py-1.5 font-mono text-sm text-text-muted"
          [title]="activeFile() ?? ''">
          {{ fileName() }}
        </div>
        @if (headings().length === 0) {
          <div class="px-3 py-3 text-xs text-text-muted">No headings in this file.</div>
        } @else {
          <nav class="min-h-0 flex-1 overflow-y-auto px-1 py-1" aria-label="Document outline">
            @for (heading of headings(); track heading.line) {
              <button
                type="button"
                class="block w-full truncate rounded py-1 pr-2 text-left text-sm text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary"
                [class.font-medium]="heading.level === 1"
                [style.paddingLeft.px]="8 + (heading.level - 1) * 12"
                [title]="heading.text"
                (click)="onHeadingClick(heading)">
                {{ heading.text || '—' }}
              </button>
            }
          </nav>
        }
      }
    </div>
  `,
})
export class OutlinePanelComponent {
  private readonly vault = inject(VaultService);
  private readonly ipc = inject(IpcService);
  private readonly editorNav = inject(EditorNavigationService);
  private readonly destroyRef = inject(DestroyRef);

  readonly activeFile = this.vault.activeFilePath;
  readonly headings = signal<MarkdownHeading[]>([]);

  readonly fileName = computed(() => {
    const path = this.activeFile();
    return path ? (path.split(/[\\/]/).pop() ?? path) : null;
  });

  /** Monotonic load id; a newer load (or file switch) drops stale reads. */
  private loadSeq = 0;
  private reloadDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Re-parse whenever the active file changes.
    effect(() => {
      const path = this.activeFile();
      untracked(() => void this.load(path));
    });

    // Near-live refresh: the vault watcher broadcasts every disk write
    // (including the editor's auto-saves), so re-read when the active file
    // itself changes on disk. Additional subscribers are fine — the preload
    // bridge fans events out to every registered listener.
    if (this.ipc.isAvailable) {
      const unsubscribe = this.ipc.onFileChange((evt) => {
        if (evt.type !== 'change' && evt.type !== 'add') return;
        const active = this.vault.activeFilePath();
        if (!active || !samePath(evt.path, active)) return;
        this.scheduleReload(active);
      });
      this.destroyRef.onDestroy(unsubscribe);
    }

    this.destroyRef.onDestroy(() => {
      if (this.reloadDebounce) clearTimeout(this.reloadDebounce);
    });
  }

  protected onHeadingClick(heading: MarkdownHeading): void {
    const path = this.activeFile();
    if (path) this.editorNav.openFileAtLine(path, heading.line);
  }

  private scheduleReload(path: string): void {
    if (this.reloadDebounce) clearTimeout(this.reloadDebounce);
    this.reloadDebounce = setTimeout(() => void this.load(path), RELOAD_DEBOUNCE_MS);
  }

  private async load(path: string | null): Promise<void> {
    const seq = ++this.loadSeq;
    if (!path || !this.ipc.isAvailable) {
      this.headings.set([]);
      return;
    }
    try {
      const content = await this.ipc.readFile(path);
      if (seq !== this.loadSeq) return;
      this.headings.set(parseHeadings(content));
    } catch {
      // Deleted/unreadable file: an empty outline is the correct quiet state.
      if (seq === this.loadSeq) this.headings.set([]);
    }
  }
}
