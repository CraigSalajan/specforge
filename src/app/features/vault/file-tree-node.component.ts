import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { FileNode } from '../../shared/types';

@Component({
  selector: 'app-file-tree-node',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div>
      @if (node().isDirectory) {
        <div
          class="group flex cursor-pointer select-none items-center gap-1 px-2 py-0.5 text-xs hover:bg-surface-2"
          [class.bg-surface-3]="isActive() || isDragOver()"
          [class.text-text-primary]="isActive()"
          [class.ring-1]="isDragOver()"
          [class.ring-accent]="isDragOver()"
          [style.padding-left.px]="indent()"
          (click)="onClick()"
          (contextmenu)="onContextMenu($event)"
          (dragover)="onDragOver($event)"
          (dragleave)="onDragLeave()"
          (drop)="onDrop($event)">
          <span class="inline-block w-3 text-text-muted">{{ isExpanded() ? '▾' : '▸' }}</span>
          <span class="text-text-muted">▣</span>
          <span class="flex-1 truncate">{{ node().name }}</span>
          <span class="invisible flex gap-1 group-hover:visible">
            <button
              type="button"
              class="text-text-muted hover:text-text-primary"
              title="New file in folder"
              (click)="onCreateFileInside($event)">＋·</button>
            <button
              type="button"
              class="text-text-muted hover:text-text-primary"
              title="New folder in folder"
              (click)="onCreateFolderInside($event)">＋▣</button>
          </span>
        </div>
      } @else {
        <div
          class="group flex cursor-pointer select-none items-center gap-1 px-2 py-0.5 text-xs hover:bg-surface-2"
          [class.bg-surface-3]="isActive()"
          [class.text-text-primary]="isActive()"
          [style.padding-left.px]="indent()"
          draggable="true"
          (click)="onClick()"
          (contextmenu)="onContextMenu($event)"
          (dragstart)="onDragStart($event)">
          <span class="inline-block w-3"></span>
          <span class="text-text-muted">·</span>
          <span class="flex-1 truncate">{{ node().name }}</span>
          <span class="invisible flex gap-1 group-hover:visible">
            <button
              type="button"
              class="text-text-muted hover:text-text-primary"
              title="Rename"
              (click)="onRename($event)">⌇</button>
            <button
              type="button"
              class="text-text-muted hover:text-danger"
              title="Delete"
              (click)="onDelete($event)">×</button>
          </span>
        </div>
      }
      @if (node().isDirectory && isExpanded()) {
        @for (child of node().children ?? []; track child.path) {
          <app-file-tree-node
            [node]="child"
            [activePath]="activePath()"
            [depth]="depth() + 1"
            (fileSelected)="fileSelected.emit($event)"
            (renameRequested)="renameRequested.emit($event)"
            (deleteRequested)="deleteRequested.emit($event)"
            (createFileRequested)="createFileRequested.emit($event)"
            (createFolderRequested)="createFolderRequested.emit($event)"
            (contextMenuRequested)="contextMenuRequested.emit($event)"
            (moveRequested)="moveRequested.emit($event)" />
        }
      }
    </div>
  `,
})
export class FileTreeNodeComponent {
  readonly node = input.required<FileNode>();
  readonly activePath = input<string | null>(null);
  readonly depth = input<number>(0);

  readonly fileSelected = output<string>();
  readonly renameRequested = output<string>();
  readonly deleteRequested = output<string>();
  readonly createFileRequested = output<string>();
  readonly createFolderRequested = output<string>();
  readonly contextMenuRequested = output<{ node: FileNode; x: number; y: number }>();
  readonly moveRequested = output<{ sourcePath: string; targetDir: string }>();

  private readonly _expanded = signal(true);
  readonly isExpanded = this._expanded.asReadonly();

  private readonly _dragOver = signal(false);
  readonly isDragOver = this._dragOver.asReadonly();

  readonly isActive = computed(() => this.activePath() === this.node().path);
  readonly indent = computed(() => 6 + this.depth() * 12);

  onClick(): void {
    const n = this.node();
    if (n.isDirectory) {
      this._expanded.update((v) => !v);
    } else {
      this.fileSelected.emit(n.path);
    }
  }

  onContextMenu(evt: MouseEvent): void {
    evt.preventDefault();
    evt.stopPropagation();
    this.contextMenuRequested.emit({ node: this.node(), x: evt.clientX, y: evt.clientY });
  }

  onRename(evt: MouseEvent): void {
    evt.stopPropagation();
    this.renameRequested.emit(this.node().path);
  }

  onDelete(evt: MouseEvent): void {
    evt.stopPropagation();
    this.deleteRequested.emit(this.node().path);
  }

  onCreateFileInside(evt: MouseEvent): void {
    evt.stopPropagation();
    this._expanded.set(true);
    this.createFileRequested.emit(this.node().path);
  }

  onCreateFolderInside(evt: MouseEvent): void {
    evt.stopPropagation();
    this._expanded.set(true);
    this.createFolderRequested.emit(this.node().path);
  }

  onDragStart(evt: DragEvent): void {
    evt.dataTransfer?.setData('application/x-specforge-path', this.node().path);
    evt.dataTransfer?.setData('text/plain', this.node().path);
    if (evt.dataTransfer) evt.dataTransfer.effectAllowed = 'move';
  }

  onDragOver(evt: DragEvent): void {
    if (!evt.dataTransfer?.types.includes('application/x-specforge-path')) return;
    evt.preventDefault();
    evt.dataTransfer.dropEffect = 'move';
    this._dragOver.set(true);
  }

  onDragLeave(): void {
    this._dragOver.set(false);
  }

  onDrop(evt: DragEvent): void {
    evt.preventDefault();
    evt.stopPropagation();
    this._dragOver.set(false);
    const src = evt.dataTransfer?.getData('application/x-specforge-path');
    if (src) this.moveRequested.emit({ sourcePath: src, targetDir: this.node().path });
  }
}
