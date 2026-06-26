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
import type {
  PushResult,
  ItemPushResult,
  ItemProgressEvent,
} from '../../../../electron/sync/executor';
import type { CanonicalItem } from '../../../../electron/sync/canonical-item';
import type { SyncDecision } from '../../../../electron/sync/sync-engine';

/** The phases of a push, from open through preview, approval, and result. */
type Phase = 'idle' | 'loading' | 'preview' | 'pushing' | 'done' | 'error';

/** A `done`-phase row: an executor result joined to its preview node title. */
interface ResultRow {
  result: ItemPushResult;
  title: string;
}

/** Live per-item push state, keyed by `localId` in {@link PushPreviewComponent._progress}. */
interface ItemProgress {
  /** What the row is currently showing. */
  status: 'pending' | 'creating' | 'done' | 'failed';
  /** The plan decision (create/update/skip), for the badge vocabulary. */
  decision: SyncDecision;
  /** The item title, so the live list reads without a separate join. */
  title: string;
  /** The terminal per-item result once it arrives (drives the final badge/links). */
  result?: ItemPushResult;
}

/** A combined-mode preview row: a story's decision joined to its rich content. */
interface CombinedStory {
  localId: string;
  decision: SyncDecision;
  title: string;
  /** The folded story body (statement + description + open questions + risks). */
  description?: string;
  /** Acceptance criteria, one testable item per entry. */
  criteria?: string[];
}

