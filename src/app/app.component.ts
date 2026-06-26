import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { VaultService } from './core/vault.service';
import { OpenTabsService } from './core/open-tabs.service';
import { VaultTreeComponent } from './features/vault/vault-tree.component';
import { EditorComponent } from './features/editor/editor.component';
import { EditorTabsComponent } from './features/editor/editor-tabs.component';
import { AiPanelComponent } from './features/ai/ai-panel.component';
import { IpcService } from './core/ipc.service';
import { UiStateService, type SidebarView } from './core/ui-state.service';
import { SettingsService } from './core/settings.service';
import { AppCommandsService } from './core/app-commands.service';
import { CommandRegistryService } from './core/command-registry.service';
import { ConfirmDialogService } from './core/confirm-dialog.service';
import { ContextMenuService } from './core/context-menu.service';
import { InputDialogService } from './core/input-dialog.service';
import { AiOrchestratorService } from './features/ai/ai-orchestrator.service';
import { isMacPlatform, primaryModifierLabel } from './shared/platform';
import { SettingsModalComponent } from './features/settings/settings-modal.component';
import { PushPreviewComponent } from './features/sync/push-preview.component';
import { IndexStatusComponent } from './features/indexing/index-status.component';
import { FileChangeProposalComponent } from './features/ai/file-change-proposal.component';
import { InputDialogComponent } from './features/shared/input-dialog.component';
import { ConfirmDialogComponent } from './features/shared/confirm-dialog.component';
import { ContextMenuComponent } from './features/shared/context-menu.component';
import { PaletteComponent } from './features/palette/palette.component';
import { SearchPanelComponent } from './features/search/search-panel.component';
import { OutlinePanelComponent } from './features/outline/outline-panel.component';
import { LinksPanelComponent } from './features/links/links-panel.component';
import { DocsPanelComponent } from './features/docs/docs-panel.component';

type PaneSide = 'left' | 'right';

