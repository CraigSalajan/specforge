import { Injectable, inject } from '@angular/core';
import type { FileNode } from '../shared/types';
import { ConfirmDialogService } from './confirm-dialog.service';
import { EditorBufferService } from './editor-buffer.service';
import { InputDialogService } from './input-dialog.service';
import { IpcService } from './ipc.service';
import { OpenTabsService } from './open-tabs.service';
import { VaultService } from './vault.service';

/**
 * Create/rename/move/delete flows for vault files and folders, shared by the
 * vault tree (header buttons, context menu, drag-drop) and the command
 * palette. Single owner of the "prompt → mutate disk → refresh tree → fix up
 * open tabs / active file" sequence so the entry points cannot drift.
 *
 * Rename/move flush the editor buffer for the source file BEFORE touching
 * disk: the editor's switch-away flush writes to the path it loaded from, so
 * an unflushed dirty buffer would otherwise recreate the old file after the
 * rename. Deletes close the file's tab without flushing — flushing a
 * just-deleted file would resurrect it.
 */
@Injectable({ providedIn: 'root' })
export class VaultFileOpsService {
  private readonly ipc = inject(IpcService);
  private readonly vault = inject(VaultService);
  private readonly inputDialog = inject(InputDialogService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly editorBuffer = inject(EditorBufferService);
  private readonly openTabs = inject(OpenTabsService);

  /**
   * Prompts for a file name and creates (then opens) a markdown file inside
   * `dirPath` — the vault root when omitted. No-op without an open vault or
   * when the prompt is cancelled.
   */
  async createFile(dirPath?: string): Promise<void> {
    const parent = dirPath ?? this.vault.vaultPath();
    if (!parent) return;
    const name = await this.inputDialog.prompt({
      title: 'New File',
      label: 'File name',
      initialValue: '',
      placeholder: 'untitled.md',
      defaultValue: 'untitled.md',
      confirmLabel: 'Create',
    });
    if (!name) return;
    const filename = name.endsWith('.md') ? name : `${name}.md`;
    const target = joinPath(parent, filename);
    try {
      await this.ipc.createFile(target);
      await this.vault.refreshTree();
      this.vault.setActiveFile(target);
    } catch (err) {
      console.error('Failed to create file: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  /**
   * Prompts for a folder name and creates it inside `dirPath` — the vault
   * root when omitted. No-op without an open vault or when cancelled.
   */
  async createFolder(dirPath?: string): Promise<void> {
    const parent = dirPath ?? this.vault.vaultPath();
    if (!parent) return;
    const name = await this.inputDialog.prompt({
      title: 'New Folder',
      label: 'Folder name',
      initialValue: '',
      placeholder: 'new-folder',
      defaultValue: 'new-folder',
      confirmLabel: 'Create',
    });
    if (!name) return;
    const target = joinPath(parent, name);
    try {
      await this.ipc.createFolder(target);
      await this.vault.refreshTree();
    } catch (err) {
      console.error(
        'Failed to create folder: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  /** Prompts for a new name and renames `path`, re-pointing its open tab. */
  async renameFile(path: string): Promise<void> {
    const current = path.split(/[\\/]/).pop() ?? path;
    const next = await this.inputDialog.prompt({
      title: 'Rename File',
      label: 'New name',
      initialValue: current,
      confirmLabel: 'Rename',
    });
    if (!next || next === current) return;
    const finalName = next.endsWith('.md') ? next : `${next}.md`;
    const parent = path.slice(0, path.length - current.length);
    const newPath = `${parent}${finalName}`;
    try {
      await this.editorBuffer.flushIfDirty(path);
      await this.ipc.renameFile(path, newPath);
      await this.vault.refreshTree();
      this.openTabs.handleRename(path, newPath);
    } catch (err) {
      console.error('Failed to rename: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  /** Moves `sourcePath` into `targetDir` (drag-drop), re-pointing its tab. */
  async moveFile(sourcePath: string, targetDir: string): Promise<void> {
    const filename = sourcePath.split(/[\\/]/).pop() ?? sourcePath;
    const sourceParent = sourcePath.replace(/[\\/][^\\/]*$/, '');
    if (sourceParent === targetDir) return;
    const sep = targetDir.includes('\\') ? '\\' : '/';
    const newPath = `${targetDir}${sep}${filename}`;
    try {
      await this.editorBuffer.flushIfDirty(sourcePath);
      await this.ipc.renameFile(sourcePath, newPath);
      await this.vault.refreshTree();
      this.openTabs.handleRename(sourcePath, newPath);
    } catch (err) {
      console.error('Failed to move: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  /** Confirm-and-delete for a single file; closes its open tab on success. */
  async deleteFile(path: string): Promise<void> {
    const name = path.split(/[\\/]/).pop() ?? path;
    const ok = await this.confirmDialog.confirm({
      title: 'Delete File',
      message: `Delete "${name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.ipc.deleteFile(path);
      await this.vault.refreshTree();
      this.openTabs.handleDelete(path);
    } catch (err) {
      console.error('Failed to delete: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  /** Confirm-and-delete for a folder; closes any open tabs underneath it. */
  async deleteFolder(node: FileNode): Promise<void> {
    const count = countDescendants(node);
    const message =
      count === 0
        ? `Delete empty folder "${node.name}"?`
        : `Delete folder "${node.name}" and everything inside it?\n\nThis will permanently delete ${count} item(s). This cannot be undone.`;
    const ok = await this.confirmDialog.confirm({
      title: 'Delete Folder',
      message,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await this.ipc.deleteFolder(node.path);
      await this.vault.refreshTree();
      this.openTabs.handleFolderDelete(node.path);
    } catch (err) {
      console.error(
        'Failed to delete folder: ' + (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}

/** Joins with the separator style the parent path already uses. */
function joinPath(parent: string, child: string): string {
  const sep = parent.includes('\\') ? '\\' : '/';
  return `${parent}${sep}${child}`;
}

/** Total node count under a folder node (for the delete confirmation copy). */
function countDescendants(node: FileNode): number {
  const children = node.children ?? [];
  let count = children.length;
  for (const child of children) {
    count += countDescendants(child);
  }
  return count;
}