/**
 * Push preview & confirmation (TER-32, TER-37).
 *
 * The approval surface for pushing the active vault (or a single file, or the
 * AI's proposed `/decompose-stories` output) to its enabled Linear connection.
 * SpecForge is local-first — AI proposes, the user disposes — so the user reviews
 * a tree of CREATE / UPDATE / SKIP decisions before anything touches the network,
 * then explicitly approves to execute.
 *
 * It is a small state machine over a single `phase` signal:
 *  - `loading`  — `SyncService.buildPreview` is in flight.
 *  - `preview`  — the decision roll-up + tree are shown for approval, unless the
 *    plan is empty or all-SKIP (no-op states, the Approve button is hidden). In
 *    COMBINED mode the per-story content (title, folded description, acceptance
 *    criteria) is rendered richly from the in-memory items.
 *  - `pushing`  — the push is executing. Per-item rows stream live from `pending`
 *    → `creating` → `done`/`failed` as the executor emits progress (TER-37),
 *    replacing the old static "Pushing…" line.
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
            <div class="min-w-0">
              <h2 class="text-sm font-semibold tracking-wide text-text-primary">
                {{ headerTitle() }}
              </h2>
              @if (filePath(); as fp) {
                <p class="truncate text-xs text-text-muted" [title]="fp">{{ fp }}</p>
              }
            </div>
            <button
              type="button"
              class="rounded px-2 py-0.5 text-sm text-text-muted hover:bg-surface-3 hover:text-text-primary"
              aria-label="Close"
              (click)="close()">×</button>
          </header>

          <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            @switch (phase()) {
              @case ('loading') {
                <p class="flex items-center gap-2 text-sm text-text-secondary" role="status" aria-live="polite">
                  <span class="sf-spinner" aria-hidden="true"></span>
                  Building preview…
                </p>
              }

              @case ('preview') {
                @if (combined(); as req) {
                  <div class="mb-3 rounded border border-border-subtle bg-surface-2 px-3 py-2 text-xs">
                    <p class="mb-1 font-semibold uppercase tracking-wider text-text-muted">
                      Will save to {{ req.filePath }}
                    </p>
                    <ul class="space-y-0.5 text-text-secondary">
                      <li>
                        <span class="font-semibold text-text-primary">{{ req.summary.storiesAdded }}</span>
                        new {{ req.summary.storiesAdded === 1 ? 'story' : 'stories' }}
                      </li>
                      @if (req.summary.sectionCreated) {
                        <li>A new “## User Stories” section will be added.</li>
                      }
                    </ul>
                  </div>
                }
                @if (previewTree(); as tree) {
                  @if (isEmpty()) {
                    <div class="py-6 text-center text-sm text-text-secondary">
                      Nothing to sync — {{ filePath() ? 'this file has no items.' : 'this vault has no items.' }}
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

                    @if (combined()) {
                      <!-- COMBINED mode (TER-37): the in-memory items hold the full
                           story content, so render it richly per story instead of
                           the count-only node summary. -->
                      <div class="space-y-2">
                        @for (story of combinedStories(); track story.localId) {
                          <div class="rounded border border-border-subtle bg-surface-2 px-3 py-2">
                            <div class="flex items-start gap-2">
                              <span
                                class="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                                [class]="decisionClass(story.decision)">{{ story.decision }}</span>
                              <span class="min-w-0 flex-1 font-medium text-text-primary">{{ story.title }}</span>
                            </div>
                            @if (story.description) {
                              <p class="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-text-secondary">{{ story.description }}</p>
                            }
                            @if (story.criteria && story.criteria.length > 0) {
                              <div class="mt-2">
                                <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-text-muted">
                                  Acceptance criteria
                                </p>
                                <ul class="space-y-0.5 text-xs text-text-secondary">
                                  @for (c of story.criteria; track $index) {
                                    <li class="flex gap-1.5">
                                      <span class="select-none text-text-muted" aria-hidden="true">–</span>
                                      <span class="min-w-0 flex-1">{{ c }}</span>
                                    </li>
                                  }
                                </ul>
                              </div>
                            }
                          </div>
                        }
                      </div>
                    } @else {
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
              }

              @case ('pushing') {
                <p class="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
                  <span class="sf-spinner" aria-hidden="true"></span>
                  Pushing to Linear…
                </p>
                <!-- One polite live region for the whole list (not per-row, which
                     would nest live regions and double-announce). Each row carries
                     a screen-reader-only "{title}: {state}" so the state is read
                     without relying on the spinner — motion is never the only cue. -->
                <div class="space-y-0.5" role="list" aria-live="polite" aria-busy="true">
                  @for (row of progressRows(); track row.localId) {
                    <div class="flex items-start gap-2 rounded px-2 py-1.5 text-sm" role="listitem">
                      <span class="sr-only">{{ row.title }}: {{ rowStatusLabel(row) }}</span>
                      <span class="mt-0.5 flex w-16 shrink-0 items-center gap-1.5" aria-hidden="true">
                        @switch (row.status) {
                          @case ('pending') {
                            <span class="sf-spinner opacity-30"></span>
                            <span class="text-[10px] uppercase tracking-wide text-text-muted">Queued</span>
                          }
                          @case ('creating') {
                            <span class="sf-spinner"></span>
                            <span class="text-[10px] uppercase tracking-wide text-accent-hover">{{ activeVerb(row.decision) }}</span>
                          }
                          @default {
                            <span
                              class="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
                              [class]="statusClass(row.result?.status ?? 'failed')">{{ row.result?.status ?? row.status }}</span>
                          }
                        }
                      </span>
                      <div class="min-w-0 flex-1">
                        <span class="block truncate font-medium text-text-primary">{{ row.title }}</span>
                        @if (row.result?.error; as err) {
                          <span class="mt-0.5 block text-xs text-danger">{{ err }}</span>
                        }
                        @if (row.result?.externalUrl; as url) {
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
                (click)="approve()">{{ approveLabel() }}</button>
            }
            <button
              type="button"
              class="rounded px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none"
              [disabled]="phase() === 'pushing'"
              [class.opacity-50]="phase() === 'pushing'"
              (click)="close()">{{ closeLabel() }}</button>
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

  /**
   * The per-file push scope (TER-37): a vault-relative markdown path (any folder),
   * or `null` for the whole-vault push. When set, buildPreview/executePush thread
   * it so only that file's items are previewed/pushed. Read from `UiStateService`,
   * which the opener sets alongside `pushPreviewOpen` and clears on close.
   */
  readonly filePath = this.ui.pushPreviewFilePath;

  /**
   * The combined decompose-and-push request (TER-37), or `null` for the push-only
   * modes. When set, the modal previews the push from the in-memory `items`, shows
   * the doc-save summary, and runs `onApprove` (write-then-push) on approve.
   */
  readonly combined = this.ui.combinedPushRequest;

  private readonly panelRef = viewChild<ElementRef<HTMLElement>>('panel');

  private readonly _phase = signal<Phase>('idle');
  private readonly _previewTree = signal<PushPreviewTree | null>(null);
  private readonly _pushResult = signal<PushResult | null>(null);
  private readonly _error = signal<{ message: string; retryable: boolean } | null>(null);

  /**
   * Live per-item push progress (TER-37), keyed by `localId`. Seeded as all-pending
   * at approve time and updated in place as the executor streams `start`/`done`
   * events, so the `pushing` view fills in like the AI chat stream. `_progressOrder`
   * preserves plan order for a stable list (a Map's insertion order would do, but an
   * explicit array keeps the seeding intent obvious).
   */
  private readonly _progress = signal<Map<string, ItemProgress>>(new Map());
  private readonly _progressOrder = signal<string[]>([]);

  /**
   * Monotonic generation counter that invalidates in-flight async work. Every
   * `reset()` (fired on vault change AND on close) bumps it, so a late-resolving
   * `buildPreview`/`executePush` — or a late progress event — started under an
   * older generation discards its result instead of clobbering current state with
   * stale data (e.g. showing the previous vault's preview after a switch). Mirrors
   * the stale-response guard the Integrations settings panel uses around discovery.
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

  /** Modal title, combined-mode-aware. */
  readonly headerTitle = computed(() => {
    if (this.combined()) return 'Decompose & Push this file';
    return this.filePath() ? 'Push this file to Linear' : 'Push to Linear';
  });

  /** Primary-button label: combined mode writes the doc first, then pushes. */
  readonly approveLabel = computed(() =>
    this.combined() ? 'Save & Push to Linear' : 'Push to Linear',
  );

  /** Secondary-button label: 'Done' after a push, 'Discard' in combined preview. */
  readonly closeLabel = computed(() => {
    if (this.phase() === 'done') return 'Done';
    return this.combined() ? 'Discard' : 'Cancel';
  });

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

  /** The live per-item progress list, in plan order, for the `pushing` view. */
  readonly progressRows = computed<(ItemProgress & { localId: string })[]>(() => {
    const map = this._progress();
    return this._progressOrder().map((localId) => {
      const p = map.get(localId);
      // Defensive default: an event-only id (no seed) still renders something.
      return p
        ? { localId, ...p }
        : { localId, status: 'pending' as const, decision: 'create' as const, title: localId };
    });
  });

  /** Combined-mode story rows: each preview node's decision joined to its rich content. */
  readonly combinedStories = computed<CombinedStory[]>(() => {
    const tree = this._previewTree();
    const req = this.combined();
    if (!tree || !req) return [];
    const byId = this.canonicalByLocalId();
    return tree.roots.map((node) => {
      const item = byId.get(node.localId);
      return {
        localId: node.localId,
        decision: node.decision,
        title: node.title,
        description: item?.description,
        criteria: item?.criteria,
      };
    });
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

  /** localId -> CanonicalItem lookup over the combined request's in-memory items. */
  private readonly canonicalByLocalId = computed<Map<string, CanonicalItem>>(() => {
    const map = new Map<string, CanonicalItem>();
    const items = this.combined()?.items;
    if (!items) return map;
    for (const item of items) map.set(item.localId, item);
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
    // Snapshot the scope at call time so the SAME path is used for preview and a
    // subsequent execute even if it changes mid-flight (it won't while open).
    const filePath = this.filePath() ?? undefined;
    const combined = this.combined();
    this._phase.set('loading');
    this._error.set(null);
    try {
      // Combined mode (TER-37): preview from the AI's in-memory proposed items so
      // the user reviews the push BEFORE the doc is written; push-only modes read
      // from disk. Both resolve idempotency against the connection's SyncLinks.
      const data = combined
        ? await this.sync.buildPreviewFromItems(conn.connectionId, combined.items)
        : await this.sync.buildPreview(conn.connectionId, filePath);
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

  /**
   * Approve → execute. Seeds the live per-item progress map as all-pending, then
   * executes: in combined mode this writes the proposed doc FIRST and pushes via
   * the request's `onApprove` callback (forwarding the progress sink); in push-only
   * modes it executes the per-file/whole-vault push directly. The executor streams
   * `start`/`done` events into {@link _progress} so the `pushing` view fills in
   * live, and the resolved {@link PushResult} lands on `done`.
   */
  async approve(): Promise<void> {
    const conn = this.activeConnection();
    if (!conn) return;
    const gen = this.generation;
    const combined = this.combined();
    // The same per-file scope the preview was built with (TER-37) so the approved
    // preview matches exactly what is pushed.
    const filePath = this.filePath() ?? undefined;
    this.seedProgress(combined?.items ?? null);
    this._phase.set('pushing');
    this._error.set(null);

    // Apply one streamed progress event in place, ignoring events from a stale
    // generation (a vault change / close while the push is in flight).
    const onProgress = (ev: ItemProgressEvent): void => {
      if (gen !== this.generation) return;
      this.applyProgress(ev);
    };

    try {
      const result = combined
        ? await combined.onApprove(onProgress)
        : await this.sync.executePush(conn.connectionId, filePath, onProgress);
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

  /** Status-badge styling for a result row, mirroring the decision badges. */
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

  /** Decision-badge styling for a combined-preview story (mirrors the node badges). */
  protected decisionClass(decision: SyncDecision): string {
    switch (decision) {
      case 'create':
        return 'bg-accent text-white';
      case 'update':
        return 'border border-accent text-accent-hover';
      default:
        return 'bg-surface-3 text-text-muted';
    }
  }

  /** Active-verb label for an in-progress row (matches the decision). */
  protected activeVerb(decision: SyncDecision): string {
    switch (decision) {
      case 'update':
        return 'Updating';
      case 'skip':
        return 'Skipping';
      default:
        return 'Creating';
    }
  }

  /**
   * Plain-language state for a progress row, read by screen readers (the visual
   * spinner is `aria-hidden`). Pending/creating describe the action; a terminal
   * row uses the result status so "created"/"failed" is announced, not the glyph.
   */
  protected rowStatusLabel(row: ItemProgress): string {
    switch (row.status) {
      case 'pending':
        return 'queued';
      case 'creating':
        return `${this.activeVerb(row.decision).toLowerCase()}`;
      default:
        return row.result?.status ?? row.status;
    }
  }

  /**
   * Seeds the live progress map as all-pending in plan order. In combined mode the
   * order comes from the in-memory items; otherwise it walks the preview tree (the
   * same flatten the executor's plan order follows: parents before children).
   */
  private seedProgress(items: CanonicalItem[] | null): void {
    const map = new Map<string, ItemProgress>();
    const order: string[] = [];
    const seed = (localId: string, decision: SyncDecision, title: string): void => {
      order.push(localId);
      map.set(localId, { status: 'pending', decision, title });
    };
    if (items) {
      for (const item of items) seed(item.localId, 'create', item.title);
    } else {
      const tree = this._previewTree();
      const walk = (nodes: PreviewNode[]): void => {
        for (const node of nodes) {
          seed(node.localId, node.decision, node.title);
          walk(node.children);
        }
      };
      if (tree) walk(tree.roots);
    }
    this._progress.set(map);
    this._progressOrder.set(order);
  }

  /** Applies one streamed executor progress event to the live map (immutably). */
  private applyProgress(ev: ItemProgressEvent): void {
    // Keep an event for an id we never seeded (a re-plan could add one) visible by
    // appending it to the order — done as its own write, never nested inside the
    // map updater.
    if (!this._progressOrder().includes(ev.localId)) {
      this._progressOrder.update((o) => [...o, ev.localId]);
    }
    this._progress.update((prev) => {
      const next = new Map(prev);
      const base: ItemProgress = next.get(ev.localId) ?? {
        status: 'pending',
        decision: ev.decision,
        title: ev.title,
      };
      next.set(
        ev.localId,
        ev.phase === 'start'
          ? { ...base, status: 'creating', decision: ev.decision, title: ev.title }
          : {
              ...base,
              status: ev.result.status === 'failed' ? 'failed' : 'done',
              decision: ev.decision,
              title: ev.title,
              result: ev.result,
            },
      );
      return next;
    });
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
    this._progress.set(new Map());
    this._progressOrder.set([]);
  }
}
