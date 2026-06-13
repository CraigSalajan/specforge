import { Injectable, signal } from '@angular/core';

/**
 * Options describing a single confirmation prompt rendered by the in-app
 * confirm dialog. Replaces `window.confirm`, which is unreliable inside the
 * Electron renderer.
 */
export interface ConfirmDialogRequest {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /**
   * Single-affordance notice: the cancel button is hidden and the dialog only
   * acknowledges (used for error notices instead of `window.alert`).
   */
  noticeOnly?: boolean;
}

/**
 * Drives the single `<app-confirm-dialog />` mounted at the app root. Components
 * call `confirm()` and await a Promise that resolves with `true` when the user
 * accepts, or `false` when they cancel.
 */
@Injectable({ providedIn: 'root' })
export class ConfirmDialogService {
  private readonly _request = signal<ConfirmDialogRequest | null>(null);

  readonly request = this._request.asReadonly();

  private resolver: ((v: boolean) => void) | null = null;

  /**
   * Opens the dialog and resolves once the user accepts or cancels. If a prompt
   * is already open, the previous one is resolved with `false` first so no
   * pending promise is ever leaked.
   */
  confirm(options: ConfirmDialogRequest): Promise<boolean> {
    if (this.resolver) {
      const p = this.resolver;
      this.resolver = null;
      p(false);
    }
    this._request.set(options);
    return new Promise<boolean>((resolve) => {
      this.resolver = resolve;
    });
  }

  /**
   * Single-OK notice (replaces `window.alert`, which is unreliable inside the
   * Electron renderer). Resolves once the user dismisses it — via the OK
   * button, the × close, Escape, or the scrim.
   */
  async notice(options: { title: string; message: string; dismissLabel?: string }): Promise<void> {
    await this.confirm({
      title: options.title,
      message: options.message,
      confirmLabel: options.dismissLabel ?? 'OK',
      noticeOnly: true,
    });
  }

  accept(): void {
    this.resolve(true);
  }

  cancel(): void {
    this.resolve(false);
  }

  private resolve(v: boolean): void {
    const r = this.resolver;
    this.resolver = null;
    this._request.set(null);
    r?.(v);
  }
}
