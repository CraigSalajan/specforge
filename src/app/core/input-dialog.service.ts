import { Injectable, signal } from '@angular/core';

/**
 * Options describing a single text-input prompt rendered by the in-app
 * dialog. Mirrors the API shape of `window.prompt`, but works inside the
 * Electron renderer (where `window.prompt` is unsupported and returns null).
 */
export interface InputDialogRequest {
  title: string;
  label?: string;
  initialValue: string;
  confirmLabel?: string;
  placeholder?: string;
  defaultValue?: string;
}

/**
 * Drives the single `<app-input-dialog />` mounted at the app root. Components
 * call `prompt()` and await a Promise that resolves with the entered string,
 * or `null` when the user cancels.
 */
@Injectable({ providedIn: 'root' })
export class InputDialogService {
  private readonly _request = signal<InputDialogRequest | null>(null);

  readonly request = this._request.asReadonly();

  private resolver: ((value: string | null) => void) | null = null;

  /**
   * Opens the dialog and resolves once the user confirms or cancels. If a
   * prompt is already open, the previous one is cancelled (resolved with null)
   * first so no pending promise is ever leaked.
   */
  prompt(options: InputDialogRequest): Promise<string | null> {
    if (this.resolver) {
      const previous = this.resolver;
      this.resolver = null;
      previous(null);
    }
    this._request.set(options);
    return new Promise<string | null>((resolve) => {
      this.resolver = resolve;
    });
  }

  confirm(value: string): void {
    this.resolve(value);
  }

  cancel(): void {
    this.resolve(null);
  }

  private resolve(value: string | null): void {
    const resolver = this.resolver;
    this.resolver = null;
    this._request.set(null);
    resolver?.(value);
  }
}
