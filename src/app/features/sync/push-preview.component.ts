import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { UiStateService } from '../../core/ui-state.service';
import { VaultService } from '../../core/vault.service';
import { SettingsService } from '../../core/settings.service';
import { SyncService, SyncError } from '../../core/sync.service';
import { IpcService } from '../../core/ipc.service';
import { PushPreviewNodeComponent } from './push-preview-node.component';
import type { LinearConnection } from '../../../../electron/sync/connection';
import type { PushPreviewTree, PreviewNode } from '../../../../electron/sync/preview';
import type { PushResult, ItemPushResult } from '../../../../electron/sync/executor';

/** The phases of a push, from open through preview, approval, and result. */
type Phase = 'idle' | 'loading' | 'preview' | 'pushing' | 'done' | 'error';

/** A `done`-phase row: an executor result joined to its preview node title. */
interface ResultRow {
  result: ItemPushResult;
  title: string;
}

/**
 * Push preview & confirmation (TER-32).
 *
 * The approval surface for pushing the active vault to its enabled Linear
 * connection. SpecForge is local-first — AI proposes, the user disposes — so the
 * user must review a tree of CREATE / UPDATE / SKIP decisions before anything
 * touches the network, then explicitly approve to execute.
 *
 * It is a small state machine over a single `phase` signal:
 *  - `loading`  — `SyncService.buildPreview` is in flight.
 *  - `preview`  — the decision roll-up + tree are shown for approval, unless the
 *    plan is empty or all-SKIP (no-op states, the Approve button is hidden).
 *  - `pushing`  — `SyncService.executePush` is in flight (request/response, no
 *    streaming); per-item results arrive only with the resolved `PushResult`.
 *  - `done`     — the push result: summary counts + per-item rows (partial
 *    failure is normal and surfaced as a mixed result, never a single
 *    success/error). Created/updated rows deep-link out via the IPC shell seam.
 *  - `error`    — `buildPreview`/`executePush` threw a {@link SyncError}; the
 *    message is shown, with a Retry affordance when the failure is retryable.
 *
 * State resets when the vault changes and when the modal closes, so re-opening
 * always starts from a clean preview.
 */
