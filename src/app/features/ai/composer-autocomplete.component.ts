import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  input,
  output,
  signal,
} from '@angular/core';

/** Icon glyph rendered to the left of an option. */
export type AutocompleteIconType = 'file' | 'folder' | 'vault' | 'command' | 'none';

/** A single selectable row inside the shared composer popover. */
export interface AutocompleteItem {
  id: string;
  label: string;
  hint?: string;
  iconType?: AutocompleteIconType;
  checked?: boolean;
  disabled?: boolean;
}

/** A labelled cluster of items (e.g. "Draft" / "Analyze", or files/folders). */
export interface AutocompleteGroup {
  heading?: string;
  items: AutocompleteItem[];
}

/** Stable id for the listbox so the textarea can wire `aria-controls`. */
const LISTBOX_ID = 'composer-autocomplete-listbox';

/**
 * Presentational autocomplete popover shared by the `@` context picker and the
 * `/` command menu. It is a "dumb" view: the parent owns the query, the groups,
 * and the keyboard events. We keep only highlight state internally so the host
 * textarea can retain focus (combobox model — there is no input inside the
 * popover).
 *
 * The popover is rendered `fixed` and positioned ABOVE the anchor so it escapes
 * the AI panel's `overflow-y-auto` clipping and never paints over the chat
 * history. It sits at `z-40` (below modals at `z-50`) with a transparent
 * full-screen outside-click catcher beneath it.
 */
