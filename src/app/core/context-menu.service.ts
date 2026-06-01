import { Injectable, signal } from '@angular/core';

/**
 * A single entry rendered in the context menu. Either a clickable action row
 * or a visual separator between groups of actions.
 */
export type ContextMenuItem =
  | { type: 'item'; label: string; danger?: boolean; action: () => void }
  | { type: 'separator' };

/**
 * Position (viewport coordinates) and contents of the open context menu.
 */
export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/**
 * Drives the single `<app-context-menu />` mounted at the app root. Components
 * call `open()` with viewport coordinates and a list of items; the menu closes
 * itself (or via `close()`) once an item is chosen or the user dismisses it.
 */
@Injectable({ providedIn: 'root' })
export class ContextMenuService {
  private readonly _state = signal<ContextMenuState | null>(null);

  readonly state = this._state.asReadonly();

  open(x: number, y: number, items: ContextMenuItem[]): void {
    this._state.set({ x, y, items });
  }

  close(): void {
    this._state.set(null);
  }
}