@Component({
  selector: 'app-push-preview',
  standalone: true,
  imports: [PushPreviewNodeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (isOpen()) {
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        (click)="close()">
        <div
          #panel
          class="flex h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface-1 shadow-2xl"
          role="dialog"
          aria-modal="true"
          aria-label="Push to Linear"
          tabindex="-1"
          (click)="$event.stopPropagation()"
          (keydown.escape)="close()">
          <header class="flex items-center justify-between border-b border-border-subtle bg-surface-2 px-4 py-2.5">
            <h2 class="text-sm font-semibold tracking-wide text-text-primary">Push to Linear</h2>
            <button
              type="button"
              class="rounded px-2 py-0.5 text-sm text-text-muted hover:bg-surface-3 hover:text-text-primary"
              aria-label="Close"
              (click)="close()">×</button>
          </header>

          <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            @switch (phase()) {
              @case ('loading') {
                <p class="text-sm text-text-secondary">Building preview…</p>
              }

              @case ('preview') {
                @if (previewTree(); as tree) {
                  @if (isEmpty()) {
                    <div class="py-6 text-center text-sm text-text-secondary">
                      Nothing to sync — this vault has no items.
                    </div>
                  } @else if (isNoop()) {
                    <div class="py-6 text-center text-sm text-text-secondary">
                      Everything is already up to date — nothing to push.
                    </div>
                  } @else {
                    <div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                      <span><span class="font-semibold text-text-primary">{{ tree.counts.create }}</span> create</span>
                      <span><span class="font-semibold text-text-primary">{{ tree.counts.update }}</span> update</span>
                      <span><span class="font-semibold text-text-primary">{{ tree.counts.skip }}</span> skip</span>
                      <span aria-hidden="true">·</span>
                      <span><span class="font-semibold text-text-primary">{{ tree.counts.total }}</span> total</span>
                    </div>

                    @if (tree.cycles.length > 0) {
                      <p class="mb-3 rounded border border-border-subtle bg-surface-2 px-3 py-2 text-xs text-danger">
                        {{ tree.cycles.length }} dependency
                        {{ tree.cycles.length === 1 ? 'cycle' : 'cycles' }} detected — those items
                        were not safely ordered and are shown as flagged roots.
                      </p>
                    }

                    <div class="space-y-0.5">
                      @for (root of tree.roots; track root.localId) {
                        <app-push-preview-node
                          [node]="root"
                          (openExternal)="openExternal($event)" />
                      }
                    </div>
                  }
                }
              }

              @case ('pushing') {
                <p class="text-sm text-text-secondary">Pushing…</p>
              }

              @case ('done') {
                @if (pushResult(); as result) {
                  <div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
                    <span><span class="font-semibold text-text-primary">{{ result.created }}</span> created</span>
                    <span><span class="font-semibold text-text-primary">{{ result.updated }}</span> updated</span>
                    <span><span class="font-semibold text-text-primary">{{ result.skipped }}</span> skipped</span>
                    @if (result.failed > 0) {
                      <span><span class="font-semibold text-danger">{{ result.failed }}</span> failed</span>
                    }
                  </div>

                  <div class="space-y-0.5">
                    @for (row of resultRows(); track row.result.localId) {
                      <div class="flex items-start gap-2 rounded px-2 py-1.5 text-sm">
                        <span
                          class="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                          [class]="statusClass(row.result.status)">{{ row.result.status }}</span>
                        <div class="min-w-0 flex-1">
                          <span class="block truncate font-medium text-text-primary">{{ row.title }}</span>
                          @if (row.result.error; as err) {
                            <span class="mt-0.5 block text-xs text-danger">{{ err }}</span>
                          }
                          @if (row.result.linkError; as linkErr) {
                            <span class="mt-0.5 block text-xs text-text-muted">Link warning: {{ linkErr }}</span>
                          }
                          @if (row.result.externalUrl; as url) {
                            <button
                              type="button"
                              class="mt-0.5 block rounded text-xs text-accent-hover underline decoration-dotted underline-offset-2 hover:text-accent focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none"
                              (click)="openExternal(url)">View in Linear</button>
                          }
                        </div>
                      </div>
                    }
                  </div>
                }
              }

              @case ('error') {
                <div class="py-4">
                  <p class="text-sm text-danger">{{ errorMessage() }}</p>
                </div>
              }

              @default {
                <p class="text-sm text-text-muted">No enabled Linear connection for this vault.</p>
              }
            }
          </div>

          <footer class="flex items-center justify-end gap-2 border-t border-border-subtle bg-surface-2 px-4 py-2.5">
            @if (canRetry()) {
              <button
                type="button"
                class="rounded px-3 py-1.5 text-xs font-semibold text-white bg-accent hover:bg-accent-hover focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none"
                (click)="retry()">Retry</button>
            }
            @if (phase() === 'preview' && canApprove()) {
              <button
                type="button"
                class="rounded px-3 py-1.5 text-xs font-semibold text-white bg-accent hover:bg-accent-hover focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none"
                (click)="approve()">Push to Linear</button>
            }
            <button
              type="button"
              class="rounded px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none"
              [disabled]="phase() === 'pushing'"
              [class.opacity-50]="phase() === 'pushing'"
              (click)="close()">{{ phase() === 'done' ? 'Done' : 'Cancel' }}</button>
          </footer>
        </div>
      </div>
    }
  `,
})
export class PushPreviewComponent {
  private readonly ui = inject(UiStateService);
  private readonly vault = inject(VaultService);
  private readonly settings = inject(SettingsService);
  private readonly sync = inject(SyncService);
  private readonly ipc = inject(IpcService);
  private readonly injector = inject(Injector);

  readonly isOpen = this.ui.pushPreviewOpen;

  private readonly panelRef = viewChild<ElementRef<HTMLElement>>('panel');

  private readonly _phase = signal<Phase>('idle');
  private readonly _previewTree = signal<PushPreviewTree | null>(null);
  private readonly _pushResult = signal<PushResult | null>(null);
  private readonly _error = signal<{ message: string; retryable: boolean } | null>(null);

  /**
   * Monotonic generation counter that invalidates in-flight async work. Every
   * `reset()` (fired on vault change AND on close) bumps it, so a late-resolving
   * `buildPreview`/`executePush` started under an older generation discards its
   * result instead of clobbering current state with stale data (e.g. showing the
   * previous vault's preview after a switch). Mirrors the stale-response guard the
   * Integrations settings panel uses around its discovery calls.
   */
  private generation = 0;

  readonly phase = this._phase.asReadonly();
  readonly previewTree = this._previewTree.asReadonly();
  readonly pushResult = this._pushResult.asReadonly();

  readonly errorMessage = computed(() => this._error()?.message ?? '');
  /** Retry is offered only for a retryable failure (drives the Retry button). */
  readonly canRetry = computed(() => this._phase() === 'error' && (this._error()?.retryable ?? false));

  /** No items at all in the plan — distinct from "all up to date". */
  readonly isEmpty = computed(() => (this._previewTree()?.counts.total ?? 0) === 0);

  /** Items exist but none will change (all SKIP) — nothing to push. */
  readonly isNoop = computed(() => {
    const counts = this._previewTree()?.counts;
    if (!counts) return false;
    return counts.total > 0 && counts.create === 0 && counts.update === 0;
  });

  /** Approve is enabled only when there is at least one create/update to push. */
  readonly canApprove = computed(() => !this.isEmpty() && !this.isNoop());

  /**
   * The enabled Linear connection for the active vault, or null. Drives whether
   * the preview can be built; the trigger affordances gate on the same.
   */
  private readonly activeConnection = computed<LinearConnection | null>(() => {
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) return null;
    const conns = this.settings.connectionsForVault(vaultPath);
    const linear = conns.find(
      (c): c is LinearConnection => c.provider === 'linear' && c.enabled,
    );
    return linear ?? null;
  });

  /**
   * Executor results joined back to their preview node titles (the `results[]`
   * array is flat and in plan order; titles come from the preview tree by
   * localId, falling back to the localId when no node is found).
   */
  readonly resultRows = computed<ResultRow[]>(() => {
    const result = this._pushResult();
    if (!result) return [];
    const titles = this.titleByLocalId();
    return result.results.map((r) => ({
      result: r,
      title: titles.get(r.localId) ?? r.localId,
    }));
  });

  /** Flattened localId -> title lookup over the preview tree, built once per tree. */
  private readonly titleByLocalId = computed<Map<string, string>>(() => {
    const tree = this._previewTree();
    const map = new Map<string, string>();
    if (!tree) return map;
    const walk = (nodes: PreviewNode[]): void => {
      for (const node of nodes) {
        map.set(node.localId, node.title);
        walk(node.children);
      }
    };
    walk(tree.roots);
    return map;
  });

  constructor() {
    // Reset whenever the vault changes: a preview built for one vault must never
    // leak into another. Reading vaultPath() registers the dependency.
    effect(() => {
      this.vault.vaultPath();
      this.reset();
    });

    // Drive the open/close lifecycle. Opening with an enabled connection kicks
    // off the preview build and focuses the panel; closing resets state. Only the
    // open/close transition should trigger this — loadPreview() reads
    // activeConnection() synchronously, so without untracked() the effect would also
    // track the connection signals and restart the build on a settings change while
    // the modal is open. Vault changes are handled by the reset() effect above.
    effect(() => {
      const open = this.isOpen();
      untracked(() => {
        if (open) {
          afterNextRender(
            { write: () => this.panelRef()?.nativeElement.focus() },
            { injector: this.injector },
          );
          void this.loadPreview();
        } else {
          this.reset();
        }
      });
    });
  }

  /** Builds the preview for the active connection, into the loading→preview/error path. */
  private async loadPreview(): Promise<void> {
    const conn = this.activeConnection();
    if (!conn) {
      this._phase.set('idle');
      return;
    }
    const gen = this.generation;
    this._phase.set('loading');
    this._error.set(null);
    try {
      const data = await this.sync.buildPreview(conn.connectionId);
      // Discard a stale response: a vault change or close (each bumps the
      // generation) may have happened while the request was in flight, so this
      // preview no longer describes the current connection.
      if (gen !== this.generation) return;
      this._previewTree.set(data.preview);
      this._phase.set('preview');
    } catch (err) {
      if (gen !== this.generation) return;
      this.setError(err);
    }
  }

  /** Approve → execute the push (request/response; results arrive resolved). */
  async approve(): Promise<void> {
    const conn = this.activeConnection();
    if (!conn) return;
    const gen = this.generation;
    this._phase.set('pushing');
    this._error.set(null);
    try {
      const result = await this.sync.executePush(conn.connectionId);
      // Discard a stale result if the vault changed or the modal closed mid-push.
      if (gen !== this.generation) return;
      this._pushResult.set(result);
      this._phase.set('done');
    } catch (err) {
      if (gen !== this.generation) return;
      this.setError(err);
    }
  }

  /**
   * Re-runs the failed step. After a preview failure that means rebuilding the
   * preview; after a push failure (a result was never produced) it re-runs the
   * push so the user can recover without re-approving from scratch.
   */
  retry(): void {
    if (this._pushResult() === null && this._previewTree() !== null) {
      void this.approve();
    } else {
      void this.loadPreview();
    }
  }

  /** Opens a created/existing item in the system browser via the IPC shell seam. */
  openExternal(url: string): void {
    // The IPC handler rejects a non-http(s)/malformed URL; swallow it so a bad
    // externalUrl can't surface as an unhandled promise rejection.
    this.ipc.openExternal(url).catch((err) => {
      console.warn('[push-preview] Failed to open external URL:', err);
    });
  }

  close(): void {
    // executePush is a non-cancellable request/response: dismissing mid-push would
    // bump the generation and discard the resolved PushResult while the write still
    // lands in Linear, hiding the outcome. Block every close path (backdrop, escape,
    // ✕, Cancel) until the push settles — matching the already-disabled Cancel button.
    if (this._phase() === 'pushing') return;
    this.ui.closePushPreview();
  }

  /** Status-badge styling for a `done`-phase row, mirroring the decision badges. */
  protected statusClass(status: ItemPushResult['status']): string {
    switch (status) {
      case 'created':
        return 'bg-accent text-white';
      case 'updated':
        return 'border border-accent text-accent-hover';
      case 'failed':
        return 'bg-danger text-white';
      default:
        return 'bg-surface-3 text-text-muted';
    }
  }

  /** Normalizes a thrown error into the error phase, preserving retryability. */
  private setError(err: unknown): void {
    if (err instanceof SyncError) {
      this._error.set({ message: err.info.message, retryable: err.info.retryable });
    } else {
      this._error.set({
        message: err instanceof Error ? err.message : 'Push failed',
        retryable: false,
      });
    }
    this._phase.set('error');
  }

  /** Clears every transient signal back to the idle baseline. */
  private reset(): void {
    // Invalidate any in-flight buildPreview/executePush so a late resolve can't
    // restore stale state after this reset (vault change / close).
    this.generation += 1;
    this._phase.set('idle');
    this._previewTree.set(null);
    this._pushResult.set(null);
    this._error.set(null);
  }
}
