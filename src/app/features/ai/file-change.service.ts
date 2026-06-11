import { Injectable, inject, signal } from '@angular/core';
import type { AiChangeType } from '../../shared/types';
import { EditorBufferService } from '../../core/editor-buffer.service';
import { IpcService } from '../../core/ipc.service';
import { VaultService } from '../../core/vault.service';
import { threeWayMerge } from '../../shared/merge-utils';
import { isSafeRelPath, relToAbs } from './providers/path-utils';

export interface ApplyChangeInput {
  sessionId: number | null;
  relPath: string;
  newRelPath?: string | null;
  changeType: AiChangeType;
  beforeContent: string | null;
  afterContent: string | null;
}

/**
 * Applies and undoes AI-proposed file changes against the vault.
 *
 * Phase 3 safety model:
 *  - Renderer-side validation rejects `..`, absolute paths, drive letters.
 *  - Main process re-validates via `assertWithinVault` before any write,
 *    so even a malicious renderer cannot escape the vault root.
 *  - Every applied change is recorded in `ai_file_changes` with both the
 *    before and after content snapshots so it can be undone losslessly.
 *  - Cancelled proposals are recorded with `applied=0` so they show up in
 *    the change ledger as a paper trail.
 */
@Injectable({ providedIn: 'root' })
export class FileChangeService {
  private readonly ipc = inject(IpcService);
  private readonly vault = inject(VaultService);
  private readonly editorBuffer = inject(EditorBufferService);

  private readonly _undoing = signal(false);
  private readonly _error = signal<string | null>(null);
  readonly undoing = this._undoing.asReadonly();
  readonly error = this._error.asReadonly();

