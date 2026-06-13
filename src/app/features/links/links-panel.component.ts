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
import type { BacklinkRef, OutgoingLinkRef } from '../../shared/types';
import { fromVaultRel, toVaultRel } from '../../shared/vault-paths';

/**
 * Coalesce bursty watcher events into one re-query. Backlinks change when
 * OTHER files change, so the panel listens to every watcher event — and the
 * main-process indexer re-indexes a changed file on its own 500ms debounce
 * (indexer.ts DEBOUNCE_MS), so this delay must stay comfortably above that
 * or the final event of a burst would read the pre-update index and leave
 * the panel one edit behind.
 */
const RELOAD_DEBOUNCE_MS = 800;

/** A backlink plus its source file's display name (derived once per load). */
interface BacklinkRow {
  ref: BacklinkRef;
  fileName: string;
}

/**
 * Wikilink connections of the active file (left-sidebar Links view,
 * Obsidian-style): "Linked mentions" lists files whose links resolve TO the
 * active file; "Outgoing links" lists the active file's own wikilinks with
 * their resolved state (unresolved targets echo the editor's quiet dashed
 * underline and are inert). Data comes from the main-process link index,
 * refreshed as files are (re)indexed — the watcher plus auto-save make it
 * near-live.
 */
@Component({
  selector: 'app-links-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex h-full flex-col bg-surface-1 text-text-primary">
      <div class="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-text-secondary">Links</h2>
      </div>

      @if (!activeFile()) {
        <div class="px-3 py-3 text-xs text-text-muted">No file open. Open a file to see its links.</div>
      } @else {
        <div
          class="truncate border-b border-border-subtle px-3 py-1.5 font-mono text-sm text-text-muted"
          [title]="activeFile() ?? ''">
          {{ fileName() }}
        </div>
        @if (backlinks().length === 0 && outgoing().length === 0) {
          <div class="px-3 py-3 text-xs text-text-muted">No links in or out of this file yet.</div>
        } @else {
          <div class="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
            <h3 class="px-2 pb-0.5 pt-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
              Linked mentions · {{ backlinks().length }}
            </h3>
            @if (backlinks().length === 0) {
              <div class="px-2 py-1 text-xs text-text-muted">No other file links here.</div>
            } @else {
              @for (row of backlinkRows(); track $index) {
                <button
                  type="button"
                  class="block w-full rounded px-2 py-1 text-left transition-colors hover:bg-surface-2"
                  [title]="row.ref.sourceRelPath + ' · line ' + row.ref.line"
                  (click)="openBacklink(row.ref)">
                  <span class="flex items-baseline gap-2">
                    <span class="min-w-0 shrink truncate text-sm font-medium text-text-primary">{{ row.fileName }}</span>
                    <span class="min-w-0 shrink-[9999] truncate text-xs text-text-muted">{{ row.ref.sourceRelPath }}</span>
                  </span>
                  <span class="flex items-baseline gap-2 text-xs text-text-muted">
                    <span class="min-w-0 truncate font-mono">[[{{ row.ref.targetRaw }}]]</span>
                    <span class="ml-auto shrink-0">{{ row.ref.line }}</span>
                  </span>
                </button>
              }
            }

            <h3 class="px-2 pb-0.5 pt-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
              Outgoing links · {{ outgoing().length }}
            </h3>
            @if (outgoing().length === 0) {
              <div class="px-2 py-1 text-xs text-text-muted">No wikilinks in this file.</div>
            } @else {
              @for (link of outgoing(); track $index) {
                <button
                  type="button"
                  class="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left transition-colors"
                  [class]="link.targetRelPath === null ? 'cursor-default' : 'hover:bg-surface-2'"
                  [title]="link.targetRelPath === null ? 'Not created yet' : link.targetRelPath"
                  (click)="openOutgoing(link)">
                  <span
                    class="min-w-0 shrink truncate text-sm"
                    [class]="link.targetRelPath === null
                      ? 'text-text-muted underline decoration-dashed decoration-1 underline-offset-2'
                      : 'text-text-secondary'">
                    {{ link.targetRaw }}
                  </span>
                  <span class="ml-auto shrink-0 text-xs text-text-muted">{{ link.line }}</span>
                </button>
              }
            }
          </div>
        }
      }
    </div>
  `,
})
export class LinksPanelComponent {
  private readonly vault = inject(VaultService);
  private readonly ipc = inject(IpcService);
  private readonly editorNav = inject(EditorNavigationService);
  private readonly destroyRef = inject(DestroyRef);

  readonly activeFile = this.vault.activeFilePath;
  readonly backlinks = signal<BacklinkRef[]>([]);
  readonly outgoing = signal<OutgoingLinkRef[]>([]);

  readonly fileName = computed(() => {
    const path = this.activeFile();
    return path ? (path.split(/[\\/]/).pop() ?? path) : null;
  });

  readonly backlinkRows = computed<BacklinkRow[]>(() =>
    this.backlinks().map((ref) => ({
      ref,
      fileName: ref.sourceRelPath.split('/').pop() ?? ref.sourceRelPath,
    })),
  );

  /** Monotonic load id; a newer load (or file switch) drops stale results. */
  private loadSeq = 0;
  private reloadDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Reload immediately when the active file (or the vault) changes.
    effect(() => {
      this.activeFile();
      this.vault.vaultPath();
      untracked(() => void this.load());
    });

    // Near-live refresh: backlinks change when OTHER files are edited,
    // created, renamed or deleted, so listen to every watcher event (any
    // type, any path) rather than only events for the active file.
    if (this.ipc.isAvailable) {
      const unsubscribe = this.ipc.onFileChange(() => this.scheduleReload());
      this.destroyRef.onDestroy(unsubscribe);
    }

    this.destroyRef.onDestroy(() => {
      if (this.reloadDebounce) clearTimeout(this.reloadDebounce);
    });
  }

  protected openBacklink(ref: BacklinkRef): void {
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) return;
    this.editorNav.openFileAtLine(fromVaultRel(vaultPath, ref.sourceRelPath), ref.line);
  }

  /** Resolved targets open plainly; unresolved ones are a quiet no-op. */
  protected openOutgoing(link: OutgoingLinkRef): void {
    if (link.targetRelPath === null) return;
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) return;
    this.vault.setActiveFile(fromVaultRel(vaultPath, link.targetRelPath));
  }

  private scheduleReload(): void {
    if (this.reloadDebounce) clearTimeout(this.reloadDebounce);
    this.reloadDebounce = setTimeout(() => void this.load(), RELOAD_DEBOUNCE_MS);
  }

  private async load(): Promise<void> {
    const seq = ++this.loadSeq;
    const vaultPath = this.vault.vaultPath();
    const active = this.vault.activeFilePath();
    const rel = vaultPath !== null && active !== null ? toVaultRel(vaultPath, active) : null;
    if (vaultPath === null || rel === null || rel.length === 0 || !this.ipc.isAvailable) {
      this.backlinks.set([]);
      this.outgoing.set([]);
      return;
    }
    try {
      const [backlinks, outgoing] = await Promise.all([
        this.ipc.linksBacklinks(vaultPath, rel),
        this.ipc.linksOutgoing(vaultPath, rel),
      ]);
      if (seq !== this.loadSeq) return;
      this.backlinks.set(backlinks);
      this.outgoing.set(outgoing);
    } catch {
      // Deleted/unindexed file: empty lists are the correct quiet state.
      if (seq === this.loadSeq) {
        this.backlinks.set([]);
        this.outgoing.set([]);
      }
    }
  }
}
