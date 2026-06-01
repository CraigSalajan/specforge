import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { marked } from 'marked';
import { diffLines } from 'diff';
import { AiOrchestratorService } from './ai-orchestrator.service';
import { FileChangeService } from './file-change.service';
import { VaultService } from '../../core/vault.service';
import { isSafeRelPath, sanitizeFilename } from './providers/path-utils';
import type { AiChangeType } from '../../shared/types';

interface DiffLine {
  kind: 'add' | 'remove' | 'context';
  text: string;
}

@Component({
  selector: 'app-file-change-proposal',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (proposal(); as p) {
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        (click)="onCancel()">
        <div
          #dialogPanel
          role="dialog"
          aria-modal="true"
          aria-labelledby="proposal-title"
          tabindex="-1"
          class="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface-1 shadow-2xl"
          (click)="$event.stopPropagation()"
          (keydown.escape)="onCancel()"
          (keydown.tab)="onTab($event)"
          (keydown.shift.tab)="onTab($event)">
          <header class="flex items-center justify-between border-b border-border-subtle bg-surface-2 px-4 py-2.5">
            <div class="flex items-center gap-2">
              <h2 id="proposal-title" class="text-sm font-semibold tracking-wide text-text-primary">Proposed change</h2>
              <span
                class="rounded-sm px-1.5 py-0.5 text-xs uppercase tracking-wider"
                [class.bg-emerald-600]="effectiveChangeType() === 'create'"
                [class.bg-amber-600]="effectiveChangeType() === 'edit'"
                [class.text-white]="true">{{ effectiveChangeType() }}</span>
            </div>
            <button
              type="button"
              aria-label="Close"
              class="rounded px-2 py-0.5 text-sm text-text-muted hover:bg-surface-3 hover:text-text-primary"
              (click)="onCancel()">×</button>
          </header>

          <div class="flex-1 overflow-y-auto px-5 py-4">
            <section class="mb-4">
              <label class="mb-1 block text-xs font-semibold uppercase tracking-wider text-text-muted">
                Target path
              </label>
              <div class="flex gap-2">
                <input
                  #pathInput
                  type="text"
                  class="flex-1 rounded border border-border-subtle bg-surface-2 px-2 py-1.5 font-mono text-xs text-text-primary focus:border-accent focus:outline-none"
                  [ngModel]="editedRelPath()"
                  (ngModelChange)="onPathChange($event)" />
              </div>
              @if (pathError(); as msg) {
                <p class="mt-1 text-sm text-danger">{{ msg }}</p>
              } @else if (collidesWithExisting() && effectiveChangeType() === 'create') {
                <p class="mt-1 text-sm text-amber-400">
                  A file already exists at this path. Choose a different filename or switch to "Edit".
                </p>
              } @else {
                <p class="mt-1 text-xs text-text-secondary">
                  Paths are relative to the vault root. {{ effectiveChangeType() === 'create' ? 'Folders are created as needed.' : '' }}
                </p>
              }
            </section>

            @if (effectiveChangeType() === 'edit') {
              <section class="mb-4">
                <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-text-muted">Diff</h3>
                <div class="diff-host max-h-[40vh] overflow-y-auto rounded border border-border-subtle bg-surface-2 px-3 py-2 font-mono text-sm leading-snug">
                  @for (line of diff(); track $index) {
                    <div
                      class="diff-line"
                      [class.bg-emerald-900]="line.kind === 'add'"
                      [class.text-emerald-300]="line.kind === 'add'"
                      [class.bg-red-900]="line.kind === 'remove'"
                      [class.text-red-300]="line.kind === 'remove'">
                      <span class="select-none pr-2 opacity-60">{{ line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' ' }}</span>{{ line.text }}
                    </div>
                  }
                </div>
              </section>
            } @else {
              <section class="mb-4">
                <div class="mb-2 flex items-center justify-between">
                  <h3 class="text-xs font-semibold uppercase tracking-wider text-text-muted">Preview</h3>
                  <button
                    type="button"
                    class="text-xs text-accent hover:text-accent-hover"
                    (click)="toggleRaw()">{{ showRaw() ? 'Rendered' : 'View raw' }}</button>
                </div>
                @if (showRaw()) {
                  <pre class="m-0 max-h-[40vh] overflow-y-auto rounded border border-border-subtle bg-surface-2 px-3 py-2 font-mono text-sm leading-snug"><code>{{ p.content }}</code></pre>
                } @else {
                  <div
                    class="prose-preview max-h-[40vh] overflow-y-auto rounded border border-border-subtle bg-surface-2 px-4 py-3"
                    [innerHTML]="renderedPreview()"></div>
                }
              </section>
            }
          </div>

          <footer class="flex items-center justify-between gap-2 border-t border-border-subtle bg-surface-2 px-4 py-2.5">
            <div class="min-w-0 flex-1">
              @if (applyError(); as err) {
                <div class="text-sm text-danger">{{ err }}</div>
              } @else {
                <div class="text-sm text-text-secondary">{{ p.title }}</div>
              }
            </div>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="rounded px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                (click)="onCancel()">Cancel</button>
              @if (collidesWithExisting() && effectiveChangeType() === 'create') {
                <button
                  type="button"
                  class="rounded bg-amber-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-600"
                  (click)="convertToEdit()">Convert to edit</button>
              }
              <button
                type="button"
                class="rounded border border-border-subtle px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary disabled:opacity-50"
                [disabled]="!canApply() || applying()"
                (click)="onApply(true)">Apply &amp; open</button>
              <button
                type="button"
                class="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
                [disabled]="!canApply() || applying()"
                (click)="onApply(false)">{{ applying() ? 'Applying…' : 'Apply' }}</button>
            </div>
          </footer>
        </div>
      </div>
    }
  `,
  styles: [`
    pre code { white-space: pre; display: block; }
    .diff-line { white-space: pre-wrap; min-height: 1em; padding: 0 0.2em; }
    .prose-preview h1 { font-size: 1.4em; font-weight: 700; margin: 0.5em 0; }
    .prose-preview h2 { font-size: 1.2em; font-weight: 600; margin: 0.6em 0; }
    .prose-preview h3 { font-size: 1.05em; font-weight: 600; margin: 0.6em 0; }
    .prose-preview ul, .prose-preview ol { padding-left: 1.4em; margin: 0.4em 0; }
    .prose-preview p { margin: 0.4em 0; }
    .prose-preview code { background: var(--color-surface-3); padding: 0.05em 0.3em; border-radius: 3px; font-family: var(--font-mono); font-size: 0.85em; }
  `],
})
export class FileChangeProposalComponent {
  private readonly orchestrator = inject(AiOrchestratorService);
  private readonly fileChange = inject(FileChangeService);
  private readonly vault = inject(VaultService);
  private readonly injector = inject(Injector);

  private readonly dialogPanel = viewChild<ElementRef<HTMLElement>>('dialogPanel');
  private readonly pathInput = viewChild<ElementRef<HTMLInputElement>>('pathInput');

  readonly proposal = this.orchestrator.pendingProposal;

  private readonly _editedRelPath = signal('');
  private readonly _changeType = signal<AiChangeType>('create');
  private readonly _beforeContent = signal<string | null>(null);
  private readonly _showRaw = signal(false);
  private readonly _applying = signal(false);
  private readonly _collides = signal(false);
  private readonly _applyError = signal<string | null>(null);

  readonly editedRelPath = this._editedRelPath.asReadonly();
  readonly effectiveChangeType = this._changeType.asReadonly();
  readonly showRaw = this._showRaw.asReadonly();
  readonly applying = this._applying.asReadonly();
  readonly collidesWithExisting = this._collides.asReadonly();
  readonly applyError = this._applyError.asReadonly();

  readonly pathError = computed(() => {
    const p = this._editedRelPath();
    if (!p) return 'Path is required.';
    if (!isSafeRelPath(p)) return 'Path must stay inside the vault (no .., absolute, or drive letter).';
    if (!p.toLowerCase().endsWith('.md')) return 'Filename must end with .md';
    return null;
  });

  readonly canApply = computed(() => {
    if (this.pathError() !== null) return false;
    if (this.effectiveChangeType() === 'create' && this._collides()) return false;
    return true;
  });

  readonly renderedPreview = computed(() => {
    const p = this.proposal();
    if (!p) return '';
    return marked.parse(p.content, { async: false }) as string;
  });

  readonly diff = computed<DiffLine[]>(() => {
    const p = this.proposal();
    if (!p) return [];
    const before = this._beforeContent() ?? '';
    const after = p.content;
    const parts = diffLines(before, after);
    const lines: DiffLine[] = [];
    for (const part of parts) {
      const split = part.value.split('\n');
      // diffLines often leaves a trailing "" entry when ending in newline.
      const stripped = split[split.length - 1] === '' ? split.slice(0, -1) : split;
      for (const text of stripped) {
        if (part.added) lines.push({ kind: 'add', text });
        else if (part.removed) lines.push({ kind: 'remove', text });
        else lines.push({ kind: 'context', text });
      }
    }
    return lines;
  });

  constructor() {
    // On every fresh proposal, snapshot to local editable state.
    effect(() => {
      const p = this.proposal();
      if (!p) {
        untracked(() => {
          this._editedRelPath.set('');
          this._changeType.set('create');
          this._beforeContent.set(null);
          this._collides.set(false);
          this._applying.set(false);
          this._showRaw.set(false);
          this._applyError.set(null);
        });
        return;
      }
      untracked(() => {
        this._editedRelPath.set(p.relPath);
        this._changeType.set(p.changeType);
        this._beforeContent.set(null);
        this._showRaw.set(false);
        this._applying.set(false);
        this._applyError.set(null);
        void this.refreshCollision(p.relPath);
        // Autofocus the path input once the dialog has rendered.
        afterNextRender(
          () => this.pathInput()?.nativeElement.focus(),
          { injector: this.injector },
        );
      });
    });
  }

  toggleRaw(): void {
    this._showRaw.update((v) => !v);
  }

  /** Keeps Tab focus cycling within the dialog. */
  onTab(event: Event): void {
    const evt = event as KeyboardEvent;
    const panel = this.dialogPanel()?.nativeElement;
    if (!panel) return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute('disabled'));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (evt.shiftKey) {
      if (active === first || !panel.contains(active)) {
        evt.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      evt.preventDefault();
      first.focus();
    }
  }

  onPathChange(value: string): void {
    this._editedRelPath.set(value);
    void this.refreshCollision(value);
  }

  convertToEdit(): void {
    this._changeType.set('edit');
    void this.loadBeforeContent();
  }

  async onApply(openAfter: boolean): Promise<void> {
    const proposal = this.proposal();
    if (!proposal || !this.canApply()) return;
    this._applyError.set(null);
    this._applying.set(true);
    try {
      const relPath = this._editedRelPath();
      const changeType = this._changeType();
      let beforeContent = this._beforeContent();
      if (changeType === 'edit' && beforeContent === null) {
        beforeContent = await this.fileChange.resolveBeforeContent(relPath);
        this._beforeContent.set(beforeContent);
      }
      const { absPath } = await this.fileChange.apply({
        sessionId: proposal.sessionId,
        relPath,
        changeType,
        beforeContent,
        afterContent: proposal.content,
      });
      if (openAfter && absPath) {
        this.vault.setActiveFile(absPath);
      }
      // Settle any awaiting tool loop with the final (possibly user-edited)
      // path. For non-tool (JSON-proposal) turns there is no awaiter and this
      // simply clears the modal.
      this.orchestrator.resolveProposal({ applied: true, relPath, absPath });
    } catch (err) {
      this._applyError.set('Failed to apply change: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      this._applying.set(false);
    }
  }

  async onCancel(): Promise<void> {
    const proposal = this.proposal();
    if (proposal) {
      await this.fileChange.recordProposed({
        sessionId: proposal.sessionId,
        relPath: this._editedRelPath() || proposal.relPath,
        changeType: this._changeType(),
        beforeContent: this._beforeContent(),
        afterContent: proposal.content,
      });
    }
    // Release any awaiting tool loop as rejected; also clears the modal.
    this.orchestrator.resolveProposal({ applied: false });
  }

  private async refreshCollision(relPath: string): Promise<void> {
    if (!isSafeRelPath(relPath)) {
      this._collides.set(false);
      return;
    }
    const exists = await this.fileChange.fileExists(relPath);
    this._collides.set(exists);
    if (exists && this._changeType() === 'edit') {
      await this.loadBeforeContent();
    }
  }

  private async loadBeforeContent(): Promise<void> {
    const relPath = this._editedRelPath();
    const content = await this.fileChange.resolveBeforeContent(relPath);
    this._beforeContent.set(content);
  }

  /** Exposed in case future callers want to programmatically sanitize. */
  static sanitize(name: string): string {
    return sanitizeFilename(name);
  }
}
