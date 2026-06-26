import { Injectable, signal } from '@angular/core';
import type { CanonicalItem } from '../../../electron/sync/canonical-item';
import type { PushResult, ItemProgressEvent } from '../../../electron/sync/executor';

/** Which list the palette opens on. `>`-prefixed queries switch live. */
export type PaletteMode = 'files' | 'commands';

/**
 * The combined decompose-and-push review payload (TER-37). When set, the
 * push-preview modal runs in "combined" mode: it previews the push from the
 * in-memory `items` (not the on-disk file), shows the doc-save `summary`, and —
 * on approve — runs `onApprove()` (which writes the doc, then pushes) rather than
 * the push-only path. `null` is the default (whole-vault / per-file push-only).
 */
export interface CombinedPushRequest {
  /** The vault-relative markdown file the proposed content will be written to. */
  filePath: string;
  /** Pre-built canonical items from the proposed (not-yet-written) content. */
  items: CanonicalItem[];
  /** Human summary of what will be written to the doc. */
  summary: {
    /** Number of NEW stories that will be added. */
    storiesAdded: number;
    /** Whether a new `## User Stories` section heading will be created. */
    sectionCreated: boolean;
  };
  /**
   * Runs the approved action: write the proposed doc, then execute the per-file
   * push. Returns the {@link PushResult} so the modal can show per-item outcomes,
   * or throws on failure. The modal owns the approve/loading/error UI; this
   * callback owns write-then-push.
   *
   * The optional `onProgress` is forwarded into the underlying
   * `executePushFromItems` so the modal can render a LIVE per-item list (TER-37
   * live progress) as the push runs, rather than waiting for the resolved result.
   */
  onApprove: (onProgress?: (ev: ItemProgressEvent) => void) => Promise<PushResult>;
}

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

  // Push-preview modal (TER-32): the approval surface for pushing the active
  // vault to a PM provider. A plain visibility flag — the preview component owns
  // its own internal state machine and resets it on open/close.
  private readonly _pushPreviewOpen = signal(false);

  readonly pushPreviewOpen = this._pushPreviewOpen.asReadonly();

  // Per-file push scope (TER-37): when set, the push-preview modal is scoped to
  // ONLY this vault-relative markdown file's items (any folder) rather than the
  // whole vault. `null` means whole-vault (the TER-32 default). Set alongside
  // `pushPreviewOpen` by `openPushPreviewForFile` and cleared on close so the
  // next whole-vault open is unscoped.
  private readonly _pushPreviewFilePath = signal<string | null>(null);

  readonly pushPreviewFilePath = this._pushPreviewFilePath.asReadonly();

  // Combined decompose-and-push review (TER-37): when set, the push-preview modal
  // runs in combined mode (preview from in-memory items, doc-save summary, and a
  // write-then-push approve callback). `null` for the push-only modes. Set by
  // `openCombinedPushReview` and cleared on close.
  private readonly _combinedPushRequest = signal<CombinedPushRequest | null>(null);

  readonly combinedPushRequest = this._combinedPushRequest.asReadonly();

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

  /** Opens the push-preview modal scoped to the WHOLE vault (the TER-32 path). */
  openPushPreview(): void {
    this._pushPreviewFilePath.set(null);
    this._pushPreviewOpen.set(true);
  }

  /**
   * Opens the push-preview modal scoped to ONLY `filePath` (a vault-relative
   * markdown file, any folder). The preview/execute calls thread this path so
   * just that file's items are pushed (TER-37). The scope is reset on close.
   */
  openPushPreviewForFile(filePath: string): void {
    this._combinedPushRequest.set(null);
    this._pushPreviewFilePath.set(filePath);
    this._pushPreviewOpen.set(true);
  }

  /**
   * Opens the push-preview modal in COMBINED mode (TER-37): the single review for
   * `/decompose-stories`. The modal previews the push from `req.items`, shows the
   * doc-save summary, and runs `req.onApprove()` (write-then-push) on approve.
   */
  openCombinedPushReview(req: CombinedPushRequest): void {
    this._pushPreviewFilePath.set(req.filePath);
    this._combinedPushRequest.set(req);
    this._pushPreviewOpen.set(true);
  }

  closePushPreview(): void {
    this._pushPreviewOpen.set(false);
    // Reset the per-file + combined scope so the next whole-vault open is unscoped.
    this._pushPreviewFilePath.set(null);
    this._combinedPushRequest.set(null);
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
