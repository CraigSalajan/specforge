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
import { ToolRegistryService } from '../ai/tools/tool-registry.service';
import { SkillRegistryService } from '../ai/skills/skill-registry.service';
import { IpcService } from '../../core/ipc.service';
import type { Settings, SkillMeta, Theme } from '../../shared/types';

type SettingsSection = 'workspace' | 'ai' | 'index' | 'tools' | 'skills';

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
          class="flex h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface-1 shadow-2xl"
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

          <div class="flex min-h-0 flex-1">
            <nav class="flex w-44 shrink-0 flex-col gap-0.5 border-r border-border-subtle bg-surface-2 p-2">
              @for (item of sections; track item.id) {
                <button
                  type="button"
                  class="w-full rounded px-3 py-1.5 text-left text-sm transition-colors"
                  [class.bg-surface-3]="activeSection() === item.id"
                  [class.text-text-primary]="activeSection() === item.id"
                  [class.text-text-secondary]="activeSection() !== item.id"
                  [class.hover:bg-surface-3]="activeSection() !== item.id"
                  [class.hover:text-text-primary]="activeSection() !== item.id"
                  [attr.aria-current]="activeSection() === item.id ? 'page' : null"
                  (click)="activeSection.set(item.id)">{{ item.label }}</button>
              }
            </nav>

            <div class="min-h-0 flex-1 overflow-y-auto bg-surface-1 px-5 py-4">
            @if (activeSection() === 'workspace') {
            <section>
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

              <div class="mb-3 flex items-center justify-between rounded border border-border-subtle bg-surface-2 px-3 py-2">
                <div>
                  <div class="text-xs text-text-primary">Auto-save</div>
                  <div class="text-xs text-text-muted">Save changes automatically after you stop typing and when switching files. When off, you are prompted before unsaved changes would be lost.</div>
                </div>
                <input
                  type="checkbox"
                  class="h-4 w-4 cursor-pointer"
                  [ngModel]="draft()['editor.autoSave']"
                  (ngModelChange)="patch({ 'editor.autoSave': $event })" />
              </div>
            </section>
            }

            @if (activeSection() === 'ai') {
            <section>
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

              <div class="mb-3 flex items-center justify-between rounded border border-border-subtle bg-surface-2 px-3 py-2">
                <div>
                  <div class="text-xs text-text-primary">Enable AI tools</div>
                  <div class="text-xs text-text-muted">Let the assistant create markdown files via function calling. Each write is confirmed.</div>
                </div>
                <input
                  type="checkbox"
                  class="h-4 w-4 cursor-pointer"
                  [ngModel]="draft()['ai.toolsEnabled']"
                  (ngModelChange)="patch({ 'ai.toolsEnabled': $event })" />
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
            }

            @if (activeSection() === 'index') {
            <section>
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
            }

            @if (activeSection() === 'tools') {
            <section>
              <h3 class="mb-1 text-xs font-semibold uppercase tracking-wider text-text-muted">Tools</h3>
              <p class="mb-3 text-xs text-text-muted">Enable or disable individual tools the assistant can use.</p>

              @for (tool of toolList; track tool.name) {
                <div class="mb-2 flex items-center justify-between rounded border border-border-subtle bg-surface-2 px-3 py-2">
                  <label
                    class="flex-1 cursor-pointer pr-3"
                    [attr.for]="'tool-' + tool.name">
                    <div class="font-mono text-xs text-text-primary">{{ tool.name }}</div>
                    @if (tool.schema.function.description) {
                      <div class="text-xs text-text-muted">{{ tool.schema.function.description }}</div>
                    }
                  </label>
                  <input
                    type="checkbox"
                    class="h-4 w-4 cursor-pointer"
                    [id]="'tool-' + tool.name"
                    [checked]="!draft()['ai.disabledTools'].includes(tool.name)"
                    (change)="toggleTool(tool.name, $any($event.target).checked)" />
                </div>
              } @empty {
                <p class="text-xs text-text-muted">No tools are registered.</p>
              }
            </section>
            }

            @if (activeSection() === 'skills') {
            <section>
              <h3 class="mb-1 text-xs font-semibold uppercase tracking-wider text-text-muted">Skills</h3>
              <p class="mb-3 text-xs text-text-muted">Specialized instruction sets the assistant can load on demand. Global skills are shared; vault skills live inside the open vault; custom skills come from the directories you add below.</p>

              <div class="mb-3 flex items-center justify-between rounded border border-border-subtle bg-surface-2 px-3 py-2">
                <div>
                  <div class="text-xs text-text-primary">Enable skills</div>
                  <div class="text-xs text-text-muted">Advertise available skills to the assistant so it can load their instructions.</div>
                </div>
                <input
                  type="checkbox"
                  class="h-4 w-4 cursor-pointer"
                  [ngModel]="draft()['skills.enabled']"
                  (ngModelChange)="patch({ 'skills.enabled': $event })" />
              </div>

              <div class="mb-3">
                <label class="mb-1 block text-xs text-text-secondary">Skill directories</label>
                @for (dir of draft()['skills.directories']; track dir) {
                  <div class="mb-1.5 flex items-center gap-2">
                    <input
                      type="text"
                      readonly
                      class="flex-1 cursor-not-allowed rounded border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-xs text-text-secondary"
                      [value]="dir" />
                    <button
                      type="button"
                      class="rounded px-2 py-0.5 text-sm text-text-muted hover:bg-surface-3 hover:text-text-primary"
                      [attr.aria-label]="'Remove directory ' + dir"
                      (click)="removeSkillDirectory(dir)">×</button>
                  </div>
                }
                <button
                  type="button"
                  class="rounded border border-border-subtle bg-surface-2 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                  (click)="addSkillDirectory()">Add directory…</button>
                <p class="mt-1 text-xs text-text-muted">Extra folders scanned for skills, including nested subfolders. Applied on save.</p>
              </div>

              <div class="mb-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  class="rounded border border-border-subtle bg-surface-2 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                  (click)="reloadSkills()">Reload</button>
                <button
                  type="button"
                  class="rounded border border-border-subtle bg-surface-2 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                  (click)="openGlobalSkillsFolder()">Open global skills folder</button>
                <button
                  type="button"
                  class="rounded border border-border-subtle bg-surface-2 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:opacity-50"
                  [disabled]="!vault.vaultPath()"
                  (click)="openLocalSkillsFolder()">Open vault skills folder</button>
              </div>

              @if (!vault.vaultPath()) {
                <p class="mb-3 text-xs text-text-muted">Open a vault to manage local skills.</p>
              }

              @for (skill of skillRegistry.skills(); track skill.origin + ':' + skill.name) {
                <div class="mb-2 flex items-center justify-between rounded border border-border-subtle bg-surface-2 px-3 py-2">
                  <label
                    class="flex-1 cursor-pointer pr-3"
                    [attr.for]="'skill-' + skill.origin + '-' + skill.name">
                    <div class="flex items-center gap-2">
                      <span class="font-mono text-xs text-text-primary">{{ skill.name }}</span>
                      <span
                        class="rounded border border-border-subtle bg-surface-2 px-1.5 text-xs text-text-muted"
                        [title]="skill.dir">
                        {{ originLabel(skill.origin) }}
                      </span>
                    </div>
                    @if (skill.description) {
                      <div class="text-xs text-text-muted">{{ skill.description }}</div>
                    }
                  </label>
                  <input
                    type="checkbox"
                    class="h-4 w-4 cursor-pointer"
                    [id]="'skill-' + skill.origin + '-' + skill.name"
                    [checked]="isSkillEnabledInDraft(skill)"
                    (change)="toggleSkill(skill, $any($event.target).checked)" />
                </div>
              } @empty {
                <p class="text-xs text-text-muted">No skills found.</p>
              }
            </section>
            }
            </div>
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
  protected readonly vault = inject(VaultService);
  private readonly indexer = inject(IndexService);
  private readonly embeddingIndexer = inject(EmbeddingIndexerService);
  private readonly toolRegistry = inject(ToolRegistryService);
  protected readonly skillRegistry = inject(SkillRegistryService);
  private readonly ipc = inject(IpcService);

  /** Tools are static after construction, so a plain readonly snapshot is fine. */
  readonly toolList = this.toolRegistry.list();

  readonly sections: ReadonlyArray<{ id: SettingsSection; label: string }> = [
    { id: 'workspace', label: 'Workspace' },
    { id: 'ai', label: 'AI Provider' },
    { id: 'index', label: 'Index' },
    { id: 'tools', label: 'Tools' },
    { id: 'skills', label: 'Skills' },
  ];

  readonly activeSection = signal<SettingsSection>('workspace');

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
          this.activeSection.set('workspace');
          // Refresh the skill list so the Skills section reflects what is on
          // disk right now (a skill could have been added since last open).
          void this.skillRegistry.reload();
        });
      }
      this.wasOpen = open;
    });
  }

  patch(partial: Partial<Settings>): void {
    this._draft.update((d) => ({ ...d, ...partial }));
  }

  /**
   * Toggles a tool's enabled state in the draft's disabled-tools list. We store
   * the DISABLED set, so enabling removes the name and disabling adds it. The
   * change flows through `patch` so it participates in the dirty/Save snapshot.
   */
  toggleTool(name: string, enabled: boolean): void {
    const current = this._draft()['ai.disabledTools'];
    const next = enabled
      ? current.filter((n) => n !== name)
      : current.includes(name)
        ? current
        : [...current, name];
    this.patch({ 'ai.disabledTools': next });
  }

  /** Human label for a skill's origin badge. */
  originLabel(origin: SkillMeta['origin']): string {
    if (origin === 'global') return 'Global';
    if (origin === 'user') return 'Custom';
    return 'Local';
  }

  /**
   * Whether a skill's checkbox should read as enabled, computed from the DRAFT
   * (not the registry's committed `enabled()`), so the checkbox state stays
   * consistent with what Save will persist. Global and user-directory skills
   * key off their disabled name arrays; local skills key off the per-vault map.
   */
  isSkillEnabledInDraft(skill: SkillMeta): boolean {
    if (skill.origin === 'global') {
      return !this._draft()['skills.disabledGlobal'].includes(skill.name);
    }
    if (skill.origin === 'user') {
      return !this._draft()['skills.disabledUser'].includes(skill.name);
    }
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) return true;
    const disabled = this._draft()['skills.disabledLocal'][vaultPath] ?? [];
    return !disabled.includes(skill.name);
  }

  /**
   * Toggles a skill's enabled state in the draft. Mirrors {@link toggleTool}:
   * we store the DISABLED set, so enabling removes the name and disabling adds
   * it. Global and user-directory skills are keyed by name; local skills are
   * scoped to the current vault path. Flows through `patch` so it participates
   * in the dirty/Save snapshot.
   */
  toggleSkill(skill: SkillMeta, enabled: boolean): void {
    if (skill.origin === 'global' || skill.origin === 'user') {
      const key = skill.origin === 'global' ? 'skills.disabledGlobal' : 'skills.disabledUser';
      const current = this._draft()[key];
      const next = enabled
        ? current.filter((n) => n !== skill.name)
        : current.includes(skill.name)
          ? current
          : [...current, skill.name];
      this.patch(key === 'skills.disabledGlobal'
        ? { 'skills.disabledGlobal': next }
        : { 'skills.disabledUser': next });
      return;
    }

    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) return;
    const map = this._draft()['skills.disabledLocal'];
    const current = map[vaultPath] ?? [];
    const updated = enabled
      ? current.filter((n) => n !== skill.name)
      : current.includes(skill.name)
        ? current
        : [...current, skill.name];
    const next: Record<string, string[]> = { ...map, [vaultPath]: updated };
    this.patch({ 'skills.disabledLocal': next });
  }

  /**
   * Opens the OS folder picker and appends the chosen directory to the draft's
   * skill-directory list (de-duplicated). Persisted on Save; the skills list
   * reloads then so newly discovered skills appear.
   */
  async addSkillDirectory(): Promise<void> {
    const dir = await this.ipc.selectDirectory();
    if (!dir) return;
    const current = this._draft()['skills.directories'];
    if (current.includes(dir)) return;
    this.patch({ 'skills.directories': [...current, dir] });
  }

  removeSkillDirectory(dir: string): void {
    const current = this._draft()['skills.directories'];
    this.patch({ 'skills.directories': current.filter((d) => d !== dir) });
  }

  async reloadSkills(): Promise<void> {
    await this.skillRegistry.reload();
  }

  async openGlobalSkillsFolder(): Promise<void> {
    await this.ipc.skillsOpenFolder('global');
  }

  async openLocalSkillsFolder(): Promise<void> {
    await this.ipc.skillsOpenFolder('local', this.vault.vaultPath() ?? undefined);
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
    const initial = JSON.parse(this._initialJson()) as Settings;
    const dirsChanged =
      JSON.stringify(initial['skills.directories']) !==
      JSON.stringify(this._draft()['skills.directories']);
    await this.settings.update(this._draft());
    this._initialJson.set(JSON.stringify(this._draft()));
    // Main reads skills.directories from the DB, so a directory change only
    // takes effect after the save above; refresh the discovered list now.
    if (dirsChanged) void this.skillRegistry.reload();
    this.close();
  }

  close(): void {
    this.ui.closeSettings();
  }
}
