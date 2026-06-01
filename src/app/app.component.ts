import { ChangeDetectionStrategy, Component, OnInit, effect, inject, signal } from '@angular/core';
import { VaultService } from './core/vault.service';
import { VaultTreeComponent } from './features/vault/vault-tree.component';
import { EditorComponent } from './features/editor/editor.component';
import { AiPanelComponent } from './features/ai/ai-panel.component';
import { IpcService } from './core/ipc.service';
import { UiStateService } from './core/ui-state.service';
import { SettingsService } from './core/settings.service';
import { SettingsModalComponent } from './features/settings/settings-modal.component';
import { IndexStatusComponent } from './features/indexing/index-status.component';
import { FileChangeProposalComponent } from './features/ai/file-change-proposal.component';
import { InputDialogComponent } from './features/shared/input-dialog.component';
import { ConfirmDialogComponent } from './features/shared/confirm-dialog.component';
import { ContextMenuComponent } from './features/shared/context-menu.component';

type PaneSide = 'left' | 'right';

const PANE_MIN = 180;
const PANE_MAX = 600;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    VaultTreeComponent,
    EditorComponent,
    AiPanelComponent,
    SettingsModalComponent,
    IndexStatusComponent,
    FileChangeProposalComponent,
    InputDialogComponent,
    ConfirmDialogComponent,
    ContextMenuComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex h-screen w-screen flex-col">
      <header class="flex h-9 shrink-0 items-center justify-between border-b border-border-subtle bg-surface-1 px-3">
        <div class="flex items-center gap-2">
          <span class="text-xs font-semibold tracking-wide text-text-primary">SpecForge</span>
        </div>
        <div class="flex items-center gap-3 text-sm text-text-muted">
          <app-index-status />
          @if (!ipcAvailable()) {
            <span class="text-danger">IPC bridge unavailable (open via Electron)</span>
          } @else {
            <span>Local · markdown</span>
          }
          <button
            type="button"
            class="rounded px-1.5 py-0.5 text-text-secondary hover:bg-surface-3 hover:text-text-primary"
            title="Settings"
            (click)="openSettings()">⚙</button>
        </div>
      </header>

      <div class="flex min-h-0 flex-1">
        <aside
          class="shrink-0 border-r border-border-subtle"
          [style.width.px]="leftWidth()">
          <app-vault-tree (fileSelected)="onFileSelected($event)" />
        </aside>

        <div
          class="group relative w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-accent"
          [class.bg-accent]="dragging() === 'left'"
          role="separator"
          aria-orientation="vertical"
          (pointerdown)="onResizeStart($event, 'left')"></div>

        <main class="min-w-0 flex-1">
          <app-editor [filePath]="activeFile()" (saved)="onSaved($event)" />
        </main>

        <div
          class="group relative w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-accent"
          [class.bg-accent]="dragging() === 'right'"
          role="separator"
          aria-orientation="vertical"
          (pointerdown)="onResizeStart($event, 'right')"></div>

        <aside
          class="shrink-0 border-l border-border-subtle"
          [style.width.px]="rightWidth()">
          <app-ai-panel />
        </aside>
      </div>
    </div>

    <app-settings-modal />
    <app-file-change-proposal />
    <app-input-dialog />
    <app-confirm-dialog />
    <app-context-menu />
  `,
})
export class AppComponent implements OnInit {
  private readonly vault = inject(VaultService);
  private readonly ipc = inject(IpcService);
  private readonly ui = inject(UiStateService);
  private readonly settings = inject(SettingsService);

  readonly activeFile = this.vault.activeFilePath;
  readonly ipcAvailable = signal(this.ipc.isAvailable);

  readonly leftWidth = signal(this.settings.leftPaneWidth());
  readonly rightWidth = signal(this.settings.rightPaneWidth());
  readonly dragging = signal<PaneSide | null>(null);

  private hydratedOnce = false;
  private dragPointerId: number | null = null;
  private dragHandle: HTMLElement | null = null;
  private prevBodyCursor = '';
  private prevBodyUserSelect = '';

  constructor() {
    effect(() => {
      if (!this.settings.hydrated()) return;
      if (this.hydratedOnce) return;
      this.hydratedOnce = true;
      this.leftWidth.set(this.clamp(this.settings.leftPaneWidth()));
      this.rightWidth.set(this.clamp(this.settings.rightPaneWidth()));
    });
  }

  ngOnInit(): void {
    void this.vault.init();
  }

  openSettings(): void {
    this.ui.openSettings();
  }

  onFileSelected(path: string): void {
    this.vault.setActiveFile(path);
  }

  onSaved(_evt: { path: string }): void {
    // no-op for now; vault refresh happens via file watcher
  }

  onResizeStart(event: PointerEvent, side: PaneSide): void {
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    this.dragPointerId = event.pointerId;
    this.dragHandle = handle;
    this.dragging.set(side);

    this.prevBodyCursor = document.body.style.cursor;
    this.prevBodyUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    handle.addEventListener('pointermove', this.onResizeMove);
    handle.addEventListener('pointerup', this.onResizeEnd);
    handle.addEventListener('pointercancel', this.onResizeEnd);
  }

  private readonly onResizeMove = (event: PointerEvent): void => {
    const side = this.dragging();
    if (!side) return;

    if (side === 'left') {
      this.leftWidth.set(this.clamp(event.clientX));
    } else {
      const width = window.innerWidth - event.clientX;
      this.rightWidth.set(this.clamp(width));
    }
  };

  private readonly onResizeEnd = (event: PointerEvent): void => {
    const handle = this.dragHandle;
    if (handle && this.dragPointerId !== null) {
      try {
        handle.releasePointerCapture(this.dragPointerId);
      } catch {
        // pointer may already be released
      }
      handle.removeEventListener('pointermove', this.onResizeMove);
      handle.removeEventListener('pointerup', this.onResizeEnd);
      handle.removeEventListener('pointercancel', this.onResizeEnd);
    }

    this.dragHandle = null;
    this.dragPointerId = null;
    this.dragging.set(null);

    document.body.style.cursor = this.prevBodyCursor;
    document.body.style.userSelect = this.prevBodyUserSelect;

    if (event.type !== 'pointercancel') {
      void this.settings.setPaneWidths(this.leftWidth(), this.rightWidth());
    }
  };

  private clamp(value: number): number {
    if (!Number.isFinite(value)) return PANE_MIN;
    return Math.min(PANE_MAX, Math.max(PANE_MIN, Math.round(value)));
  }
}
