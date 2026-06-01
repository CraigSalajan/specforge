import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SettingsService } from '../../core/settings.service';
import { UiStateService } from '../../core/ui-state.service';
import { VaultService } from '../../core/vault.service';
import { IndexService } from '../../core/index.service';
import { EmbeddingIndexerService } from '../ai/providers/indexing.service';
import type { Settings, Theme } from '../../shared/types';

@Component({
  selector: 'app-settings-modal',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (isOpen()) {
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        (click)="close()">
        <div
          class="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface-1 shadow-2xl"
          (click)="$event.stopPropagation()">
          <header class="flex items-center justify-between border-b border-border-subtle bg-surface-2 px-4 py-2.5">
            <div class="flex items-center gap-2">
              <h2 class="text-sm font-semibold tracking-wide text-text-primary">Settings</h2>
              @if (saving()) {
                <span class="text-xs text-text-muted">saving…</span>
              }
            </div>
            <button
              type="button"
              class="rounded px-2 py-0.5 text-sm text-text-muted hover:bg-surface-3 hover:text-text-primary"
              (click)="close()">×</button>
          </header>

          <div class="flex-1 overflow-y-auto px-5 py-4">
            <section class="mb-6">
              <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-text-muted">Workspace</h3>

              <div class="mb-3">
                <label class="mb-1 block text-xs text-text-secondary">Vault folder</label>
                <div class="flex gap-2">
                  <input
                    type="text"
                    readonly
                    class="flex-1 cursor-not-allowed rounded border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-xs text-text-secondary"
                    [value]="draftVaultPath() ?? '(none selected)'" />
                  <button
                    type="button"
                    class="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
                    (click)="onChangeVault()">Change…</button>
                </div>
                <p class="mt-1 text-xs text-text-muted">Markdown files in this folder are indexed locally.</p>
              </div>

              <div class="mb-3">
                <label class="mb-1 block text-xs text-text-secondary">Theme</label>
                <select
                  class="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none"
                  [ngModel]="draft().theme"
                  (ngModelChange)="patch({ theme: asTheme($event) })">
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>
              </div>
            </section>

            <section class="mb-6">
              <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-text-muted">AI Provider</h3>

              <div class="mb-3">
                <label class="mb-1 block text-xs text-text-secondary">Base URL</label>
                <input
                  type="text"
                  class="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-xs text-text-primary focus:border-accent focus:outline-none"
                  placeholder="https://api.openai.com/v1"
                  [ngModel]="draft()['ai.baseUrl']"
                  (ngModelChange)="patch({ 'ai.baseUrl': $event })" />
              </div>

              <div class="mb-3">
                <label class="mb-1 block text-xs text-text-secondary">API Key</label>
                <input
                  [type]="showApiKey() ? 'text' : 'password'"
                  class="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-xs text-text-primary focus:border-accent focus:outline-none"
                  placeholder="sk-…"
                  [ngModel]="draft()['ai.apiKey']"
                  (ngModelChange)="patch({ 'ai.apiKey': $event })" />
                <div class="mt-1 flex items-center justify-between">
                  <p class="text-xs text-text-muted">
                    Stored locally in the app database.
                  </p>
                  <button
                    type="button"
                    class="text-xs text-accent hover:text-accent-hover"
                    (click)="toggleApiKey()">{{ showApiKey() ? 'Hide' : 'Show' }}</button>
                </div>
              </div>

              <div class="mb-3 grid grid-cols-2 gap-3">
                <div>
                  <label class="mb-1 block text-xs text-text-secondary">Chat model</label>
                  <input
                    type="text"
                    class="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-xs text-text-primary focus:border-accent focus:outline-none"
                    placeholder="gpt-4o-mini"
                    [ngModel]="draft()['ai.chatModel']"
                    (ngModelChange)="patch({ 'ai.chatModel': $event })" />
                </div>
                <div>
                  <label class="mb-1 block text-xs text-text-secondary">Embedding model</label>
                  <input
                    type="text"
                    class="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-xs text-text-primary focus:border-accent focus:outline-none"
                    placeholder="text-embedding-3-small"
                    [ngModel]="draft()['ai.embeddingModel']"
                    (ngModelChange)="patch({ 'ai.embeddingModel': $event })" />
                </div>
              </div>

              <div class="mb-3 flex items-center justify-between rounded border border-border-subtle bg-surface-2 px-3 py-2">
                <div>
                  <div class="text-xs text-text-primary">Enable embeddings</div>
                  <div class="text-xs text-text-muted">Semantic search. Requires API key.</div>
                </div>
                <input
                  type="checkbox"
                  class="h-4 w-4 cursor-pointer"
                  [ngModel]="draft()['ai.embeddingsEnabled']"
                  (ngModelChange)="patch({ 'ai.embeddingsEnabled': $event })" />
              </div>

              <div class="mb-3 grid grid-cols-2 gap-3">
                <div>
                  <label class="mb-1 block text-xs text-text-secondary">Retrieval top-K</label>
                  <input
                    type="number"
                    min="1"
                    max="50"
                    class="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-xs text-text-primary focus:border-accent focus:outline-none"
                    [ngModel]="draft()['ai.topK']"
                    (ngModelChange)="patch({ 'ai.topK': asPositiveInt($event, 6) })" />
                  <p class="mt-1 text-xs text-text-muted">Chunks fed to the model per question.</p>
                </div>
                <div>
                  <label class="mb-1 block text-xs text-text-secondary">Max context chars</label>
                  <input
                    type="number"
                    min="500"
                    max="200000"
                    class="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-xs text-text-primary focus:border-accent focus:outline-none"
                    [ngModel]="draft()['ai.maxContextChars']"
                    (ngModelChange)="patch({ 'ai.maxContextChars': asPositiveInt($event, 12000) })" />
                  <p class="mt-1 text-xs text-text-muted">Truncates excerpts proportionally when over budget.</p>
                </div>
              </div>
            </section>

            <section class="mb-2">
              <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-text-muted">Index</h3>

              <div class="mb-3 flex items-center justify-between rounded border border-border-subtle bg-surface-2 px-3 py-2">
                <div>
                  <div class="text-xs text-text-primary">
                    {{ indexStatus().indexedFiles }} files · {{ indexStatus().totalChunks }} chunks
                  </div>
                  <div class="text-xs text-text-muted">
                    Last indexed: {{ lastIndexedLabel() }}
                  </div>
                </div>
                <button
                  type="button"
                  class="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                  [disabled]="!draftVaultPath() || isIndexing()"
                  (click)="onRebuildIndex()">
                  {{ isIndexing() ? 'Indexing…' : 'Rebuild index' }}
                </button>
              </div>

              <div class="flex items-center justify-between rounded border border-border-subtle bg-surface-2 px-3 py-2">
                <div>
                  <div class="text-xs text-text-primary">Embeddings</div>
                  @if (embeddingProgress().status === 'running') {
                    <div class="text-xs text-accent">
                      Embedding {{ embeddingProgress().processed }} / {{ embeddingProgress().total }} chunks…
                    </div>
                  } @else if (embeddingProgress().status === 'error') {
                    <div class="text-xs text-danger">{{ embeddingProgress().error }}</div>
                  } @else if (embeddingProgress().status === 'done') {
                    <div class="text-xs text-text-muted">
                      Indexed {{ embeddingProgress().processed }} chunks.
                    </div>
                  } @else {
                    <div class="text-xs text-text-muted">
                      Computes vectors for the active embedding model.
                    </div>
                  }
                </div>
                <button
                  type="button"
                  class="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                  [disabled]="!draftVaultPath() || !draft()['ai.embeddingsEnabled'] || embeddingIsRunning()"
                  (click)="onRebuildEmbeddings()">
                  {{ embeddingIsRunning() ? 'Embedding…' : 'Rebuild embeddings' }}
                </button>
              </div>
            </section>
          </div>

          <footer class="flex items-center justify-end gap-2 border-t border-border-subtle bg-surface-2 px-4 py-2.5">
            <button
              type="button"
              class="rounded px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary"
              (click)="close()">Cancel</button>
            <button
              type="button"
              class="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
              [disabled]="!isDirty() || saving()"
              (click)="onSave()">Save</button>
          </footer>
        </div>
      </div>
    }
  `,
})
export class SettingsModalComponent {
  private readonly settings = inject(SettingsService);
  private readonly ui = inject(UiStateService);
  private readonly vault = inject(VaultService);
  private readonly indexer = inject(IndexService);
  private readonly embeddingIndexer = inject(EmbeddingIndexerService);

  readonly isOpen = this.ui.settingsOpen;
  readonly saving = this.settings.saving;
  readonly indexStatus = this.indexer.status;
  readonly isIndexing = this.indexer.isIndexing;
  readonly embeddingProgress = this.embeddingIndexer.progress;
  readonly embeddingIsRunning = this.embeddingIndexer.isRunning;

  private readonly _draft = signal<Settings>(this.settings.settings());
  private readonly _draftVaultPath = signal<string | null>(this.settings.vaultPath());
  private readonly _initialJson = signal<string>(JSON.stringify(this.settings.settings()));
  private readonly _showApiKey = signal(false);

  readonly draft = this._draft.asReadonly();
  readonly draftVaultPath = this._draftVaultPath.asReadonly();
  readonly showApiKey = this._showApiKey.asReadonly();

  readonly isDirty = computed(() => JSON.stringify(this._draft()) !== this._initialJson());

  readonly lastIndexedLabel = computed(() => {
    const ts = this.indexStatus().lastIndexedAt;
    if (!ts) return 'never';
    return new Date(ts).toLocaleString();
  });

  private wasOpen = false;

  constructor() {
    // Snapshot settings into the draft on the rising edge of isOpen().
    // Reading the settings signals inside `untracked` prevents external
    // settings updates (e.g. the "Change Vault" button mutating the
    // settings store while the modal is open) from clobbering the draft.
    effect(() => {
      const open = this.isOpen();
      if (open && !this.wasOpen) {
        untracked(() => {
          const current = this.settings.settings();
          this._draft.set({ ...current });
          this._draftVaultPath.set(this.settings.vaultPath());
          this._initialJson.set(JSON.stringify(current));
          this._showApiKey.set(false);
        });
      }
      this.wasOpen = open;
    });
  }

  patch(partial: Partial<Settings>): void {
    this._draft.update((d) => ({ ...d, ...partial }));
  }

  asTheme(value: string): Theme {
    return value === 'light' ? 'light' : 'dark';
  }

  toggleApiKey(): void {
    this._showApiKey.update((v) => !v);
  }

  async onChangeVault(): Promise<void> {
    await this.vault.selectVault();
    const newPath = this.settings.vaultPath();
    this._draftVaultPath.set(newPath);
    // VaultService.loadVault already persisted the new vault path through
    // SettingsService, so reflect it in the draft baseline too — otherwise
    // the Save button would be "dirty" for a change the user can't revert
    // from this dialog.
    this._draft.update((d) => ({ ...d, vaultPath: newPath }));
    this._initialJson.update((prev) => {
      const parsed = JSON.parse(prev) as Settings;
      parsed.vaultPath = newPath;
      return JSON.stringify(parsed);
    });
  }

  async onRebuildIndex(): Promise<void> {
    await this.indexer.rebuild(this.settings.vaultPath());
  }

  async onRebuildEmbeddings(): Promise<void> {
    const vaultPath = this.settings.vaultPath();
    if (!vaultPath) return;
    // Persist any pending settings changes (e.g. enabling embeddings or
    // switching model) before starting the run so the indexer uses the
    // current config.
    if (this.isDirty()) {
      await this.settings.update(this._draft());
      this._initialJson.set(JSON.stringify(this._draft()));
    }
    await this.embeddingIndexer.rebuild(vaultPath);
  }

  asPositiveInt(value: unknown, fallback: number): number {
    const n =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number.parseInt(value, 10)
          : Number.NaN;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  }

  async onSave(): Promise<void> {
    await this.settings.update(this._draft());
    this._initialJson.set(JSON.stringify(this._draft()));
    this.close();
  }

  close(): void {
    this.ui.closeSettings();
  }
}