const PANE_MIN = 180;
const PANE_MAX = 600;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [
    VaultTreeComponent,
    EditorComponent,
    EditorTabsComponent,
    AiPanelComponent,
    SettingsModalComponent,
    PushPreviewComponent,
    IndexStatusComponent,
    FileChangeProposalComponent,
    InputDialogComponent,
    ConfirmDialogComponent,
    ContextMenuComponent,
    PaletteComponent,
    SearchPanelComponent,
    OutlinePanelComponent,
    LinksPanelComponent,
    DocsPanelComponent,
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
          @if (hasEnabledLinearConnection()) {
            <button
              type="button"
              class="rounded px-1.5 py-0.5 text-text-secondary hover:bg-surface-3 hover:text-text-primary focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent motion-reduce:transition-none"
              title="Push to Linear…"
              (click)="openPushPreview()">Push</button>
          }
          <button
            type="button"
            class="rounded px-1.5 py-0.5 text-text-secondary hover:bg-surface-3 hover:text-text-primary"
            title="Settings"
            (click)="openSettings()">⚙</button>
        </div>
      </header>

      <div class="flex min-h-0 flex-1">
        <!-- Collapsed panes stay mounted (display:none) so tree expansion and
             AI panel state survive a toggle from the command palette. The
             same applies to the sidebar views below: all three stay mounted
             so tree expansion and search results survive view switches. -->
        <aside
          class="flex shrink-0 flex-col border-r border-border-subtle"
          [class.hidden]="leftCollapsed()"
          [style.width.px]="leftWidth()">
          <nav
            class="flex shrink-0 items-center gap-1 border-b border-border-subtle bg-surface-1 px-2 py-1"
            aria-label="Sidebar views">
            <button
              type="button"
              class="rounded p-1.5 transition-colors"
              [class]="sidebarTabClass('files')"
              title="Files"
              aria-label="Files"
              [attr.aria-pressed]="sidebarView() === 'files'"
              (click)="showSidebarView('files')">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>
            </button>
            <button
              type="button"
              class="rounded p-1.5 transition-colors"
              [class]="sidebarTabClass('search')"
              [title]="'Search (' + modKey + '+Shift+F)'"
              aria-label="Search"
              [attr.aria-pressed]="sidebarView() === 'search'"
              (click)="showSidebarView('search')">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
            </button>
            <button
              type="button"
              class="rounded p-1.5 transition-colors"
              [class]="sidebarTabClass('outline')"
              title="Outline"
              aria-label="Outline"
              [attr.aria-pressed]="sidebarView() === 'outline'"
              (click)="showSidebarView('outline')">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h.01" /><path d="M3 18h.01" /><path d="M3 6h.01" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M8 6h13" /></svg>
            </button>
            <button
              type="button"
              class="rounded p-1.5 transition-colors"
              [class]="sidebarTabClass('links')"
              title="Links"
              aria-label="Links"
              [attr.aria-pressed]="sidebarView() === 'links'"
              (click)="showSidebarView('links')">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></svg>
            </button>
            <button
              type="button"
              class="rounded p-1.5 transition-colors"
              [class]="sidebarTabClass('docs')"
              title="Docs"
              aria-label="Docs"
              [attr.aria-pressed]="sidebarView() === 'docs'"
              (click)="showSidebarView('docs')">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8 8a2 2 0 0 0 2.828 0l7.172-7.172a2 2 0 0 0 0-2.828Z" /><circle cx="7.5" cy="7.5" r=".5" fill="currentColor" /></svg>
            </button>
          </nav>
          <div class="min-h-0 flex-1">
            <div class="h-full" [class.hidden]="sidebarView() !== 'files'">
              <app-vault-tree (fileSelected)="onFileSelected($event)" />
            </div>
            <div class="h-full" [class.hidden]="sidebarView() !== 'search'">
              <app-search-panel />
            </div>
            <div class="h-full" [class.hidden]="sidebarView() !== 'outline'">
              <app-outline-panel />
            </div>
            <div class="h-full" [class.hidden]="sidebarView() !== 'links'">
              <app-links-panel />
            </div>
            <div class="h-full" [class.hidden]="sidebarView() !== 'docs'">
              <app-docs-panel />
            </div>
          </div>
        </aside>

        <div
          class="group relative w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-accent"
          [class.hidden]="leftCollapsed()"
          [class.bg-accent]="dragging() === 'left'"
          role="separator"
          aria-orientation="vertical"
          (pointerdown)="onResizeStart($event, 'left')"></div>

        <main class="flex min-w-0 flex-1 flex-col">
          <app-editor-tabs class="shrink-0" />
          <app-editor
            class="block min-h-0 flex-1"
            [filePath]="activeFile()"
            (saved)="onSaved($event)" />
        </main>

        <div
          class="group relative w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-accent"
          [class.hidden]="rightCollapsed()"
          [class.bg-accent]="dragging() === 'right'"
          role="separator"
          aria-orientation="vertical"
          (pointerdown)="onResizeStart($event, 'right')"></div>

        <aside
          class="shrink-0 border-l border-border-subtle"
          [class.hidden]="rightCollapsed()"
          [style.width.px]="rightWidth()">
          <app-ai-panel />
        </aside>
      </div>
    </div>

    <app-settings-modal />
    <app-push-preview />
    <app-file-change-proposal />
    <app-input-dialog />
    <app-confirm-dialog />
    <app-context-menu />
    <app-palette />
  `,
})
export class AppComponent implements OnInit {
  private readonly vault = inject(VaultService);
  private readonly openTabs = inject(OpenTabsService);
  private readonly ipc = inject(IpcService);
  private readonly ui = inject(UiStateService);
  private readonly settings = inject(SettingsService);
  private readonly registry = inject(CommandRegistryService);
  private readonly appCommands = inject(AppCommandsService);
  private readonly contextMenu = inject(ContextMenuService);
  private readonly inputDialog = inject(InputDialogService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly orchestrator = inject(AiOrchestratorService);

  private readonly isMac = isMacPlatform();
  protected readonly modKey = primaryModifierLabel();

  readonly activeFile = this.vault.activeFilePath;
  readonly ipcAvailable = signal(this.ipc.isAvailable);
  readonly sidebarView = this.ui.sidebarView;

  /**
   * Whether the active vault has an enabled Linear connection — the gate for the
   * header Push affordance and the `sync.push` command. Stays quiet (false) when
   * nothing is configured so the tool surfaces the action only when it applies.
   */
  readonly hasEnabledLinearConnection = computed(() => {
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) return false;
    return this.settings
      .connectionsForVault(vaultPath)
      .some((c) => c.provider === 'linear' && c.enabled);
  });

  readonly leftWidth = signal(this.settings.leftPaneWidth());
  readonly rightWidth = signal(this.settings.rightPaneWidth());
  readonly dragging = signal<PaneSide | null>(null);

  // Session-only pane visibility (not persisted; widths are). Toggled via the
  // command palette.
  readonly leftCollapsed = signal(false);
  readonly rightCollapsed = signal(false);

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

    // Built-in commands. Pane toggles and sidebar-view commands are
    // registered here because this component owns the pane state (showing a
    // sidebar view must also un-collapse the left pane); everything else
    // lives in AppCommandsService.
    this.appCommands.registerDefaults();
    this.registry.register(
      {
        id: 'view.toggleLeftPane',
        title: 'Toggle left pane',
        category: 'View',
        run: () => this.leftCollapsed.update((v) => !v),
      },
      {
        id: 'view.toggleRightPane',
        title: 'Toggle right pane',
        category: 'View',
        run: () => this.rightCollapsed.update((v) => !v),
      },
      {
        id: 'view.showFiles',
        title: 'Show files',
        category: 'View',
        run: () => this.revealSidebarView('files'),
      },
      {
        id: 'view.showOutline',
        title: 'Show outline',
        category: 'View',
        run: () => this.revealSidebarView('outline'),
      },
      {
        id: 'view.showBacklinks',
        title: 'Show backlinks',
        category: 'View',
        run: () => this.revealSidebarView('links'),
      },
      {
        id: 'view.showDocs',
        title: 'Show document properties',
        category: 'View',
        run: () => this.revealSidebarView('docs'),
      },
      {
        id: 'search.inVault',
        title: 'Search in vault…',
        category: 'Navigate',
        shortcut: `${this.modKey}+Shift+F`,
        run: () => this.revealSidebarView('search'),
      },
      {
        id: 'sync.push',
        title: 'Push to Linear…',
        category: 'Sync',
        // Gated on a vault AND an enabled Linear connection — the push surface
        // is meaningless without somewhere to push to.
        when: () => this.vault.hasVault() && this.hasEnabledLinearConnection(),
        run: () => this.openPushPreview(),
      },
    );
  }

  ngOnInit(): void {
    void this.vault.init();
  }

  /**
   * Global Ctrl+P / Ctrl+Shift+P (quick switcher / command palette),
   * Ctrl+Shift+F (search in vault), Ctrl+W (close tab) and Ctrl+Shift+T
   * (reopen closed tab) — Cmd on macOS. Window-level (bubble phase) like the
   * editor's Ctrl+S: CodeMirror binds none of these chords on the primary
   * modifier, so the events always reach us. Each chord is always claimed
   * (preventDefault) so Chromium can never run its own binding (print
   * dialog), even while a modal is up.
   *
   * Tab cycling (Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+PgDn / Ctrl+PgUp) uses the
   * Control key on EVERY platform — macOS included, matching VS Code — so it
   * is handled before the primary-modifier gate. Cycling deliberately allows
   * key repeat (hold to keep stepping); close/reopen do not.
   */
  @HostListener('window:keydown', ['$event'])
  onGlobalKeydown(evt: KeyboardEvent): void {
    if (evt.ctrlKey && !evt.metaKey && !evt.altKey) {
      if (evt.key === 'Tab') {
        evt.preventDefault();
        if (this.blockingOverlayOpen()) return;
        if (evt.shiftKey) this.openTabs.previous();
        else this.openTabs.next();
        return;
      }
      if (!evt.shiftKey && (evt.key === 'PageDown' || evt.key === 'PageUp')) {
        evt.preventDefault();
        if (this.blockingOverlayOpen()) return;
        if (evt.key === 'PageDown') this.openTabs.next();
        else this.openTabs.previous();
        return;
      }
    }

    const primary = this.isMac ? evt.metaKey : evt.ctrlKey;
    const wrongModifier = (this.isMac ? evt.ctrlKey : evt.metaKey) || evt.altKey;
    if (!primary || wrongModifier) return;
    const key = evt.key.toLowerCase();

    if (key === 'p') {
      evt.preventDefault();
      if (evt.repeat) return;
      // A blocking overlay owns the keyboard; re-invoking while the palette
      // itself is open just re-arms it in the requested mode.
      if (this.blockingOverlayOpen()) return;
      this.contextMenu.close();
      this.ui.openPalette(evt.shiftKey ? 'commands' : 'files');
      return;
    }

    if (key === 'f' && evt.shiftKey) {
      evt.preventDefault();
      if (evt.repeat) return;
      if (this.blockingOverlayOpen()) return;
      this.contextMenu.close();
      this.revealSidebarView('search');
      return;
    }

    // Claimed even with no active tab: the chord must never fall through to
    // anything else (the Electron menu deliberately drops its Close Window
    // accelerator so this handler sees Ctrl+W at all).
    if (key === 'w' && !evt.shiftKey) {
      evt.preventDefault();
      if (evt.repeat) return;
      if (this.blockingOverlayOpen()) return;
      const active = this.vault.activeFilePath();
      if (active !== null) this.openTabs.closeTab(active);
      return;
    }

    if (key === 't' && evt.shiftKey) {
      evt.preventDefault();
      if (evt.repeat) return;
      if (this.blockingOverlayOpen()) return;
      this.openTabs.reopenClosed();
    }
  }

  /** Sidebar switcher tabs: plain view switch (the pane is already visible). */
  showSidebarView(view: SidebarView): void {
    this.ui.setSidebarView(view);
  }

  /**
   * Command/shortcut entry point: switching views must also un-collapse the
   * left pane, or the command would appear to do nothing. Activating the
   * search view focuses its input (see UiStateService.setSidebarView).
   */
  private revealSidebarView(view: SidebarView): void {
    this.leftCollapsed.set(false);
    this.ui.setSidebarView(view);
  }

  /** Selected tab reads like a selected list row: surface-3 + primary ink. */
  protected sidebarTabClass(view: SidebarView): string {
    return this.sidebarView() === view
      ? 'bg-surface-3 text-text-primary'
      : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary';
  }

  openSettings(): void {
    this.ui.openSettings();
  }

  openPushPreview(): void {
    this.ui.openPushPreview();
  }

  private blockingOverlayOpen(): boolean {
    return (
      this.ui.settingsOpen() ||
      this.ui.pushPreviewOpen() ||
      this.inputDialog.request() !== null ||
      this.confirmDialog.request() !== null ||
      this.orchestrator.pendingProposal() !== null
    );
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
