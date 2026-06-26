import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { PreviewNode } from '../../../../electron/sync/preview';

/**
 * One row in the push preview tree (TER-32), rendered recursively.
 *
 * Each node shows its decision badge (CREATE / UPDATE / SKIP), the provider's
 * native target type, the item title, a presence-based change summary, and —
 * for items that already exist remotely (update/skip) — a deep link to the
 * external item. Children render the same component one indent deeper, so the
 * whole hierarchy is a single self-referential template.
 *
 * The component is purely presentational: it emits `openExternal` with a URL and
 * lets the parent (`PushPreviewComponent`) route it through the IPC shell seam,
 * so the recursion stays free of service injection.
 */
@Component({
  selector: 'app-push-preview-node',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (node(); as n) {
      <div class="text-sm" [style.padding-left.px]="depth() * 16">
        <div
          class="flex items-start gap-2 rounded px-2 py-1.5"
          [class.bg-surface-2]="n.inCycle">
          <span
            class="mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
            [class]="badgeClass()">{{ decisionLabel() }}</span>

          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="truncate font-medium text-text-primary">{{ n.title }}</span>
              @if (n.inCycle) {
                <span
                  class="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-danger"
                  title="This item is in a dependency cycle and was not safely ordered.">cycle</span>
              }
            </div>
            <div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-muted">
              <span>{{ targetLabel() }}</span>
              @if (summaryLine()) {
                <span aria-hidden="true">·</span>
                <span>{{ summaryLine() }}</span>
              }
              @if (n.externalUrl; as url) {
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  class="rounded text-accent-hover underline decoration-dotted underline-offset-2 hover:text-accent focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none"
                  (click)="openExternal.emit(url)">View in {{ providerLabel() }}</button>
              }
            </div>
          </div>
        </div>

        @for (child of n.children; track child.localId) {
          <app-push-preview-node
            [node]="child"
            [depth]="depth() + 1"
            (openExternal)="openExternal.emit($event)" />
        }
      </div>
    }
  `,
})
export class PushPreviewNodeComponent {
  readonly node = input.required<PreviewNode>();
  readonly depth = input(0);

  readonly openExternal = output<string>();

  /** Uppercase decision label for the badge (CREATE / UPDATE / SKIP). */
  protected readonly decisionLabel = computed(() => this.node().decision.toUpperCase());

  /**
   * Decision badge styling. CREATE reads as the primary action (accent),
   * UPDATE as a secondary action (accent on a quieter fill), and SKIP as inert
   * (muted) — all on tokens that clear WCAG AA against the surface ramp.
   */
  protected readonly badgeClass = computed(() => {
    switch (this.node().decision) {
      case 'create':
        return 'bg-accent text-white';
      case 'update':
        return 'border border-accent text-accent-hover';
      default:
        return 'bg-surface-3 text-text-muted';
    }
  });

  /** Human-readable provider name for link/summary copy. */
  protected readonly providerLabel = computed(() => {
    const provider = this.node().provider;
    return provider === 'linear' ? 'Linear' : provider;
  });

  /**
   * Target-type label: the provider-native type, annotated when the level folds
   * inline into its parent (e.g. acceptance criteria rendered into a Linear
   * description) so the user understands it won't become its own work item.
   */
  protected readonly targetLabel = computed(() => {
    const n = this.node();
    return n.representation === 'inline' ? `${n.nativeType} (inline)` : n.nativeType;
  });

  /**
   * Presence-based change summary line. Only the parts that are present/non-zero
   * are shown, so an item with no description and no criteria/tags yields an
   * empty string (the template then omits the summary segment entirely).
   */
  protected readonly summaryLine = computed(() => {
    const s = this.node().summary;
    const parts: string[] = [];
    if (s.hasDescription) parts.push('description');
    if (s.criteriaCount > 0) {
      parts.push(`${s.criteriaCount} ${s.criteriaCount === 1 ? 'criterion' : 'criteria'}`);
    }
    if (s.tagCount > 0) {
      parts.push(`${s.tagCount} ${s.tagCount === 1 ? 'tag' : 'tags'}`);
    }
    return parts.join(' · ');
  });
}
