import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { EditorNavigationService } from '../../core/editor-navigation.service';
import { IndexService } from '../../core/index.service';
import { UiStateService } from '../../core/ui-state.service';
import { VaultService } from '../../core/vault.service';
import type { IndexSearchHit } from '../../shared/types';
import { fromVaultRel } from '../../shared/vault-paths';

/** Hits for one file, in index score order (best file group first). */
interface SearchFileGroup {
  relPath: string;
  fileName: string;
  hits: IndexSearchHit[];
}

/** FTS queries shorter than this are noise; we wait for a second character. */
const MIN_QUERY_LENGTH = 2;
const DEBOUNCE_MS = 200;
const MAX_RESULTS = 100;

/**
 * Global full-text search over the vault (left-sidebar Search view,
 * Obsidian-style). Queries the existing FTS5 index via IndexService as the
 * user types; hits are grouped by file and jump to the matched chunk's
 * heading line through EditorNavigationService.
 *
 * The panel stays mounted while other sidebar views are showing, so the
 * query and results survive view switches; activation is signalled via
 * UiStateService.searchFocusRequests, which re-focuses the input.
 */
@Component({
  selector: 'app-search-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex h-full flex-col bg-surface-1 text-text-primary">
      <div class="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-text-secondary">Search</h2>
      </div>

      <div class="border-b border-border-subtle p-2">
        <input
          #queryInput
          type="text"
          aria-label="Search in vault"
          autocomplete="off"
          spellcheck="false"
          class="w-full rounded border border-border-subtle bg-surface-2 px-3 py-1.5 text-sm text-text-primary placeholder:text-text-secondary focus:border-accent focus:outline-none"
          placeholder="Search vault…"
          [value]="query()"
          (input)="onInput($event)"
          (keydown)="onKeydown($event)" />
      </div>

      @if (!hasVault()) {
        <div class="px-3 py-3 text-xs text-text-muted">Open a vault to search its files.</div>
      } @else if (!queryLongEnough()) {
        <div class="px-3 py-3 text-xs text-text-muted">
          {{ query().trim().length === 0
            ? 'Search every file in the vault. Results update as you type.'
            : 'Keep typing — search starts at two characters.' }}
        </div>
      } @else if (searched() && hits().length === 0) {
        <div class="px-3 py-3 text-xs text-text-muted">No matches for “{{ query().trim() }}”.</div>
      } @else if (hits().length > 0) {
        <div class="shrink-0 px-3 py-1.5 text-xs text-text-muted">{{ countLabel() }}</div>
        <div class="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
          @for (group of groups(); track group.relPath) {
            <div class="pb-1">
              <div class="flex items-baseline gap-2 px-2 pb-0.5 pt-1.5">
                <span class="min-w-0 shrink truncate text-sm font-medium text-text-primary" [title]="group.fileName">
                  {{ group.fileName }}
                </span>
                <span class="min-w-0 shrink-[9999] truncate text-xs text-text-muted" [title]="group.relPath">
                  {{ group.relPath }}
                </span>
              </div>
              @for (hit of group.hits; track $index) {
                <button
                  type="button"
                  class="block w-full rounded px-2 py-1 text-left transition-colors hover:bg-surface-2"
                  (click)="openHit(hit)">
                  @if (hit.headingPath) {
                    <div class="truncate text-xs text-text-muted">{{ hit.headingPath }}</div>
                  }
                  <div class="line-clamp-2 text-xs text-text-secondary">{{ hit.excerpt }}</div>
                </button>
              }
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class SearchPanelComponent {
  private readonly vault = inject(VaultService);
  private readonly indexer = inject(IndexService);
  private readonly editorNav = inject(EditorNavigationService);
  private readonly ui = inject(UiStateService);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  private readonly queryInput = viewChild<ElementRef<HTMLInputElement>>('queryInput');

  readonly hasVault = this.vault.hasVault;
  readonly query = signal('');
  readonly hits = signal<IndexSearchHit[]>([]);
  /** True once a search for the *current* query has completed. */
  readonly searched = signal(false);

  readonly queryLongEnough = computed(() => this.query().trim().length >= MIN_QUERY_LENGTH);

  /** Hits grouped by file, preserving score order of first appearance. */
  readonly groups = computed<SearchFileGroup[]>(() => {
    const byFile = new Map<string, SearchFileGroup>();
    for (const hit of this.hits()) {
      let group = byFile.get(hit.relPath);
      if (!group) {
        group = {
          relPath: hit.relPath,
          fileName: hit.relPath.split('/').pop() ?? hit.relPath,
          hits: [],
        };
        byFile.set(hit.relPath, group);
      }
      group.hits.push(hit);
    }
    return [...byFile.values()];
  });

  readonly countLabel = computed(() => {
    const matches = this.hits().length;
    const files = this.groups().length;
    return `${matches} ${matches === 1 ? 'match' : 'matches'} in ${files} ${files === 1 ? 'file' : 'files'}`;
  });

  private debounce: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic search id; stale responses (and cleared queries) are dropped. */
  private searchSeq = 0;
  private handledFocusSeq = 0;

  constructor() {
    // Activation handshake: every bump of the focus counter (sidebar tab,
    // "Search in vault…" command, Ctrl+Shift+F) focuses the input once the
    // view is rendered. Existing text is selected so retyping replaces it.
    effect(() => {
      const seq = this.ui.searchFocusRequests();
      untracked(() => {
        if (seq === this.handledFocusSeq) return;
        this.handledFocusSeq = seq;
        afterNextRender(
          {
            write: () => {
              const el = this.queryInput()?.nativeElement;
              el?.focus();
              el?.select();
            },
          },
          { injector: this.injector },
        );
      });
    });

    // Results are scoped to one index: switching (or closing) the vault
    // makes the old query and hits meaningless, so reset to the blank state.
    effect(() => {
      this.vault.vaultPath();
      untracked(() => {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = null;
        this.searchSeq++;
        this.query.set('');
        this.hits.set([]);
        this.searched.set(false);
      });
    });

    this.destroyRef.onDestroy(() => {
      if (this.debounce) clearTimeout(this.debounce);
    });
  }

  protected onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.scheduleSearch();
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      const first = this.hits()[0];
      if (first) this.openHit(first);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.clearQuery();
    }
  }

  /** Opens the hit; without a startLine, degrades to plain file open. */
  protected openHit(hit: IndexSearchHit): void {
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) return;
    // Index hits carry vault-relative paths (forward slashes); rebuild the
    // absolute path with the vault's native separator.
    const abs = fromVaultRel(vaultPath, hit.relPath);
    if (typeof hit.startLine === 'number') {
      this.editorNav.openFileAtLine(abs, hit.startLine);
    } else {
      this.vault.setActiveFile(abs);
    }
  }

  private clearQuery(): void {
    this.query.set('');
    this.scheduleSearch();
  }

  private scheduleSearch(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = null;
    const q = this.query().trim();
    if (q.length < MIN_QUERY_LENGTH) {
      this.searchSeq++; // invalidate any in-flight search
      this.hits.set([]);
      this.searched.set(false);
      return;
    }
    this.searched.set(false);
    this.debounce = setTimeout(() => void this.runSearch(q), DEBOUNCE_MS);
  }

  private async runSearch(query: string): Promise<void> {
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) return;
    const seq = ++this.searchSeq;
    const hits = await this.indexer.search(vaultPath, query, MAX_RESULTS);
    if (seq !== this.searchSeq) return;
    this.hits.set(hits);
    this.searched.set(true);
  }
}
