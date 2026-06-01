import { Injectable, computed, inject, signal } from '@angular/core';
import type { FileNode } from '../shared/types';
import { IpcService } from './ipc.service';
import { SettingsService } from './settings.service';
import { IndexService } from './index.service';

@Injectable({ providedIn: 'root' })
export class VaultService {
  private readonly ipc = inject(IpcService);
  private readonly settings = inject(SettingsService);
  private readonly indexer = inject(IndexService);

  private readonly _vaultPath = signal<string | null>(null);
  private readonly _tree = signal<FileNode[]>([]);
  private readonly _activeFilePath = signal<string | null>(null);
  private readonly _isLoading = signal(false);
  private readonly _error = signal<string | null>(null);

  readonly vaultPath = this._vaultPath.asReadonly();
  readonly tree = this._tree.asReadonly();
  readonly activeFilePath = this._activeFilePath.asReadonly();
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
  }

  async closeVault(): Promise<void> {
    await this.stopWatching();
    this._vaultPath.set(null);
    this._tree.set([]);
    this._activeFilePath.set(null);
    await this.settings.setVaultPath(null);
    this.indexer.reset();
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
