import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  afterNextRender,
  effect,
  inject,
  viewChild,
  type ElementRef,
} from '@angular/core';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';

@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (request(); as req) {
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        (click)="onCancel()">
        <div
          class="flex w-full max-w-md flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface-1 shadow-2xl"
          (click)="$event.stopPropagation()"
          (keydown.escape)="onCancel()">
          <header class="flex items-center justify-between border-b border-border-subtle bg-surface-2 px-4 py-2.5">
            <h2 class="text-sm font-semibold tracking-wide text-text-primary">{{ req.title }}</h2>
            <button
              type="button"
              class="rounded px-2 py-0.5 text-sm text-text-muted hover:bg-surface-3 hover:text-text-primary"
              (click)="onCancel()">×</button>
          </header>

          <div class="px-5 py-4">
            <p class="text-sm text-text-secondary whitespace-pre-line">{{ req.message }}</p>
          </div>

          <footer class="flex items-center justify-end gap-2 border-t border-border-subtle bg-surface-2 px-4 py-2.5">
            @if (!req.noticeOnly) {
              <button
                type="button"
                class="rounded px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                (click)="onCancel()">{{ req.cancelLabel ?? 'Cancel' }}</button>
            }
            <button
              #confirmBtn
              type="button"
              class="rounded px-3 py-1.5 text-xs font-semibold text-white"
              [class.bg-danger]="req.danger"
              [class.hover:opacity-90]="req.danger"
              [class.bg-accent]="!req.danger"
              [class.hover:bg-accent-hover]="!req.danger"
              (keydown.enter)="onAccept()"
              (click)="onAccept()">{{ req.confirmLabel ?? 'OK' }}</button>
          </footer>
        </div>
      </div>
    }
  `,
})
export class ConfirmDialogComponent {
  private readonly confirmDialog = inject(ConfirmDialogService);

  readonly request = this.confirmDialog.request;

  private readonly confirmBtnRef = viewChild<ElementRef<HTMLButtonElement>>('confirmBtn');
  private readonly injector = inject(Injector);

  private currentRequest = this.confirmDialog.request();

  constructor() {
    // Focus the confirm button whenever a new request appears so Enter accepts
    // and Escape cancels without first requiring a click. Tracking the request
    // reference (rather than a null/non-null flag) ensures back-to-back prompts
    // are re-focused. Mirrors input-dialog.component.ts.
    effect(() => {
      const req = this.request();
      if (req !== null && req !== this.currentRequest) {
        afterNextRender(
          { write: () => this.confirmBtnRef()?.nativeElement.focus() },
          { injector: this.injector },
        );
      }
      this.currentRequest = req;
    });
  }

  onAccept(): void {
    this.confirmDialog.accept();
  }

  onCancel(): void {
    this.confirmDialog.cancel();
  }
}
