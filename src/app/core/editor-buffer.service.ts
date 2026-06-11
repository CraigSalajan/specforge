import { Injectable } from '@angular/core';
import { samePath } from '../shared/path-utils';

/**
 * Contract the single EditorComponent instance fulfils so services outside
 * the editor can reason about (and flush) its unsaved buffer without a direct
 * component reference.
 */
export interface EditorBufferDelegate {
  /** Absolute path of the file currently held in the buffer, or null. */
  loadedPath(): string | null;
  /** True when the buffer differs from what is on disk. */
  isDirty(): boolean;
  /** Writes the buffer to disk if dirty; resolves once the write settled. */
  flush(): Promise<void>;
}

/**
 * Seam between the editor buffer and the AI harness. AI read paths call
 * {@link flushIfDirty} immediately before reading from disk so unsaved edits
 * are never invisible to the model (flush-before-read).
 */
@Injectable({ providedIn: 'root' })
export class EditorBufferService {
  private delegate: EditorBufferDelegate | null = null;

  register(delegate: EditorBufferDelegate): void {
    this.delegate = delegate;
  }

  unregister(delegate: EditorBufferDelegate): void {
    if (this.delegate === delegate) {
      this.delegate = null;
    }
  }

  /**
   * Flushes the editor buffer to disk when it holds unsaved changes — for any
   * file when `absPath` is omitted, or only when the loaded file matches
   * `absPath` (case-insensitive, separator-normalized). Safe no-op when no
   * editor is registered or the buffer is clean.
   */
  async flushIfDirty(absPath?: string): Promise<void> {
    const delegate = this.delegate;
    if (!delegate || !delegate.isDirty()) return;
    const loaded = delegate.loadedPath();
    if (!loaded) return;
    if (absPath !== undefined && !samePath(loaded, absPath)) return;
    await delegate.flush();
  }
}
