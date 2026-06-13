import { Injectable, inject } from '@angular/core';
import { FileChangeService } from '../features/ai/file-change.service';
import { primaryModifierLabel } from '../shared/platform';
import { CommandRegistryService } from './command-registry.service';
import { ConfirmDialogService } from './confirm-dialog.service';
import { EditorBufferService } from './editor-buffer.service';
import { IndexService } from './index.service';
import { IpcService } from './ipc.service';
import { OpenTabsService } from './open-tabs.service';
import { PdfExportService } from './pdf-export.service';
import { UiStateService } from './ui-state.service';
import { VaultFileOpsService } from './vault-file-ops.service';
import { VaultService } from './vault.service';

/**
 * Registers the built-in command set with the CommandRegistryService. Every
 * `run` delegates to the same service entry point its existing UI affordance
 * uses (settings cog, vault-tree buttons, editor header, AI panel undo), so
 * the palette never grows a second implementation of an action.
 *
 * Layout-coupled commands (toggle left/right pane) are registered by
 * AppComponent, which owns the pane state.
 */
@Injectable({ providedIn: 'root' })
export class AppCommandsService {
  private readonly registry = inject(CommandRegistryService);
  private readonly ui = inject(UiStateService);
  private readonly vault = inject(VaultService);
  private readonly openTabs = inject(OpenTabsService);
  private readonly indexer = inject(IndexService);
  private readonly fileOps = inject(VaultFileOpsService);
  private readonly fileChange = inject(FileChangeService);
  private readonly confirmDialog = inject(ConfirmDialogService);
  private readonly pdfExport = inject(PdfExportService);
  private readonly editorBuffer = inject(EditorBufferService);
  private readonly ipc = inject(IpcService);

  private registered = false;

  /** Idempotent; called once from AppComponent at startup. */
  registerDefaults(): void {
    if (this.registered) return;
    this.registered = true;

    const mod = primaryModifierLabel();
    const hasVault = (): boolean => this.vault.hasVault();
    const hasActiveFile = (): boolean => this.vault.activeFilePath() !== null;

    this.registry.register(
      // Each palette mode is discoverable from the other.
      {
        id: 'palette.quickOpen',
        title: 'Quick open file…',
        category: 'Navigate',
        shortcut: `${mod}+P`,
        when: hasVault,
        run: () => this.ui.openPalette('files'),
      },
      {
        id: 'palette.commands',
        title: 'Command palette…',
        category: 'Navigate',
        shortcut: `${mod}+Shift+P`,
        run: () => this.ui.openPalette('commands'),
      },
      {
        id: 'app.openSettings',
        title: 'Open settings',
        category: 'App',
        run: () => this.ui.openSettings(),
      },
      {
        id: 'vault.open',
        title: 'Open vault folder…',
        category: 'Vault',
        run: () => void this.vault.selectVault(),
      },
      {
        id: 'vault.newFile',
        title: 'New file…',
        category: 'Vault',
        when: hasVault,
        run: () => void this.fileOps.createFile(),
      },
      {
        id: 'vault.newFolder',
        title: 'New folder…',
        category: 'Vault',
        when: hasVault,
        run: () => void this.fileOps.createFolder(),
      },
      {
        id: 'index.rebuild',
        title: 'Rebuild search index',
        category: 'Vault',
        when: () => hasVault() && !this.indexer.isIndexing(),
        run: () => void this.indexer.rebuild(this.vault.vaultPath()),
      },
      {
        id: 'file.exportPdf',
        title: 'Export active file to PDF…',
        category: 'File',
        when: hasActiveFile,
        run: () => this.exportActivePdf(),
      },
      {
        id: 'ai.undoLastChange',
        title: 'Undo last AI change',
        category: 'AI',
        when: hasVault,
        run: () => this.undoLastAiChange(),
      },
      {
        id: 'ai.focusComposer',
        title: 'Focus AI composer',
        category: 'AI',
        run: () => this.ui.requestComposerFocus(),
      },
      {
        id: 'editor.focus',
        title: 'Focus editor',
        category: 'Editor',
        when: hasActiveFile,
        run: () => this.ui.requestEditorFocus(),
      },
      // Tab management. Shortcut strings are display-only — the real chords
      // are bound in AppComponent.onGlobalKeydown. Ctrl+Tab cycling uses the
      // Control key on every platform (VS Code convention), hence the
      // hard-coded 'Ctrl' labels.
      {
        id: 'tab.close',
        title: 'Close tab',
        category: 'View',
        shortcut: `${mod}+W`,
        when: hasActiveFile,
        run: () => {
          const active = this.vault.activeFilePath();
          if (active !== null) this.openTabs.closeTab(active);
        },
      },
      {
        id: 'tab.closeOthers',
        title: 'Close other tabs',
        category: 'View',
        when: () => hasActiveFile() && this.openTabs.tabs().length > 1,
        run: () => {
          const active = this.vault.activeFilePath();
          if (active !== null) this.openTabs.closeOthers(active);
        },
      },
      {
        id: 'tab.reopenClosed',
        title: 'Reopen closed tab',
        category: 'View',
        shortcut: `${mod}+Shift+T`,
        when: () => this.openTabs.canReopen(),
        run: () => this.openTabs.reopenClosed(),
      },
      {
        id: 'tab.next',
        title: 'Next tab',
        category: 'View',
        shortcut: 'Ctrl+Tab',
        when: () => this.openTabs.tabs().length > 1,
        run: () => this.openTabs.next(),
      },
      {
        id: 'tab.previous',
        title: 'Previous tab',
        category: 'View',
        shortcut: 'Ctrl+Shift+Tab',
        when: () => this.openTabs.tabs().length > 1,
        run: () => this.openTabs.previous(),
      },
    );
  }

  /**
   * Same pipeline as the editor header / vault-tree context menu: flush the
   * editor buffer so unsaved edits are exported, read disk truth, render.
   */
  private async exportActivePdf(): Promise<void> {
    const absPath = this.vault.activeFilePath();
    if (!absPath) return;
    try {
      await this.editorBuffer.flushIfDirty(absPath);
      const content = await this.ipc.readFile(absPath);
      const result = await this.pdfExport.exportMarkdown(content, absPath);
      if (!result.success && !result.canceled) {
        await this.confirmDialog.notice({
          title: 'PDF export failed',
          message: result.error ?? 'Unknown error',
        });
      }
    } catch (err) {
      await this.confirmDialog.notice({
        title: 'PDF export failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Mirrors the AI panel's undo affordance (confirm-first, guarded,
   * reversible); outcomes surface via the shared notice dialog since the
   * palette has no inline action-message strip.
   */
  private async undoLastAiChange(): Promise<void> {
    const ok = await this.confirmDialog.confirm({
      title: 'Undo last change',
      message: 'Undo the most recent AI change?',
      confirmLabel: 'Undo',
      danger: true,
    });
    if (!ok) return;
    try {
      const reverted = await this.fileChange.undoLastApplied();
      if (!reverted) {
        await this.confirmDialog.notice({
          title: 'Undo last change',
          message: 'No AI change to undo.',
        });
      }
    } catch (err) {
      await this.confirmDialog.notice({
        title: 'Undo failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
