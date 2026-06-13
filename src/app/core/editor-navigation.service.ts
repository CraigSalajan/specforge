import { Injectable, inject, signal } from '@angular/core';
import { VaultService } from './vault.service';

/**
 * A request to scroll the editor to a specific line of a file. `seq` is a
 * monotonic id so repeating the same jump (same file, same line) still
 * produces a distinct signal value and re-triggers the editor's effect.
 */
export interface EditorRevealRequest {
  /** Absolute path of the file to reveal in. */
  filePath: string;
  /** 1-based line to center and briefly highlight. */
  line: number;
  /** Monotonic request id; makes every request referentially unique. */
  seq: number;
}

/**
 * Cross-feature editor navigation: lets non-editor surfaces (AI citation
 * badges today) open a file AND land on a specific line.
 *
 * The handshake is a "pending reveal" signal: `openFileAtLine` records the
 * request and activates the file; the editor consumes the request once the
 * target document is actually loaded into its CodeMirror view — covering both
 * the async file load and the file-already-open case (where the active-file
 * signal does not change at all).
 */
@Injectable({ providedIn: 'root' })
export class EditorNavigationService {
  private readonly vault = inject(VaultService);

  private readonly _pendingReveal = signal<EditorRevealRequest | null>(null);
  readonly pendingReveal = this._pendingReveal.asReadonly();

  private seq = 0;

  /**
   * Opens `absPath` in the editor and queues a reveal of `line` (1-based,
   * clamped by the editor against the loaded document). The reveal is set
   * before the active file so the editor never observes the new file without
   * its pending target.
   */
  openFileAtLine(absPath: string, line: number): void {
    this._pendingReveal.set({ filePath: absPath, line, seq: ++this.seq });
    this.vault.setActiveFile(absPath);
  }

  /**
   * Marks `request` as handled. No-op when a newer request superseded it, so
   * a stale consumer can never clear a jump it did not perform.
   */
  consume(request: EditorRevealRequest): void {
    if (this._pendingReveal() === request) {
      this._pendingReveal.set(null);
    }
  }
}
