import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  afterNextRender,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { ContextMenuService } from '../../core/context-menu.service';

@Component({
  selector: 'app-context-menu',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (state(); as st) {
      <div
        class="fixed inset-0 z-50"
        (pointerdown)="contextMenu.close()"
        (contextmenu)="onBackdropContextMenu($event)">
        <div
          #panel
          class="fixed min-w-[10rem] rounded border border-border-subtle bg-surface-2 py-1 text-xs shadow-lg"
          [style.left.px]="posX()"
          [style.top.px]="posY()"
          (pointerdown)="$event.stopPropagation()"
          (contextmenu)="$event.preventDefault()">
          @for (item of st.items; track $index) {
            @if (item.type === 'separator') {
              <div class="my-1 border-t border-border-subtle"></div>
            } @else {
              <button
                type="button"
                class="flex w-full items-center px-3 py-1.5 text-left hover:bg-surface-3"
                [class.text-danger]="item.danger"
                (click)="onItemClick(item.action)">
                {{ item.label }}
              </button>
            }
          }
        </div>
      </div>
    }
  `,
})
export class ContextMenuComponent {
  protected readonly contextMenu = inject(ContextMenuService);

  readonly state = this.contextMenu.state;

  readonly posX = signal(0);
  readonly posY = signal(0);

  private readonly panelRef = viewChild<ElementRef<HTMLDivElement>>('panel');
  private readonly injector = inject(Injector);

  constructor() {
    // Seed the panel position from each new state and, once the panel has
    // rendered, measure it and clamp so it never overflows the viewport.
    // Reads the state snapshot inside `untracked` so position edits don't
    // re-trigger seeding; tracking the state reference re-runs for back-to-back
    // opens that skip through null. Mirrors input-dialog.component.ts.
    effect(() => {
      const st = this.state();
      if (st !== null) {
        untracked(() => {
          this.posX.set(st.x);
          this.posY.set(st.y);
        });
        afterNextRender(
          { write: () => this.clampToViewport(st.x, st.y) },
          { injector: this.injector },
        );
      }
    });

    // Add window-level listeners only while the menu is open and remove them on
    // close so no listeners leak. Escape, scroll and resize all dismiss.
    effect((onCleanup) => {
      if (this.state() === null) return;
      window.addEventListener('keydown', this.onKeydown);
      window.addEventListener('scroll', this.onDismissEvent, true);
      window.addEventListener('resize', this.onDismissEvent, true);
      onCleanup(() => {
        window.removeEventListener('keydown', this.onKeydown);
        window.removeEventListener('scroll', this.onDismissEvent, true);
        window.removeEventListener('resize', this.onDismissEvent, true);
      });
    });
  }

  onBackdropContextMenu(evt: MouseEvent): void {
    evt.preventDefault();
    this.contextMenu.close();
  }

  onItemClick(action: () => void): void {
    action();
    this.contextMenu.close();
  }

  private clampToViewport(x: number, y: number): void {
    const panel = this.panelRef()?.nativeElement;
    if (!panel) return;
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    if (x + width > window.innerWidth) {
      this.posX.set(Math.max(4, Math.min(x, window.innerWidth - width - 4)));
    }
    if (y + height > window.innerHeight) {
      this.posY.set(Math.max(4, Math.min(y, window.innerHeight - height - 4)));
    }
  }

  private readonly onKeydown = (evt: KeyboardEvent): void => {
    if (evt.key === 'Escape') {
      this.contextMenu.close();
    }
  };

  private readonly onDismissEvent = (): void => {
    this.contextMenu.close();
  };
}
