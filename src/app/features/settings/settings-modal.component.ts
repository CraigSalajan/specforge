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
import { FormsModule } from '@angular/forms';
import { SettingsService } from '../../core/settings.service';
import { UiStateService } from '../../core/ui-state.service';
import { VaultService } from '../../core/vault.service';
import { IndexService } from '../../core/index.service';
import { EmbeddingIndexerService } from '../ai/providers/indexing.service';
import { ToolRegistryService } from '../ai/tools/tool-registry.service';
import { SkillRegistryService } from '../ai/skills/skill-registry.service';
import { IpcService } from '../../core/ipc.service';
import { SyncService, SyncError } from '../../core/sync.service';
import { toAiErrorInfo } from '../ai/providers/ai-harness-error';
import type {
  AiModelInfo,
  LinearProject,
  LinearTeam,
  Settings,
  SkillMeta,
} from '../../shared/types';
import type { LabelInfo } from '../../../../electron/sync/adapter';
import {
  makeConnectionId,
  type LinearConnection,
} from '../../../../electron/sync/connection';

type SettingsSection = 'workspace' | 'ai' | 'index' | 'tools' | 'skills' | 'integrations';

/**
 * The transient, per-vault Integrations form state (TER-31). Kept separate from
 * the modal's global `draft()` because the connection model persists out-of-band
 * (immediately via `SettingsService.saveConnection`), not through the modal's
 * Save button — see `syncConnectionsIntoDraft`.
 */
interface IntegrationForm {
  /** User intent to enable the connection; persisted only once a connection exists. */
  enabled: boolean;
  /** Selected Linear team id (empty until the user picks one). */
  teamId: string;
  /** Optional selected project id (empty for "team only"). */
  projectId: string;
  /** Optional feature-label id (empty for none). */
  featureLabelId: string;
}

/** Connection lifecycle status for the Integrations panel. */
type IntegrationStatus = 'idle' | 'loading' | 'connected' | 'error';