@Component({
  selector: 'app-composer-autocomplete',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <!-- Outside-click catcher: dismiss when clicking away. -->
      <div class="fixed inset-0 z-40" (click)="dismiss.emit()" aria-hidden="true"></div>
      <div
        class="ca-popover fixed z-40 flex w-80 max-w-[90vw] flex-col rounded-lg border border-border-subtle bg-surface-1 shadow-2xl max-h-[40vh] overflow-y-auto"
        role="listbox"
        [id]="listboxId"
        aria-label="Composer suggestions"
        [style.left.px]="left()"
        [style.bottom.px]="bottom()">
        @if (hasItems()) {
          @for (group of groups(); track $index) {
            @if (group.items.length > 0) {
              @if (group.heading; as heading) {
                <div class="px-2 pt-1.5 pb-0.5 text-xs font-semibold uppercase tracking-wider text-text-muted">
                  {{ heading }}
                </div>
              }
              @for (item of group.items; track item.id) {
                <div
                  [id]="optionId(item.id)"
                  role="option"
                  [attr.aria-selected]="item.id === highlightedId()"
                  [attr.aria-disabled]="item.disabled ? true : null"
                  class="mx-1 flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs"
                  [class.bg-surface-2]="item.id === highlightedId() && !item.disabled"
                  [class.text-text-primary]="item.id === highlightedId() && !item.disabled"
                  [class.text-text-secondary]="item.id !== highlightedId()"
                  [class.opacity-40]="item.disabled"
                  [class.cursor-not-allowed]="item.disabled"
                  (mouseenter)="onHover(item)"
                  (mousedown)="$event.preventDefault()"
                  (click)="onClick(item)">
                  @switch (item.iconType ?? 'none') {
                    @case ('file') {
                      <svg class="h-3.5 w-3.5 shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" /><path d="M14 2v4a2 2 0 0 0 2 2h4" /></svg>
                    }
                    @case ('folder') {
                      <svg class="h-3.5 w-3.5 shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>
                    }
                    @case ('vault') {
                      <svg class="h-3.5 w-3.5 shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14a9 3 0 0 0 18 0V5" /><path d="M3 12a9 3 0 0 0 18 0" /></svg>
                    }
                    @case ('command') {
                      <svg class="h-3.5 w-3.5 shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
                    }
                  }
                  <span class="min-w-0 shrink truncate" [title]="item.label">{{ item.label }}</span>
                  @if (item.hint; as hint) {
                    <span class="min-w-0 shrink-[9999] grow basis-0 truncate text-right text-text-muted" [title]="hint">{{ hint }}</span>
                  }
                  @if (item.checked) {
                    <svg class="h-3.5 w-3.5 shrink-0 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
                  }
                </div>
              }
            }
          }
        } @else {
          <div class="px-3 py-2 text-xs text-text-muted">No matches</div>
        }
      </div>
    }
  `,
  styles: [
    `
      .ca-popover {
        transition:
          opacity 120ms ease,
          transform 120ms ease;
      }
      @media (prefers-reduced-motion: reduce) {
        .ca-popover {
          transition: none;
        }
      }
    `,
  ],
})
export class ComposerAutocompleteComponent {
  /** Whether the popover is shown. */
  readonly open = input(false);
  /** Element the popover positions itself ABOVE (the composer wrapper). */
  readonly anchor = input<HTMLElement | null>(null);
  /** Current filter text (drives highlight reset only — filtering is external). */
  readonly query = input('');
  /** Grouped items to render. */
  readonly groups = input<AutocompleteGroup[]>([]);

  /** Emitted when a (non-disabled) item is chosen. */
  readonly select = output<AutocompleteItem>();
  /** Emitted on outside click / Escape-driven dismissal. */
  readonly dismiss = output<void>();

  protected readonly listboxId = LISTBOX_ID;

  /** Fixed-position coordinates, recomputed when open/anchor/groups change. */
  protected readonly left = signal(0);
  protected readonly bottom = signal(0);

  /** Currently highlighted item id (combobox `aria-activedescendant`). */
  private readonly _highlightedId = signal<string | null>(null);
  readonly highlightedId = this._highlightedId.asReadonly();

  /** Flattened, enabled-and-disabled, in render order. */
  private readonly flatItems = computed<AutocompleteItem[]>(() =>
    this.groups().flatMap((g) => g.items),
  );

  readonly hasItems = computed(() => this.flatItems().length > 0);

  constructor() {
    // Reset highlight to the first enabled item whenever the list or query
    // changes (or the popover opens).
    effect(() => {
      this.open();
      this.query();
      const items = this.flatItems();
      const current = this._highlightedId();
      const stillValid = current !== null && items.some((i) => i.id === current && !i.disabled);
      if (!stillValid) {
        this._highlightedId.set(this.firstEnabledId());
      }
    });

    // Reposition above the anchor when shown or as the option set changes height.
    effect(() => {
      if (!this.open()) return;
      this.groups();
      this.position();
    });
  }

  optionId(id: string): string {
    // Item ids can contain spaces or path separators (e.g. the Whole Vault
    // sentinel, vault rel-paths). Sanitize to a valid HTML id token so
    // `aria-activedescendant` reliably resolves to the option element.
    const safe = id.replace(/[^\w-]+/g, '_');
    return `${LISTBOX_ID}-opt-${safe}`;
  }

  /** Highlighted option's DOM id for `aria-activedescendant` on the textarea. */
  activeDescendantId(): string | null {
    const id = this._highlightedId();
    return id ? this.optionId(id) : null;
  }

  /** Moves the highlight by `delta`, skipping disabled items and wrapping. */
  moveHighlight(delta: 1 | -1): void {
    const items = this.flatItems().filter((i) => !i.disabled);
    if (items.length === 0) return;
    const current = this._highlightedId();
    const idx = items.findIndex((i) => i.id === current);
    const nextIdx = idx === -1 ? 0 : (idx + delta + items.length) % items.length;
    this._highlightedId.set(items[nextIdx]!.id);
  }

  /** Emits `select` for the highlighted item (no-op if disabled / none). */
  selectHighlighted(): void {
    const id = this._highlightedId();
    if (!id) return;
    const item = this.flatItems().find((i) => i.id === id);
    if (item && !item.disabled) this.select.emit(item);
  }

  protected onHover(item: AutocompleteItem): void {
    if (!item.disabled) this._highlightedId.set(item.id);
  }

  protected onClick(item: AutocompleteItem): void {
    if (!item.disabled) this.select.emit(item);
  }

  private firstEnabledId(): string | null {
    return this.flatItems().find((i) => !i.disabled)?.id ?? null;
  }

  /**
   * Anchors the popover's bottom edge just above the anchor, opening upward.
   * The popover scrolls internally when needed, so it always sits flush above
   * the composer regardless of content height.
   */
  private position(): void {
    const el = this.anchor();
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = 320; // matches w-80
    const left = Math.min(rect.left, window.innerWidth - width - 8);
    this.left.set(Math.max(8, left));
    this.bottom.set(Math.max(8, window.innerHeight - rect.top + 4));
  }
}
