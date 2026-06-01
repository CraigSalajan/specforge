import { Injectable, signal } from '@angular/core';

/**
 * Top-level overlay/drawer state. Used by the header settings cog to open
 * the settings modal without a router.
 */
@Injectable({ providedIn: 'root' })
export class UiStateService {
  private readonly _settingsOpen = signal(false);

  readonly settingsOpen = this._settingsOpen.asReadonly();

  openSettings(): void {
    this._settingsOpen.set(true);
  }

  closeSettings(): void {
    this._settingsOpen.set(false);
  }

  toggleSettings(): void {
    this._settingsOpen.update((v) => !v);
  }
}
