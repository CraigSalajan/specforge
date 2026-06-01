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
import { FormsModule } from '@angular/forms';
import { InputDialogService, type InputDialogRequest } from '../../core/input-dialog.service';

@Component({
  selector: 'app-input-dialog',
  standalone: true,
  imports: [FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (request(); as req) {
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
        (click)="onCancel()">
        <div
          class="flex w-full max-w-md flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface-1 shadow-2xl"
          (click)="$event.stopPropagation()">
          <header class="flex items-center justify-between border-b border-border-subtle bg-surface-2 px-4 py-2.5">
            <h2 class="text-sm font-semibold tracking-wide text-text-primary">{{ req.title }}</h2>
            <button
              type="button"
              class="rounded px-2 py-0.5 text-sm text-text-muted hover:bg-surface-3 hover:text-text-primary"
              (click)="onCancel()">×</button>
          </header>

          <div class="px-5 py-4">
            @if (req.label) {
              <label class="mb-1 block text-xs text-text-secondary">{{ req.label }}</label>
            }
            <input
              #input
              type="text"
              class="w-full rounded border border-border-subtle bg-surface-2 px-2 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none"
              [placeholder]="req.placeholder ?? ''"
              [ngModel]="value()"
              (ngModelChange)="value.set($event)"
              (keydown.enter)="onConfirm()"
              (keydown.escape)="onCancel()" />
          </div>

          <footer class="flex items-center justify-end gap-2 border-t border-border-subtle bg-surface-2 px-4 py-2.5">
            <button
              type="button"
              class="rounded px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary"
              (click)="onCancel()">Cancel</button>
            <button
              type="button"
              class="rounded bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
              [disabled]="!value().trim() && !request()?.defaultValue"
              (click)="onConfirm()">{{ req.confirmLabel ?? 'OK' }}</button>
          </footer>
        </div>
      </div>
    }
  `,
})
export class InputDialogComponent {
  private readonly inputDialog = inject(InputDialogService);

  readonly request = this.inputDialog.request;

  readonly value = signal('');

  private readonly inputRef = viewChild<ElementRef<HTMLInputElement>>('input');
  private readonly injector = inject(Injector);

  private currentRequest: InputDialogRequest | null = null;

  constructor() {
    // Seed the input value whenever a new request appears, reading the request
    // snapshot inside `untracked` so subsequent edits to `value` don't
    // re-trigger seeding. Tracking the request reference (rather than just a
    // null/non-null flag) ensures back-to-back prompts — where one request is
    // replaced by another without passing through null — are re-seeded and
    // re-focused. Focus the input once it has rendered.
    effect(() => {
      const req = this.request();
      if (req !== null && req !== this.currentRequest) {
        untracked(() => this.value.set(req.initialValue));
        afterNextRender(
          { write: () => this.inputRef()?.nativeElement.focus() },
          { injector: this.injector },
        );
      }
      this.currentRequest = req;
    });
  }

  onConfirm(): void {
    const v = this.value().trim() || (this.request()?.defaultValue ?? '');
    if (!v) return;
    this.inputDialog.confirm(v);
  }

  onCancel(): void {
    this.inputDialog.cancel();
  }
}
