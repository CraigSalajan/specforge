import { Injectable, computed, inject, signal } from '@angular/core';
import type { FileNode } from '../shared/types';
import { samePath } from '../shared/path-utils';
import { fromVaultRel, toVaultRel, treeContainsFile } from '../shared/vault-paths';
import { IpcService } from './ipc.service';
import { SettingsService } from './settings.service';
import { IndexService } from './index.service';

/** Cap on the recently-opened list consumed by the quick switcher. */
const MAX_RECENT_FILES = 30;

@Injectable({ providedIn: 'root' })
export class VaultService {
  private readonly ipc = inject(IpcService);
  private readonly settings = inject(SettingsService);
  private readonly indexer = inject(IndexService);

  private readonly _vaultPath = signal<string | null>(null);
  private readonly _tree = signal<FileNode[]>([]);
  private readonly _activeFilePath = signal<string | null>(null);
  private readonly _recentFiles = signal<string[]>([]);
  private readonly _isLoading = signal(false);
  private readonly _error = signal<string | null>(null);

  readonly vaultPath = this._vaultPath.asReadonly();
  readonly tree = this._tree.asReadonly();
  readonly activeFilePath = this._activeFilePath.asReadonly();
  /** Absolute paths of recently-opened files, most recent first. */
  readonly recentFiles = this._recentFiles.asReadonly();
  readonly isLoading = this._isLoading.asReadonly();
  readonly error = this._error.asReadonly();

  readonly hasVault = computed(() => this._vaultPath() !== null);

  private unsubscribeWatcher: (() => void) | null = null;
  private refreshDebounce: ReturnType<typeof setTimeout> | null = null;
  private statusDebounce: ReturnType<typeof setTimeout> | null = null;

  async init(): Promise<void> {
    await this.settings.init();
    const stored = this.settings.vaultPath();
    this._vaultPath.set(stored);
    if (stored && this.ipc.isAvailable) {
      await this.loadVault(stored);
      this.restoreLastOpenFile();
    }
  }

  async selectVault(): Promise<void> {
    this._error.set(null);
    try {
      const chosen = await this.ipc.selectVault();
      if (chosen) {
        await this.loadVault(chosen);
      }
    } catch (err) {
      this._error.set(this.toMessage(err));
    }
  }

  async loadVault(path: string): Promise<void> {
    this._isLoading.set(true);
    this._error.set(null);
    try {
      const previous = this._vaultPath();
      if (previous !== null && !samePath(previous, path)) {
        this._recentFiles.set([]);
        // The active file belongs to the previous vault; closing it here
        // keeps the editor (and the open-tabs strip) coherent with the new
        // vault. The editor's switch-away flush still saves unsaved edits.
        this._activeFilePath.set(null);
        // Per-vault UI state must never leak into another vault. Cleared
        // before the new vault path lands (the settings signal updates
        // synchronously), so effects keyed off the vault path hydrate clean.
        await this.settings.update({
          'ui.lastOpenFile': null,
          'ui.collapsedFolders': [],
          'ui.openTabs': [],
        });
      }
      this._vaultPath.set(path);
      await this.settings.setVaultPath(path);
      await this.refreshTree();
      await this.startWatching(path);
      await this.indexer.refreshStatus(path);
    } catch (err) {
      this._error.set(this.toMessage(err));
      this._vaultPath.set(null);
      await this.settings.setVaultPath(null);
      this.indexer.reset();
    } finally {
      this._isLoading.set(false);
    }
  }

  async refreshTree(): Promise<void> {
    const path = this._vaultPath();
    if (!path) return;
    try {
      const nodes = await this.ipc.listFiles(path);
      this._tree.set(nodes);
    } catch (err) {
      this._error.set(this.toMessage(err));
    }
  }

  setActiveFile(path: string | null): void {
    this._activeFilePath.set(path);
    if (path !== null) this.trackRecentFile(path);
    this.persistLastOpenFile(path);
  }

  async closeVault(): Promise<void> {
    await this.stopWatching();
    this._vaultPath.set(null);
    this._tree.set([]);
    this._activeFilePath.set(null);
    this._recentFiles.set([]);
    await this.settings.update({
      vaultPath: null,
      'ui.lastOpenFile': null,
      'ui.collapsedFolders': [],
      'ui.openTabs': [],
    });
    this.indexer.reset();
  }

  /**
   * Persists the active file as a vault-relative path so the restored value
   * can only ever name a file of the current vault — paths outside the vault
   * root (e.g. a file still open from a previous vault) store as null.
   */
  private persistLastOpenFile(path: string | null): void {
    const vaultPath = this._vaultPath();
    if (vaultPath === null) return;
    const rel = path !== null ? toVaultRel(vaultPath, path) : null;
    if (rel === this.settings.lastOpenFile()) return;
    void this.settings.update({ 'ui.lastOpenFile': rel });
  }

  /**
   * Boot-only: re-opens the file that was active when the app last closed
   * (plain open, no scroll). Runs after the vault tree restore; the stored
   * path is vault-relative and cleared on vault switch/close, so it can only
   * match a file in the restored vault. Stale entries (file deleted while
   * the app was closed) are pruned instead of opened.
   */
  private restoreLastOpenFile(): void {
    const vaultPath = this._vaultPath();
    if (vaultPath === null) return;
    const rel = this.settings.lastOpenFile();
    if (rel === null || rel.length === 0) return;
    const abs = fromVaultRel(vaultPath, rel);
    if (treeContainsFile(this._tree(), abs)) {
      this.setActiveFile(abs);
    } else {
      void this.settings.update({ 'ui.lastOpenFile': null });
    }
  }

  private async startWatching(path: string): Promise<void> {
    await this.stopWatching();
    await this.ipc.watchVault(path);
    this.unsubscribeWatcher = this.ipc.onFileChange(() => {
      this.scheduleRefresh();
      this.scheduleIndexStatusRefresh();
    });
  }

  private async stopWatching(): Promise<void> {
    if (this.unsubscribeWatcher) {
      this.unsubscribeWatcher();
      this.unsubscribeWatcher = null;
    }
    if (this.ipc.isAvailable) {
      try {
        await this.ipc.unwatchVault();
      } catch {
        // ignore
      }
    }
  }

  /** MRU bookkeeping for the quick switcher: dedupe, prepend, cap. */
  private trackRecentFile(path: string): void {
    this._recentFiles.update((list) =>
      [path, ...list.filter((p) => !samePath(p, path))].slice(0, MAX_RECENT_FILES),
    );
  }

  private scheduleRefresh(): void {
    if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
    this.refreshDebounce = setTimeout(() => {
      void this.refreshTree();
    }, 120);
  }

  private scheduleIndexStatusRefresh(): void {
    if (this.statusDebounce) clearTimeout(this.statusDebounce);
    this.statusDebounce = setTimeout(() => {
      void this.indexer.refreshStatus(this._vaultPath());
    }, 800);
  }

  private toMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }
}
