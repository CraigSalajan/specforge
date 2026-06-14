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
import type { DocPropertyMatch } from '../../shared/types';
import { fromVaultRel } from '../../shared/vault-paths';

/**
 * Coalesce bursty watcher events into one re-query. The property index
 * changes when ANY file's frontmatter is edited, so the panel listens to
 * every watcher event — and the main-process indexer re-indexes a changed
 * file on its own 500ms debounce (indexer.ts DEBOUNCE_MS), so this delay must
 * stay comfortably above that or the final event of a burst would read the
 * pre-update index and leave the panel one edit behind.
 */
const RELOAD_DEBOUNCE_MS = 800;

/** Default property key — the canonical "spec status" frontmatter field. */
const DEFAULT_KEY = 'status';
/** Default value — so the panel opens on "all approved specs". */
const DEFAULT_VALUE = 'approved';

/** A property match plus its file's display name (derived once per load). */
interface DocResultRow {
  match: DocPropertyMatch;
  fileName: string;
}

/**
 * Filter vault documents by a YAML frontmatter property (left-sidebar Docs
 * view): pick a property key and a value and the list shows every file whose
 * frontmatter matches — the "show me all approved specs" capability. Data
 * comes from the main-process property index, refreshed as files are
 * (re)indexed, so the watcher plus auto-save keep it near-live.
 */
