import { Injectable, signal } from '@angular/core';

/**
 * Read-only editor status published for chrome outside the editor (today: the
 * tab bar's dirty dot). The single EditorComponent instance writes it from an
 * effect over its `isDirty` computed; everyone else only reads.
 *
 * Only the ACTIVE file can ever be dirty: the editor keeps one live buffer
 * and flushes it on every switch, so background tabs are clean by invariant.
 */
@Injectable({ providedIn: 'root' })
export class EditorStatusService {
  private readonly _activeDirty = signal(false);

  /** True while the active file's buffer differs from its saved baseline. */
  readonly activeDirty = this._activeDirty.asReadonly();

  setActiveDirty(dirty: boolean): void {
    this._activeDirty.set(dirty);
  }
}
