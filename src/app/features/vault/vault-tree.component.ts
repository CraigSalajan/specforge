import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import type { FileNode } from '../../shared/types';
import { IpcService } from '../../core/ipc.service';
import { VaultService } from '../../core/vault.service';
import { VaultFileOpsService } from '../../core/vault-file-ops.service';
import { ContextMenuService, type ContextMenuItem } from '../../core/context-menu.service';
import { PdfExportService } from '../../core/pdf-export.service';
import { FileTreeNodeComponent } from './file-tree-node.component';
import { TreeExpansionService } from './tree-expansion.service';

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
            @if (hasFolders()) {
              <button
                type="button"
                class="rounded px-1.5 py-0.5 text-xs text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                [title]="anyCollapsed() ? 'Expand all folders' : 'Collapse all folders'"
                [attr.aria-label]="anyCollapsed() ? 'Expand all folders' : 'Collapse all folders'"
                (click)="onToggleExpandAll()">
                {{ anyCollapsed() ? '▾' : '▸' }}
              </button>
            }
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
              ⊞
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
  private readonly fileOps = inject(VaultFileOpsService);
  private readonly ipc = inject(IpcService);
  private readonly contextMenu = inject(ContextMenuService);
  private readonly pdfExport = inject(PdfExportService);
  private readonly expansion = inject(TreeExpansionService);

  readonly fileSelected = output<string>();

  readonly hasVault = this.vault.hasVault;
  readonly vaultPath = this.vault.vaultPath;
  readonly tree = this.vault.tree;
  readonly isLoading = this.vault.isLoading;
  readonly activePath = this.vault.activeFilePath;
  readonly anyCollapsed = this.expansion.anyCollapsed;
  readonly hasFolders = this.expansion.hasFolders;

  onSelectVault(): void {
    void this.vault.selectVault();
  }

  onChangeVault(): void {
    void this.vault.selectVault();
  }

  onToggleExpandAll(): void {
    this.expansion.toggleAll();
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
    await this.fileOps.moveFile(sourcePath, targetDir);
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
        { type: 'item', label: 'Export to PDF…', action: () => this.onExportPdf(node.path) },
        { type: 'item', label: 'Delete', danger: true, action: () => this.onDelete(node.path) },
      ];
    }
    this.contextMenu.open(evt.x, evt.y, items);
  }

  // Creation flows live in VaultFileOpsService (shared with the command
  // palette); the service opens created files via VaultService directly.
  async onCreateFile(): Promise<void> {
    await this.fileOps.createFile();
  }

  async onCreateFolder(): Promise<void> {
    await this.fileOps.createFolder();
  }

  async onCreateFileInside(dirPath: string): Promise<void> {
    await this.fileOps.createFile(dirPath);
  }

  async onCreateFolderInside(dirPath: string): Promise<void> {
    await this.fileOps.createFolder(dirPath);
  }

  async onExportPdf(path: string): Promise<void> {
    // The vault only contains .md files, but guard anyway.
    if (!path.toLowerCase().endsWith('.md')) return;
    try {
      const content = await this.ipc.readFile(path);
      const result = await this.pdfExport.exportMarkdown(content, path);
      if (!result.success && !result.canceled) {
        console.error('Failed to export PDF: ' + (result.error ?? 'Unknown error'));
      }
    } catch (err) {
      console.error('Failed to export PDF: ' + (err instanceof Error ? err.message : String(err)));
    }
  }

  // Rename/move/delete flows live in VaultFileOpsService too: they flush the
  // editor buffer where needed and keep open tabs / the active file pointed
  // at the right paths.
  async onRename(path: string): Promise<void> {
    await this.fileOps.renameFile(path);
  }

  async onDelete(path: string): Promise<void> {
    await this.fileOps.deleteFile(path);
  }

  async onDeleteFolder(node: FileNode): Promise<void> {
    await this.fileOps.deleteFolder(node);
  }
}
