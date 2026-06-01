import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import type { FileNode } from '../../shared/types';
import { IpcService } from '../../core/ipc.service';
import { VaultService } from '../../core/vault.service';
import { InputDialogService } from '../../core/input-dialog.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { ContextMenuService, type ContextMenuItem } from '../../core/context-menu.service';
import { FileTreeNodeComponent } from './file-tree-node.component';

@Component({
  selector: 'app-vault-tree',
  standalone: true,
  imports: [FileTreeNodeComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex h-full flex-col bg-surface-1 text-text-primary">
      <div class="flex items-center justify-between border-b border-border-subtle px-3 py-2">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-text-secondary">Vault</h2>
        @if (hasVault()) {
          <span class="flex items-center gap-1">
            <button
              type="button"
              class="rounded px-1.5 py-0.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary"
              title="New file"
              (click)="onCreateFile()">
              +
            </button>
            <button
              type="button"
              class="rounded px-1.5 py-0.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary"
              title="New folder"
              (click)="onCreateFolder()">
              ＋▣
            </button>
          </span>
        }
      </div>

      @if (!hasVault()) {
        <div class="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
          <p class="text-xs text-text-muted">No vault selected</p>
          <button
            type="button"
            class="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"
            (click)="onSelectVault()">
            Open Vault
          </button>
        </div>
      } @else {
        <div class="truncate border-b border-border-subtle px-3 py-1.5 text-sm font-mono text-text-muted" [title]="vaultPath() ?? ''">
          {{ vaultPath() }}
        </div>
        <div
          class="flex-1 overflow-y-auto py-1"
          (contextmenu)="onBackgroundContextMenu($event)"
          (dragover)="onBackgroundDragOver($event)"
          (drop)="onBackgroundDrop($event)">
          @if (isLoading()) {
            <div class="px-3 py-2 text-xs text-text-muted">Loading...</div>
          } @else if (tree().length === 0) {
            <div class="px-3 py-2 text-xs text-text-muted">Empty vault. Create a .md file to get started.</div>
          } @else {
            @for (node of tree(); track node.path) {
              <app-file-tree-node
                [node]="node"
                [activePath]="activePath()"
                [depth]="0"
                (fileSelected)="fileSelected.emit($event)"
                (renameRequested)="onRename($event)"
                (deleteRequested)="onDelete($event)"
                (createFileRequested)="onCreateFileInside($event)"
                (createFolderRequested)="onCreateFolderInside($event)"
                (contextMenuRequested)="onNodeContextMenu($event)"
                (moveRequested)="onMove($event)" />
            }
          }
        </div>
        <div class="border-t border-border-subtle px-3 py-1.5 text-sm text-text-muted">
          <button
            type="button"
            class="hover:text-text-primary"
            (click)="onChangeVault()">
            Change vault
          </button>
        </div>
      }
    </div>
  `,
})
export class VaultTreeComponent {
  private readonly vault = inject(VaultService);
  private readonly ipc = inject(IpcService);
  private readonly inputDialog = inject(InputDialogService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly contextMenu = inject(ContextMenuService);

  readonly fileSelected = output<string>();

  readonly hasVault = this.vault.hasVault;
  readonly vaultPath = this.vault.vaultPath;
  readonly tree = this.vault.tree;
  readonly isLoading = this.vault.isLoading;
  readonly activePath = this.vault.activeFilePath;

  onSelectVault(): void {
    void this.vault.selectVault();
  }

  onChangeVault(): void {
    void this.vault.selectVault();
  }

  onBackgroundDragOver(evt: DragEvent): void {
    if (!this.hasVault()) return;
    if (!evt.dataTransfer?.types.includes('application/x-specforge-path')) return;
    evt.preventDefault();
  }

  onBackgroundDrop(evt: DragEvent): void {
    evt.preventDefault();
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) return;
    const src = evt.dataTransfer?.getData('application/x-specforge-path');
    if (src) void this.onMove({ sourcePath: src, targetDir: vaultPath });
  }

  async onMove({ sourcePath, targetDir }: { sourcePath: string; targetDir: string }): Promise<void> {
    const filename = sourcePath.split(/[\\/]/).pop() ?? sourcePath;
    const sourceParent = sourcePath.replace(/[\\/][^\\/]*$/, '');
    if (sourceParent === targetDir) return;
    const sep = targetDir.includes('\\') ? '\\' : '/';
    const newPath = `${targetDir}${sep}${filename}`;
    try {
      await this.ipc.renameFile(sourcePath, newPath);
      await this.vault.refreshTree();
      if (this.vault.activeFilePath() === sourcePath) this.fileSelected.emit(newPath);
    } catch (err) {
      console.error('Failed to move: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  onBackgroundContextMenu(evt: MouseEvent): void {
    if (!this.hasVault()) return;
    evt.preventDefault();
    this.contextMenu.open(evt.clientX, evt.clientY, [
      { type: 'item', label: 'New File', action: () => this.onCreateFile() },
      { type: 'item', label: 'New Folder', action: () => this.onCreateFolder() },
    ]);
  }

  onNodeContextMenu(evt: { node: FileNode; x: number; y: number }): void {
    const { node } = evt;
    let items: ContextMenuItem[];
    if (node.isDirectory) {
      items = [
        { type: 'item', label: 'New File', action: () => this.onCreateFileInside(node.path) },
        { type: 'item', label: 'New Folder', action: () => this.onCreateFolderInside(node.path) },
        { type: 'separator' },
        { type: 'item', label: 'Delete', danger: true, action: () => this.onDeleteFolder(node) },
      ];
    } else {
      const parentDir = node.path.replace(/[\\/][^\\/]*$/, '');
      items = [
        { type: 'item', label: 'New File', action: () => this.onCreateFileInside(parentDir) },
        { type: 'item', label: 'New Folder', action: () => this.onCreateFolderInside(parentDir) },
        { type: 'separator' },
        { type: 'item', label: 'Rename', action: () => this.onRename(node.path) },
        { type: 'item', label: 'Delete', danger: true, action: () => this.onDelete(node.path) },
      ];
    }
    this.contextMenu.open(evt.x, evt.y, items);
  }

  async onCreateFile(): Promise<void> {
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) return;
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
    const sep = vaultPath.includes('\\') ? '\\' : '/';
    const target = `${vaultPath}${sep}${filename}`;
    try {
      await this.ipc.createFile(target);
      await this.vault.refreshTree();
      this.fileSelected.emit(target);
    } catch (err) {
      console.error('Failed to create file: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  async onCreateFolder(): Promise<void> {
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) return;
    const name = await this.inputDialog.prompt({
      title: 'New Folder',
      label: 'Folder name',
      initialValue: '',
      placeholder: 'new-folder',
      defaultValue: 'new-folder',
      confirmLabel: 'Create',
    });
    if (!name) return;
    const sep = vaultPath.includes('\\') ? '\\' : '/';
    const target = `${vaultPath}${sep}${name}`;
    try {
      await this.ipc.createFolder(target);
      await this.vault.refreshTree();
    } catch (err) {
      console.error('Failed to create folder: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  async onCreateFileInside(dirPath: string): Promise<void> {
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
    const sep = dirPath.includes('\\') ? '\\' : '/';
    const target = `${dirPath}${sep}${filename}`;
    try {
      await this.ipc.createFile(target);
      await this.vault.refreshTree();
      this.fileSelected.emit(target);
    } catch (err) {
      console.error('Failed to create file: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  async onCreateFolderInside(dirPath: string): Promise<void> {
    const name = await this.inputDialog.prompt({
      title: 'New Folder',
      label: 'Folder name',
      initialValue: '',
      placeholder: 'new-folder',
      defaultValue: 'new-folder',
      confirmLabel: 'Create',
    });
    if (!name) return;
    const sep = dirPath.includes('\\') ? '\\' : '/';
    const target = `${dirPath}${sep}${name}`;
    try {
      await this.ipc.createFolder(target);
      await this.vault.refreshTree();
    } catch (err) {
      console.error('Failed to create folder: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  async onRename(path: string): Promise<void> {
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
      await this.ipc.renameFile(path, newPath);
      await this.vault.refreshTree();
    } catch (err) {
      console.error('Failed to rename: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  async onDelete(path: string): Promise<void> {
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
    } catch (err) {
      console.error('Failed to delete: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  private countDescendants(n: FileNode): number {
    const children = n.children ?? [];
    let count = children.length;
    for (const child of children) {
      count += this.countDescendants(child);
    }
    return count;
  }

  async onDeleteFolder(node: FileNode): Promise<void> {
    const count = this.countDescendants(node);
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
    } catch (err) {
      console.error('Failed to delete folder: ' + (err instanceof Error ? err.message : String(err)));
    }
  }
}