@Component({
  selector: 'app-docs-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex h-full flex-col bg-surface-1 text-text-primary">
      <div class="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-text-secondary">Docs</h2>
      </div>

      @if (keys().length === 0) {
        <div class="px-3 py-3 text-xs text-text-muted">No document properties indexed yet.</div>
      } @else {
        <div class="flex flex-col gap-2 border-b border-border-subtle p-2">
          <label class="flex flex-col gap-1">
            <span class="text-xs font-semibold uppercase tracking-wide text-text-muted">Property</span>
            <select
              aria-label="Property"
              class="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none"
              [value]="selectedKey()"
              (change)="onKeyChange($event)">
              @for (k of keys(); track k) {
                <option [value]="k">{{ k }}</option>
              }
            </select>
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-xs font-semibold uppercase tracking-wide text-text-muted">Value</span>
            <select
              aria-label="Value"
              class="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none disabled:opacity-50"
              [value]="selectedValue()"
              [disabled]="values().length === 0"
              (change)="onValueChange($event)">
              @for (v of values(); track v) {
                <option [value]="v">{{ v }}</option>
              }
            </select>
          </label>
        </div>

        @if (results().length === 0) {
          <div class="px-3 py-3 text-xs text-text-muted">No documents match.</div>
        } @else {
          <div class="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
            @for (row of resultRows(); track row.match.relPath) {
              <button
                type="button"
                class="block w-full rounded px-2 py-1 text-left transition-colors hover:bg-surface-2"
                [title]="row.match.relPath"
                (click)="openResult(row.match.relPath)">
                <span class="flex items-baseline gap-2">
                  <span class="min-w-0 shrink truncate text-sm font-medium text-text-primary">{{ row.fileName }}</span>
                  <span class="min-w-0 shrink-[9999] truncate text-xs text-text-muted">{{ row.match.relPath }}</span>
                </span>
              </button>
            }
          </div>
        }
      }
    </div>
  `,
})
export class DocsPanelComponent {
  private readonly vault = inject(VaultService);
  private readonly ipc = inject(IpcService);
  private readonly editorNav = inject(EditorNavigationService);
  private readonly destroyRef = inject(DestroyRef);

  readonly keys = signal<string[]>([]);
  readonly selectedKey = signal<string>('');
  readonly values = signal<string[]>([]);
  readonly selectedValue = signal<string>('');
  readonly results = signal<DocPropertyMatch[]>([]);

  readonly resultRows = computed<DocResultRow[]>(() =>
    this.results().map((match) => ({
      match,
      fileName: match.relPath.split('/').pop() ?? match.relPath,
    })),
  );

  /** Monotonic load id; a newer load (selection or vault switch) drops stale results. */
  private loadSeq = 0;
  private reloadDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Reload the full cascade when the vault changes (switch or close).
    effect(() => {
      this.vault.vaultPath();
      untracked(() => void this.loadKeys());
    });

    // Near-live refresh: the property index changes when ANY file's
    // frontmatter is edited, created, renamed or deleted, so listen to every
    // watcher event rather than only events for one file.
    if (this.ipc.isAvailable) {
      const unsubscribe = this.ipc.onFileChange(() => this.scheduleReload());
      this.destroyRef.onDestroy(unsubscribe);
    }

    this.destroyRef.onDestroy(() => {
      if (this.reloadDebounce) clearTimeout(this.reloadDebounce);
    });
  }

  protected onKeyChange(event: Event): void {
    this.selectedKey.set((event.target as HTMLSelectElement).value);
    void this.loadValues();
  }

  protected onValueChange(event: Event): void {
    this.selectedValue.set((event.target as HTMLSelectElement).value);
    void this.runQuery();
  }

  protected openResult(relPath: string): void {
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) return;
    this.editorNav.openFileAtLine(fromVaultRel(vaultPath, relPath), 1);
  }

  private scheduleReload(): void {
    if (this.reloadDebounce) clearTimeout(this.reloadDebounce);
    this.reloadDebounce = setTimeout(() => void this.reload(), RELOAD_DEBOUNCE_MS);
  }

  /**
   * Re-run the whole cascade after a watcher event, preserving the user's
   * current key/value selection where it still exists in the fresh index.
   */
  private async reload(): Promise<void> {
    const seq = ++this.loadSeq;
    const vaultPath = this.vault.vaultPath();
    if (vaultPath === null || !this.ipc.isAvailable) {
      this.resetAll();
      return;
    }
    try {
      const keys = await this.ipc.docPropertiesKeys(vaultPath);
      if (seq !== this.loadSeq) return;
      this.keys.set(keys);
      const key = keys.includes(this.selectedKey()) ? this.selectedKey() : this.pickKey(keys);
      this.selectedKey.set(key);
      if (key === '') {
        this.values.set([]);
        this.selectedValue.set('');
        this.results.set([]);
        return;
      }

      const values = await this.ipc.docPropertiesValues(vaultPath, key);
      if (seq !== this.loadSeq) return;
      this.values.set(values);
      const value = values.includes(this.selectedValue())
        ? this.selectedValue()
        : this.pickValue(values);
      this.selectedValue.set(value);
      if (value === '') {
        this.results.set([]);
        return;
      }

      const results = await this.ipc.docPropertiesQuery(vaultPath, key, value);
      if (seq !== this.loadSeq) return;
      this.results.set(results);
    } catch {
      // Unindexed/empty vault: empty lists are the correct quiet state.
      if (seq === this.loadSeq) this.resetAll();
    }
  }

  /** Loads property keys, then cascades into values and the query. */
  private async loadKeys(): Promise<void> {
    const seq = ++this.loadSeq;
    const vaultPath = this.vault.vaultPath();
    if (vaultPath === null || !this.ipc.isAvailable) {
      this.resetAll();
      return;
    }
    try {
      const keys = await this.ipc.docPropertiesKeys(vaultPath);
      if (seq !== this.loadSeq) return;
      this.keys.set(keys);
      const key = this.pickKey(keys);
      this.selectedKey.set(key);
      await this.loadValues(seq);
    } catch {
      if (seq === this.loadSeq) this.resetAll();
    }
  }

  /** Loads values for the selected key, then cascades into the query. */
  private async loadValues(seq = ++this.loadSeq): Promise<void> {
    const vaultPath = this.vault.vaultPath();
    const key = this.selectedKey();
    if (vaultPath === null || key === '' || !this.ipc.isAvailable) {
      this.values.set([]);
      this.selectedValue.set('');
      this.results.set([]);
      return;
    }
    try {
      const values = await this.ipc.docPropertiesValues(vaultPath, key);
      if (seq !== this.loadSeq) return;
      this.values.set(values);
      this.selectedValue.set(this.pickValue(values));
      await this.runQuery(seq);
    } catch {
      if (seq === this.loadSeq) {
        this.values.set([]);
        this.selectedValue.set('');
        this.results.set([]);
      }
    }
  }

  /** Runs the property query for the current key/value selection. */
  private async runQuery(seq = ++this.loadSeq): Promise<void> {
    const vaultPath = this.vault.vaultPath();
    const key = this.selectedKey();
    const value = this.selectedValue();
    if (vaultPath === null || key === '' || value === '' || !this.ipc.isAvailable) {
      this.results.set([]);
      return;
    }
    try {
      const results = await this.ipc.docPropertiesQuery(vaultPath, key, value);
      if (seq !== this.loadSeq) return;
      this.results.set(results);
    } catch {
      if (seq === this.loadSeq) this.results.set([]);
    }
  }

  /** Prefer the canonical `status` key, else the first key, else none. */
  private pickKey(keys: string[]): string {
    if (keys.includes(DEFAULT_KEY)) return DEFAULT_KEY;
    return keys[0] ?? '';
  }

  /** Prefer the canonical `approved` value, else the first value, else none. */
  private pickValue(values: string[]): string {
    if (values.includes(DEFAULT_VALUE)) return DEFAULT_VALUE;
    return values[0] ?? '';
  }

  private resetAll(): void {
    this.keys.set([]);
    this.selectedKey.set('');
    this.values.set([]);
    this.selectedValue.set('');
    this.results.set([]);
  }
}