  async resolveBeforeContent(relPath: string): Promise<string | null> {
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath || !isSafeRelPath(relPath)) return null;
    try {
      const abs = relToAbs(vaultPath, relPath);
      // Flush-before-read: proposal bases must include unsaved editor edits.
      await this.editorBuffer.flushIfDirty(abs);
      return await this.ipc.readFile(abs);
    } catch {
      return null;
    }
  }

  async fileExists(relPath: string): Promise<boolean> {
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath || !isSafeRelPath(relPath)) return false;
    try {
      const abs = relToAbs(vaultPath, relPath);
      await this.ipc.readFile(abs);
      return true;
    } catch {
      return false;
    }
  }

  async apply(input: ApplyChangeInput): Promise<{ absPath: string | null }> {
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) throw new Error('No active vault.');
    if (!isSafeRelPath(input.relPath)) {
      throw new Error(`Unsafe path rejected: ${input.relPath}`);
    }

    this._error.set(null);

    const absPath = relToAbs(vaultPath, input.relPath);

    // What actually lands on disk: an apply-time merge can shift both sides.
    let beforeContent = input.beforeContent;
    let afterContent = input.afterContent;

    try {
      switch (input.changeType) {
        case 'create':
          await this.ipc.createFile(absPath);
          await this.ipc.writeFile(absPath, input.afterContent ?? '');
          break;
        case 'edit': {
          const resolved = await this.resolveEditWrite(absPath, input);
          beforeContent = resolved.before;
          afterContent = resolved.after;
          await this.ipc.writeFile(absPath, resolved.after);
          break;
        }
        case 'delete':
          await this.ipc.deleteFile(absPath);
          break;
        case 'rename': {
          if (!input.newRelPath || !isSafeRelPath(input.newRelPath)) {
            throw new Error('Rename requires a safe target path.');
          }
          const newAbs = relToAbs(vaultPath, input.newRelPath);
          await this.ipc.renameFile(absPath, newAbs);
          break;
        }
      }

      await this.ipc.aiHistoryRecord({
        sessionId: input.sessionId,
        vaultPath,
        relPath: input.relPath,
        newRelPath: input.newRelPath ?? null,
        changeType: input.changeType,
        beforeContent,
        afterContent,
        applied: true,
      });

      await this.vault.refreshTree();
      return { absPath };
    } catch (err) {
      this._error.set(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /**
   * Resolves what an `edit` apply should write. The proposal was computed
   * against `input.beforeContent`; if disk has moved on since (user typing,
   * another AI apply, an external tool), the proposal's changes are replayed
   * on top of the current content via three-way merge instead of silently
   * clobbering it. Returns the actual disk baseline alongside the content so
   * the history record stays losslessly undoable.
   */
  private async resolveEditWrite(
    absPath: string,
    input: ApplyChangeInput,
  ): Promise<{ before: string | null; after: string }> {
    // Flush-before-read: unsaved editor edits are part of the disk truth the
    // proposal must merge against.
    await this.editorBuffer.flushIfDirty(absPath);

    const proposed = input.afterContent ?? '';
    let current: string | null = null;
    try {
      current = await this.ipc.readFile(absPath);
    } catch {
      current = null; // file missing — fall through to a plain write
    }

    if (current === null || input.beforeContent === null || current === input.beforeContent) {
      return { before: current ?? input.beforeContent, after: proposed };
    }

    const merged = threeWayMerge(input.beforeContent, current, proposed);
    if (!merged.ok) {
      throw new Error(
        'File changed on disk since this proposal was created and the changes conflict. Re-generate the proposal.',
      );
    }
    return { before: current, after: merged.text };
  }

  /**
   * Record a cancelled/proposed change without touching the vault.
   */
  async recordProposed(input: ApplyChangeInput): Promise<void> {
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) return;
    if (!isSafeRelPath(input.relPath)) return;
    try {
      await this.ipc.aiHistoryRecord({
        sessionId: input.sessionId,
        vaultPath,
        relPath: input.relPath,
        newRelPath: input.newRelPath ?? null,
        changeType: input.changeType,
        beforeContent: input.beforeContent,
        afterContent: input.afterContent,
        applied: false,
      });
    } catch (err) {
      console.warn('[ai] failed to record proposed change', err);
    }
  }

  /**
   * Undoes the most recently applied AI change for the current vault.
   * Returns the change that was reverted, or null if there was nothing to undo.
   *
   * Phase 3 decision: after undo we flip the existing row to `applied=0`
   * rather than inserting a fresh "undo" row. The change ledger reflects
   * "current state of the world" — if a user wants forensic history they can
   * inspect the `created_at` order and see the gap. Simpler audit trail wins
   * for now.
   */
  async undoLastApplied(): Promise<{ relPath: string; changeType: AiChangeType } | null> {
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) return null;
    this._undoing.set(true);
    this._error.set(null);
    try {
      const last = await this.ipc.aiHistoryLatestApplied(vaultPath);
      if (!last) return null;

      const absPath = relToAbs(vaultPath, last.relPath);

      switch (last.changeType) {
        case 'create':
          try {
            await this.ipc.deleteFile(absPath);
          } catch (err) {
            // File may already be gone; record undo anyway.
            console.warn('[ai] undo create: delete failed', err);
          }
          break;
        case 'edit':
          await this.ipc.writeFile(absPath, last.beforeContent ?? '');
          break;
        case 'delete':
          if (last.beforeContent == null) {
            throw new Error(
              'Cannot undo delete: original content was not captured. The file is lost.',
            );
          }
          await this.ipc.writeFile(absPath, last.beforeContent);
          break;
        case 'rename': {
          if (last.newRelPath) {
            if (await this.fileExists(last.relPath)) {
              throw new Error(
                `Cannot undo rename: a file now exists at ${last.relPath}.`,
              );
            }
            const newAbs = relToAbs(vaultPath, last.newRelPath);
            await this.ipc.renameFile(newAbs, absPath);
          }
          break;
        }
      }

      await this.ipc.aiHistoryMarkApplied(last.id, false);
      await this.vault.refreshTree();
      return { relPath: last.relPath, changeType: last.changeType };
    } catch (err) {
      this._error.set(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      this._undoing.set(false);
    }
  }
}