const EMPTY_INTEGRATION_FORM: IntegrationForm = {
  enabled: false,
  teamId: '',
  projectId: '',
  featureLabelId: '',
};

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
                    Stored locally, encrypted with your OS keychain when available.
                  </p>
                  <button
                    type="button"
                    class="text-xs text-accent hover:text-accent-hover"
                    (click)="toggleApiKey()">{{ showApiKey() ? 'Hide' : 'Show' }}</button>
                </div>
              </div>

              <div class="mb-1 grid grid-cols-2 gap-3">
                <div>
                  <label class="mb-1 block text-xs text-text-secondary">Chat model</label>
                  @if (useManualChatEntry()) {
                    <input
                      type="text"
                      class="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-xs text-text-primary focus:border-accent focus:outline-none"
                      placeholder="gpt-4o-mini"
                      [ngModel]="draft()['ai.chatModel']"
                      (ngModelChange)="patch({ 'ai.chatModel': $event })" />
                  } @else {
                    <select
                      class="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-xs text-text-primary focus:border-accent focus:outline-none"
                      [ngModel]="draft()['ai.chatModel']"
                      (ngModelChange)="patch({ 'ai.chatModel': $event })">
                      @for (m of chatModelOptions(); track m.id) {
                        <option [value]="m.id">{{ m.id }}</option>
                      }
                    </select>
                  }
                </div>
                <div>
                  <label class="mb-1 block text-xs text-text-secondary">Embedding model</label>
                  @if (useManualEmbeddingEntry()) {
                    <input
                      type="text"
                      class="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-xs text-text-primary focus:border-accent focus:outline-none"
                      placeholder="text-embedding-3-small"
                      [ngModel]="draft()['ai.embeddingModel']"
                      (ngModelChange)="patch({ 'ai.embeddingModel': $event })" />
                  } @else {
                    <select
                      class="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-xs text-text-primary focus:border-accent focus:outline-none"
                      [ngModel]="draft()['ai.embeddingModel']"
                      (ngModelChange)="patch({ 'ai.embeddingModel': $event })">
                      @for (m of embeddingModelOptions(); track m.id) {
                        <option [value]="m.id">{{ m.id }}</option>
                      }
                    </select>
                  }
                </div>
              </div>

              <div class="mb-3 flex items-center gap-2">
                <button
                  type="button"
                  class="rounded border border-border-subtle bg-surface-2 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:opacity-50"
                  [disabled]="modelsLoading()"
                  (click)="refreshModels()">{{ modelsLoading() ? 'Loading…' : 'Refresh' }}</button>
                @if (modelsLoading()) {
                  <span class="text-xs text-accent">Loading models…</span>
                } @else if (modelsError()) {
                  <span class="text-xs text-danger">{{ modelsError() }}</span>
                } @else if (useManualModelEntry()) {
                  <span class="text-xs text-text-muted">Enter a model id manually.</span>
                } @else {
                  <span class="text-xs text-text-muted">Models from your provider's /models endpoint.</span>
                }
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
                <div>
                  <label class="mb-1 block text-xs text-text-secondary">Request timeout (seconds)</label>
                  <input
                    type="number"
                    min="0"
                    max="3600"
                    class="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-xs text-text-primary focus:border-accent focus:outline-none"
                    [ngModel]="draft()['ai.timeoutSeconds']"
                    (ngModelChange)="patch({ 'ai.timeoutSeconds': asNonNegativeInt($event, 30) })" />
                  <p class="mt-1 text-xs text-text-muted">Bounds connecting and the wait for the first token; larger values also extend mid-stream stall tolerance. 0 disables request timeouts.</p>
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

            @if (activeSection() === 'integrations') {
            <section>
              <h3 class="mb-3 text-xs font-semibold uppercase tracking-wider text-text-muted">Integrations</h3>

              @if (!vault.hasVault()) {
                <p class="text-xs text-text-muted">Open a vault to configure integrations.</p>
              } @else {
                <p class="mb-3 text-xs text-text-muted">
                  Connect SpecForge to a project-management tool to push your specs as
                  work items. Connections are stored per vault.
                </p>

                <div class="mb-3 flex items-center justify-between rounded border border-border-subtle bg-surface-2 px-3 py-2">
                  <div>
                    <div class="text-xs text-text-primary">Enable Linear</div>
                    <div class="text-xs text-text-muted">Allow pushing this vault's specs to Linear.</div>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    [attr.aria-checked]="intForm().enabled"
                    aria-label="Enable Linear"
                    (click)="toggleLinearEnabled(!intForm().enabled)"
                    class="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors focus:outline-none focus:ring-1 focus:ring-accent motion-reduce:transition-none"
                    [class.bg-accent]="intForm().enabled"
                    [class.border-accent]="intForm().enabled"
                    [class.bg-surface-3]="!intForm().enabled"
                    [class.border-border-subtle]="!intForm().enabled">
                    <span
                      class="inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform motion-reduce:transition-none"
                      [class.translate-x-4]="intForm().enabled"
                      [class.translate-x-0.5]="!intForm().enabled"></span>
                  </button>
                </div>

                <div class="mb-3">
                  <label class="mb-1 block text-xs text-text-secondary">Personal Access Token</label>
                  <input
                    [type]="showPat() ? 'text' : 'password'"
                    class="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-xs text-text-primary focus:border-accent focus:outline-none"
                    placeholder="lin_api_…"
                    [ngModel]="pat()"
                    (ngModelChange)="onPatInput($event)" />
                  <div class="mt-1 flex items-center justify-between">
                    <p class="text-xs text-text-muted">
                      @if (patConfigured() && pat().length === 0) {
                        A token is stored for this connection. Enter a new one only to replace it.
                      } @else {
                        Stored locally, encrypted with your OS keychain when available.
                      }
                    </p>
                    <button
                      type="button"
                      class="text-xs text-accent hover:text-accent-hover"
                      (click)="toggleShowPat()">{{ showPat() ? 'Hide' : 'Show' }}</button>
                  </div>
                </div>

                <div class="mb-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    class="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                    [disabled]="pat().length === 0 || intStatus() === 'loading'"
                    (click)="connectLinear()">
                    {{ intStatus() === 'loading' ? 'Connecting…' : 'Connect' }}
                  </button>
                  <button
                    type="button"
                    class="rounded border border-border-subtle bg-surface-2 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:opacity-50"
                    disabled
                    title="OAuth — coming soon (TER-33)">Connect with OAuth</button>
                  <span class="text-xs text-text-muted">OAuth — coming soon (TER-33)</span>
                </div>

                @if (intStatus() === 'error') {
                  <p class="mb-3 text-xs text-danger">{{ intError() }}</p>
                } @else if (intStatus() === 'connected') {
                  <p class="mb-3 text-xs text-accent">Connected.</p>
                }

                @if (teams().length > 0) {
                  <div class="mb-3">
                    <label class="mb-1 block text-xs text-text-secondary">Team</label>
                    <select
                      class="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-xs text-text-primary focus:border-accent focus:outline-none"
                      [ngModel]="intForm().teamId"
                      (ngModelChange)="onSelectTeam($event)">
                      <option value="">Select a team…</option>
                      @for (t of teams(); track t.id) {
                        <option [value]="t.id">{{ t.name }} ({{ t.key }})</option>
                      }
                    </select>
                  </div>
                }

                @if (intForm().teamId.length > 0) {
                  <div class="mb-3">
                    <label class="mb-1 block text-xs text-text-secondary">Project (optional)</label>
                    <select
                      class="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-xs text-text-primary focus:border-accent focus:outline-none"
                      [ngModel]="intForm().projectId"
                      (ngModelChange)="onSelectProject($event)">
                      <option value="">No project (team only)</option>
                      @for (p of projects(); track p.id) {
                        <option [value]="p.id">{{ p.name }}</option>
                      }
                    </select>
                  </div>

                  <div class="mb-3 flex items-center gap-2">
                    <button
                      type="button"
                      class="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                      [disabled]="intStatus() === 'loading'"
                      (click)="saveLinear()">Save &amp; validate</button>
                    @if (intStatus() === 'loading') {
                      <span class="text-xs text-accent">Validating…</span>
                    }
                  </div>
                }

                @if (labels().length > 0) {
                  <div class="mb-3">
                    <label class="mb-1 block text-xs text-text-secondary">Feature label (optional)</label>
                    <select
                      class="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-xs text-text-primary focus:border-accent focus:outline-none"
                      [ngModel]="intForm().featureLabelId"
                      (ngModelChange)="onSelectFeatureLabel($event)">
                      <option value="">No label</option>
                      @for (l of labels(); track l.id) {
                        <option [value]="l.id">{{ l.name }}</option>
                      }
                    </select>
                    <p class="mt-1 text-xs text-text-muted">Applied to Feature-level items pushed to Linear.</p>
                  </div>
                }

                @if (activeConnection()) {
                  <button
                    type="button"
                    class="rounded border border-border-subtle bg-surface-2 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                    (click)="disconnectLinear()">Disconnect</button>
                }
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
  private readonly sync = inject(SyncService);
  private readonly destroyRef = inject(DestroyRef);

  /** Tools are static after construction, so a plain readonly snapshot is fine. */
  readonly toolList = this.toolRegistry.list();

  readonly sections: ReadonlyArray<{ id: SettingsSection; label: string }> = [
    { id: 'workspace', label: 'Workspace' },
    { id: 'ai', label: 'AI Provider' },
    { id: 'index', label: 'Index' },
    { id: 'tools', label: 'Tools' },
    { id: 'skills', label: 'Skills' },
    { id: 'integrations', label: 'Integrations' },
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

  // --- Integrations (TER-31) -------------------------------------------------
  // Transient, NOT part of `draft()`: the connection model persists out-of-band
  // (immediately) via SettingsService.saveConnection, not the modal's Save. The
  // sub-draft (`_intForm`) holds the in-progress selection; the lists/status are
  // ephemeral UI state reset on vault switch and modal open.

  /** Write-only PAT input. Never read back from storage (PAT is write-only). */
  private readonly _pat = signal('');
  private readonly _showPat = signal(false);
  /** Whether a PAT is already stored for the active connection (status only). */
  private readonly _patConfigured = signal(false);
  private readonly _intStatus = signal<IntegrationStatus>('idle');
  private readonly _intError = signal<string | null>(null);
  private readonly _teams = signal<LinearTeam[]>([]);
  private readonly _projects = signal<LinearProject[]>([]);
  private readonly _labels = signal<LabelInfo[]>([]);
  private readonly _intForm = signal<IntegrationForm>({ ...EMPTY_INTEGRATION_FORM });

  readonly pat = this._pat.asReadonly();
  readonly showPat = this._showPat.asReadonly();
  readonly patConfigured = this._patConfigured.asReadonly();
  readonly intStatus = this._intStatus.asReadonly();
  readonly intError = this._intError.asReadonly();
  readonly teams = this._teams.asReadonly();
  readonly projects = this._projects.asReadonly();
  readonly labels = this._labels.asReadonly();
  readonly intForm = this._intForm.asReadonly();

  /**
   * The persisted Linear connection for the active vault, or `null` when none is
   * configured. Drives the Disconnect button and the connectionId computation.
   */
  readonly activeConnection = computed<LinearConnection | null>(() => {
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) return null;
    const conns = this.settings.connectionsForVault(vaultPath);
    const linear = conns.find((c): c is LinearConnection => c.provider === 'linear');
    return linear ?? null;
  });

  // Provider model list (TER-5). One shared list feeds both the chat and
  // embedding dropdowns; the fetch always reads the DRAFT base URL / key so it
  // probes the not-yet-saved config the user is editing.
  private readonly _models = signal<AiModelInfo[]>([]);
  private readonly _modelsLoading = signal(false);
  private readonly _modelsError = signal<string | null>(null);

  readonly modelsLoading = this._modelsLoading.asReadonly();
  readonly modelsError = this._modelsError.asReadonly();

  /** Monotonic token to discard responses from superseded fetches. */
  private modelsRequestToken = 0;
  /** Pending debounce timer for the auto-fetch effect. */
  private modelsDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Builds the option list for a model dropdown: the fetched models, plus a
   * synthetic entry for the currently-saved value when it is non-empty and not
   * already present, so the saved selection always stays selectable (AC3).
   */
  private withCurrent(current: string): AiModelInfo[] {
    const models = this._models();
    if (current.length > 0 && !models.some((m) => m.id === current)) {
      return [{ id: current }, ...models];
    }
    return models;
  }

  readonly chatModelOptions = computed(() => this.withCurrent(this._draft()['ai.chatModel'] ?? ''));
  readonly embeddingModelOptions = computed(() =>
    this.withCurrent(this._draft()['ai.embeddingModel'] ?? ''),
  );

  /**
   * The only draft fields the model fetch actually depends on, projected to a
   * single primitive so the auto-fetch effect's dependency narrows to these two
   * values (plus the section flag). Reading `_draft()` whole would re-run the
   * effect on every unrelated edit — top-K, timeout, max-context — re-arming the
   * debounce and re-hitting `/models`; a string keeps the default value equality
   * from notifying unless the base URL or key actually changes. A newline can't
   * appear in either field, so it is a safe delimiter.
   */
  private readonly modelFetchKey = computed(() => {
    const draft = this._draft();
    const baseUrl = (draft['ai.baseUrl'] ?? '').trim();
    const apiKey = draft['ai.apiKey'] ?? '';
    return `${baseUrl}\n${apiKey}`;
  });

  /**
   * Whether free-text entry must be used instead of a dropdown, evaluated per
   * field so a populated field never forces an empty dropdown on the other. We
   * fall back when the model list can't serve as a source of truth — the IPC
   * bridge is unavailable, a fetch errored, or that field has no options
   * (nothing fetched and nothing saved). This keeps Save working in every case.
   */
  private manualEntryFor(options: AiModelInfo[]): boolean {
    return !this.ipc.isAvailable || this._modelsError() !== null || options.length === 0;
  }

  readonly useManualChatEntry = computed(() => this.manualEntryFor(this.chatModelOptions()));
  readonly useManualEmbeddingEntry = computed(() =>
    this.manualEntryFor(this.embeddingModelOptions()),
  );

  /**
   * Drives the informational hint under the Refresh button. True when both
   * fields are in manual mode, i.e. there is no usable list at all.
   */
  readonly useManualModelEntry = computed(
    () => this.useManualChatEntry() && this.useManualEmbeddingEntry(),
  );

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
          // Reset any model list from a previous open so the dropdowns reflect
          // the freshly snapshotted draft. Bump the request token and drop any
          // pending debounce so an in-flight fetch from the previous open cannot
          // resolve after this reset and repopulate the cleared list.
          this.modelsRequestToken++;
          if (this.modelsDebounceTimer) {
            clearTimeout(this.modelsDebounceTimer);
            this.modelsDebounceTimer = null;
          }
          this._models.set([]);
          this._modelsError.set(null);
          this._modelsLoading.set(false);
          // Reset the transient Integrations state and reload the visible
          // connection for the active vault (mirrors `_showApiKey`'s reset).
          this.resetIntegrationState();
          void this.loadIntegrationConnection();
          // Refresh the skill list so the Skills section reflects what is on
          // disk right now (a skill could have been added since last open).
          void this.skillRegistry.reload();
        });
      }
      this.wasOpen = open;
    });

    // Reload the visible Integrations connection whenever the active vault
    // changes (switching vaults must show that vault's connection). Keyed on the
    // vault path; the reload itself runs untracked so reading other signals there
    // can't widen this effect's dependency set.
    effect(() => {
      this.vault.vaultPath();
      untracked(() => {
        this.resetIntegrationState();
        void this.loadIntegrationConnection();
      });
    });

    // Debounced auto-fetch of the provider model list. Depends only on the AI
    // section flag and `modelFetchKey` (base URL + API key) so unrelated draft
    // edits (e.g. timeout, top-K) don't re-trigger it. The actual fetch runs
    // inside `untracked` so reading other signals there can't widen the
    // dependency set and clobber this effect.
    effect(() => {
      const active = this.activeSection() === 'ai';
      const key = this.modelFetchKey();
      // key is `<baseUrl>\n<apiKey>`; an empty base URL leaves nothing before
      // the delimiter.
      const baseUrl = key.split('\n', 1)[0];
      if (!active) return;
      if (baseUrl.length === 0) {
        // No base URL to probe: clear any models fetched from a previous URL so
        // the dropdowns don't keep showing options that no longer apply.
        untracked(() => {
          this._models.set([]);
          this._modelsError.set(null);
        });
        return;
      }
      untracked(() => this.scheduleModelsFetch());
    });

    this.destroyRef.onDestroy(() => {
      if (this.modelsDebounceTimer) clearTimeout(this.modelsDebounceTimer);
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

  toggleApiKey(): void {
    this._showApiKey.update((v) => !v);
  }

  /** Re-fetches the model list immediately, bypassing the debounce. */
  refreshModels(): void {
    if (this.modelsDebounceTimer) {
      clearTimeout(this.modelsDebounceTimer);
      this.modelsDebounceTimer = null;
    }
    void this.fetchModels();
  }

  /** (Re)arms the ~400ms debounce that drives the auto-fetch. */
  private scheduleModelsFetch(): void {
    if (this.modelsDebounceTimer) clearTimeout(this.modelsDebounceTimer);
    this.modelsDebounceTimer = setTimeout(() => {
      this.modelsDebounceTimer = null;
      void this.fetchModels();
    }, 400);
  }

  /**
   * Fetches the provider's model list from the DRAFT base URL / key (never the
   * saved config) via the main process. Stale responses are discarded using a
   * monotonic request token so a slow earlier fetch can't overwrite a newer
   * one. Skips entirely when the draft base URL is empty or IPC is unavailable.
   */
  private async fetchModels(): Promise<void> {
    if (!this.ipc.isAvailable) return;
    const draft = this._draft();
    const baseUrl = (draft['ai.baseUrl'] ?? '').trim();
    if (baseUrl.length === 0) {
      // Nothing to fetch — drop any stale list so the dropdowns don't show
      // options from a base URL the user has since cleared.
      this._models.set([]);
      this._modelsError.set(null);
      return;
    }
    const apiKey = draft['ai.apiKey'] ?? '';
    const timeoutMs = (draft['ai.timeoutSeconds'] ?? 30) * 1000;

    const token = ++this.modelsRequestToken;
    this._modelsLoading.set(true);
    this._modelsError.set(null);
    try {
      const res = await this.ipc.aiListModels({ baseUrl, apiKey, timeoutMs });
      if (token !== this.modelsRequestToken) return;
      if (res.ok) {
        this._models.set(res.data.models);
      } else {
        this._models.set([]);
        this._modelsError.set(res.error.message);
      }
    } catch (err) {
      if (token !== this.modelsRequestToken) return;
      this._models.set([]);
      this._modelsError.set(toAiErrorInfo(err).message);
    } finally {
      if (token === this.modelsRequestToken) this._modelsLoading.set(false);
    }
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

  /** Coerces a numeric form value (number or decimal string) to a number. */
  private coerceNumber(value: unknown): number {
    return typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseInt(value, 10)
        : Number.NaN;
  }

  asPositiveInt(value: unknown, fallback: number): number {
    const n = this.coerceNumber(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  }

  asNonNegativeInt(value: unknown, fallback: number): number {
    const n = this.coerceNumber(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
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

  // --- Integrations (TER-31) -------------------------------------------------

  toggleShowPat(): void {
    this._showPat.update((v) => !v);
  }

  /** Mirrors `patch` for the transient PAT input — keeps it write-only. */
  onPatInput(value: string): void {
    this._pat.set(value);
  }

  /** Updates a subset of the integration sub-draft. */
  private patchIntForm(partial: Partial<IntegrationForm>): void {
    this._intForm.update((f) => ({ ...f, ...partial }));
  }

  /** Resets all transient Integrations UI/sub-draft state to empty. */
  private resetIntegrationState(): void {
    this._pat.set('');
    this._showPat.set(false);
    this._patConfigured.set(false);
    this._intStatus.set('idle');
    this._intError.set(null);
    this._teams.set([]);
    this._projects.set([]);
    this._labels.set([]);
    this._intForm.set({ ...EMPTY_INTEGRATION_FORM });
  }

  /**
   * Hydrates the sub-draft + PAT-configured flag from the active vault's
   * persisted Linear connection (if any). Leaves the transient lists empty —
   * the user re-enters/validates the PAT to repopulate teams/projects/labels,
   * since the PAT is write-only and cannot be read back.
   */
  private async loadIntegrationConnection(): Promise<void> {
    const conn = this.activeConnection();
    if (!conn) return;
    this._intForm.set({
      enabled: conn.enabled,
      teamId: conn.teamId,
      projectId: conn.projectId ?? '',
      featureLabelId: conn.featureLabelId ?? '',
    });
    if (this.ipc.isAvailable) {
      try {
        const configured = await this.ipc.connectionSecretStatus(conn.connectionId, 'pat');
        this._patConfigured.set(configured);
      } catch {
        this._patConfigured.set(false);
      }
    }
  }

  /**
   * Validates the entered PAT by discovering teams (TER-31). Requires a PAT in
   * the input. On success the team list populates and status becomes
   * `'connected'`; on failure the status is `'error'` and the message is shown.
   */
  async connectLinear(): Promise<void> {
    const pat = this._pat();
    if (pat.length === 0) return;
    if (!this.ipc.isAvailable) return;
    this._intStatus.set('loading');
    this._intError.set(null);
    try {
      const teams = await this.sync.listTeams(pat);
      this._teams.set(teams);
      this._intStatus.set('connected');
    } catch (err) {
      this._teams.set([]);
      this._intStatus.set('error');
      this._intError.set(this.toIntegrationMessage(err));
    }
  }

  /**
   * Selects a team and, when a PAT is present, discovers its projects. Clears any
   * previously-selected project so a stale id from another team can't persist.
   */
  async onSelectTeam(teamId: string): Promise<void> {
    this.patchIntForm({ teamId, projectId: '' });
    this._projects.set([]);
    const pat = this._pat();
    if (teamId.length === 0 || pat.length === 0 || !this.ipc.isAvailable) return;
    try {
      const projects = await this.sync.listProjects(pat, teamId);
      this._projects.set(projects);
    } catch (err) {
      this._intStatus.set('error');
      this._intError.set(this.toIntegrationMessage(err));
    }
  }

  onSelectProject(projectId: string): void {
    this.patchIntForm({ projectId });
  }

  /**
   * Persists the connection and validates the label path (TER-31). Computes the
   * identity-bearing connectionId from team+project; if a prior connection has a
   * different id (the team/project changed), removes it first (clearing its
   * stored secret). Saves the connection, stores the PAT when newly entered, then
   * fetches metadata to populate the feature-label picker.
   */
  async saveLinear(): Promise<void> {
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath || !this.vault.hasVault()) return;
    const form = this._intForm();
    if (form.teamId.length === 0) return;

    const projectId = form.projectId.length > 0 ? form.projectId : undefined;
    const id = makeConnectionId({ vaultPath, provider: 'linear', teamId: form.teamId, projectId });
    const existing = this.activeConnection();
    const idChanged = existing ? existing.connectionId !== id : true;

    // Credential guard: the stored secret is keyed on the connectionId, so the
    // "empty input = keep existing token" shortcut is only valid when the id is
    // unchanged AND a token is already configured for it. Whenever the id is new
    // — a brand-new connection OR a team/project change that churns the id (which
    // also clears the old id's secret below) — a fresh PAT is required, since a
    // write-only token can't be carried over to a different id. Without one we
    // would persist a connection that can never validate, so abort with a clear
    // error instead.
    const pat = this._pat();
    if (pat.length === 0 && (idChanged || !this._patConfigured())) {
      this._intStatus.set('error');
      this._intError.set('Enter a Personal Access Token before saving this connection.');
      return;
    }

    const conn: LinearConnection = {
      connectionId: id,
      provider: 'linear',
      enabled: true,
      authMode: 'pat',
      teamId: form.teamId,
      ...(projectId !== undefined ? { projectId } : {}),
      ...(form.featureLabelId.length > 0 ? { featureLabelId: form.featureLabelId } : {}),
    };

    // Persist (connection + secret) BEFORE validating: `testConnection` resolves
    // the credential main-side from the connectionId, so the secret must already
    // be stored under `id`. The whole flow — remove-on-churn, save, store-secret,
    // validate — runs under one try so any failure (not just validation) surfaces
    // as an error in the panel rather than escaping as an unhandled rejection.
    this._intStatus.set('loading');
    this._intError.set(null);
    try {
      // If the identity changed (team/project), drop the old connection + secret
      // first so a stale id (and its credential) can't linger.
      if (existing && idChanged) {
        await this.settings.removeConnection(vaultPath, existing.connectionId);
      }
      await this.settings.saveConnection(vaultPath, conn);

      // Store the PAT only when freshly entered (it is write-only; an empty input
      // when a token is already configured means "keep the existing one").
      if (pat.length > 0 && this.ipc.isAvailable) {
        await this.ipc.connectionSecretSet(id, 'pat', pat);
        this._patConfigured.set(true);
      }

      this.patchIntForm({ enabled: true });

      // Validate by fetching metadata; populate the feature-label picker (drop
      // label groups — they are containers, not applicable labels).
      const metadata = await this.sync.testConnection(id);
      this._labels.set((metadata.labels ?? []).filter((l) => !l.isGroup));
      this._intStatus.set('connected');
    } catch (err) {
      this._intStatus.set('error');
      this._intError.set(this.toIntegrationMessage(err));
    }

    this.syncConnectionsIntoDraft();
  }

  /**
   * Sets the feature label and persists it. `featureLabelId` is NOT part of the
   * connection identity, so this reuses the same id — no remove/re-add needed.
   */
  async onSelectFeatureLabel(labelId: string): Promise<void> {
    this.patchIntForm({ featureLabelId: labelId });
    const conn = this.activeConnection();
    const vaultPath = this.vault.vaultPath();
    if (!conn || !vaultPath) return;
    // Rebuild the connection so an empty selection omits `featureLabelId`
    // entirely (rather than persisting an explicit `undefined`). The label is
    // not part of the connection identity, so the connectionId is unchanged.
    const next: LinearConnection = {
      connectionId: conn.connectionId,
      provider: 'linear',
      enabled: conn.enabled,
      authMode: conn.authMode,
      teamId: conn.teamId,
      ...(conn.projectId !== undefined ? { projectId: conn.projectId } : {}),
      ...(labelId.length > 0 ? { featureLabelId: labelId } : {}),
    };
    await this.settings.saveConnection(vaultPath, next);
    this.syncConnectionsIntoDraft();
  }

  /**
   * Toggles the connection's enabled flag. When a connection exists the change is
   * persisted immediately; otherwise it is recorded as local intent only (applied
   * on the next save).
   */
  async toggleLinearEnabled(enabled: boolean): Promise<void> {
    this.patchIntForm({ enabled });
    const conn = this.activeConnection();
    const vaultPath = this.vault.vaultPath();
    if (!conn || !vaultPath) return;
    await this.settings.saveConnection(vaultPath, { ...conn, enabled });
    this.syncConnectionsIntoDraft();
  }

  /**
   * Removes the active connection (and, via SettingsService, its stored
   * credential), then resets all transient Integrations state.
   */
  async disconnectLinear(): Promise<void> {
    const conn = this.activeConnection();
    const vaultPath = this.vault.vaultPath();
    if (!conn || !vaultPath) return;
    await this.settings.removeConnection(vaultPath, conn.connectionId);
    this.resetIntegrationState();
    this.syncConnectionsIntoDraft();
  }

  /**
   * Re-syncs the persisted `pm.connections` into the modal's draft baseline so
   * the global Save button never clobbers the out-of-band connection writes (the
   * connection model persists immediately, not through Save).
   */
  private syncConnectionsIntoDraft(): void {
    const persisted = this.settings.settings()['pm.connections'];
    this._draft.update((d) => ({ ...d, 'pm.connections': persisted }));
    const baseline = JSON.parse(this._initialJson()) as Settings;
    baseline['pm.connections'] = persisted;
    this._initialJson.set(JSON.stringify(baseline));
  }

  /** Extracts a human-readable message from a SyncError (or any thrown value). */
  private toIntegrationMessage(err: unknown): string {
    if (err instanceof SyncError) return err.info.message;
    if (err instanceof Error) return err.message;
    return String(err);
  }

  close(): void {
    this.ui.closeSettings();
  }
}
