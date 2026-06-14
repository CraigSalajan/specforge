import { Injectable, signal } from '@angular/core';

/** Which list the palette opens on. `>`-prefixed queries switch live. */
export type PaletteMode = 'files' | 'commands';

/** Which view the left sidebar shows (session-only, not persisted). */
export type SidebarView = 'files' | 'search' | 'outline' | 'links' | 'docs';

/**
 * An open (or re-open) request for the palette overlay. `seq` is monotonic so
 * re-invoking the shortcut while the palette is already open still produces a
 * distinct signal value — the palette resets its query and re-focuses.
 */
export interface PaletteRequest {
  mode: PaletteMode;
  seq: number;
}

/**
 * Top-level overlay/drawer state. Used by the header settings cog to open
 * the settings modal without a router, by the global Ctrl+P / Ctrl+Shift+P
 * shortcuts to drive the quick switcher / command palette, and as the seam
 * for cross-feature focus requests (palette commands focusing the editor or
 * the AI composer).
 */
@Injectable({ providedIn: 'root' })
export class UiStateService {
  private readonly _settingsOpen = signal(false);

  readonly settingsOpen = this._settingsOpen.asReadonly();

  private readonly _paletteRequest = signal<PaletteRequest | null>(null);
  private paletteSeq = 0;

  readonly paletteRequest = this._paletteRequest.asReadonly();

  // Left-sidebar view (files / search / outline / links). All views stay
  // mounted in the shell (hidden, not destroyed), so this is pure display
  // state.
  private readonly _sidebarView = signal<SidebarView>('files');

  readonly sidebarView = this._sidebarView.asReadonly();

  // Monotonic focus-request counters. Consumers (editor, AI panel, search
  // panel) keep the last seq they handled; a bump means "focus yourself now".
  private readonly _editorFocusRequests = signal(0);
  private readonly _composerFocusRequests = signal(0);
  private readonly _searchFocusRequests = signal(0);

  readonly editorFocusRequests = this._editorFocusRequests.asReadonly();
  readonly composerFocusRequests = this._composerFocusRequests.asReadonly();
  readonly searchFocusRequests = this._searchFocusRequests.asReadonly();

  openSettings(): void {
    this._settingsOpen.set(true);
  }

  closeSettings(): void {
    this._settingsOpen.set(false);
  }

  toggleSettings(): void {
    this._settingsOpen.update((v) => !v);
  }

  /** Opens the palette, or re-arms it in `mode` when it is already open. */
  openPalette(mode: PaletteMode): void {
    this._paletteRequest.set({ mode, seq: ++this.paletteSeq });
  }

  closePalette(): void {
    this._paletteRequest.set(null);
  }

  /**
   * Switches the left sidebar to `view`. Activating the search view always
   * bumps the focus counter, so re-invoking "Search in vault" (tab click,
   * palette command, or Ctrl+Shift+F) re-focuses the query input even when
   * the view is already showing.
   */
  setSidebarView(view: SidebarView): void {
    this._sidebarView.set(view);
    if (view === 'search') this._searchFocusRequests.update((n) => n + 1);
  }

  /** Asks the editor to focus its CodeMirror view (once a file is open). */
  requestEditorFocus(): void {
    this._editorFocusRequests.update((n) => n + 1);
  }

  /** Asks the AI panel to focus its composer textarea. */
  requestComposerFocus(): void {
    this._composerFocusRequests.update((n) => n + 1);
  }
}
