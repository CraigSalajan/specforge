import { Injectable, computed, inject, signal } from '@angular/core';
import type { IndexSearchHit, IndexStatus } from '../shared/types';
import { IpcService } from './ipc.service';

const EMPTY_STATUS: IndexStatus = {
  totalFiles: 0,
  indexedFiles: 0,
  totalChunks: 0,
  lastIndexedAt: null,
};

@Injectable({ providedIn: 'root' })
export class IndexService {
  private readonly ipc = inject(IpcService);

  private readonly _status = signal<IndexStatus>(EMPTY_STATUS);
  private readonly _isIndexing = signal(false);
  private readonly _error = signal<string | null>(null);

  readonly status = this._status.asReadonly();
  readonly isIndexing = this._isIndexing.asReadonly();
  readonly error = this._error.asReadonly();

  readonly hasIndex = computed(() => this._status().indexedFiles > 0);

  async refreshStatus(vaultPath: string | null): Promise<void> {
    if (!vaultPath || !this.ipc.isAvailable) {
      this._status.set(EMPTY_STATUS);
      return;
    }
    try {
      const status = await this.ipc.indexStatus(vaultPath);
      this._status.set(status);
    } catch (err) {
      this._error.set(this.toMessage(err));
    }
  }

  async rebuild(vaultPath: string | null): Promise<void> {
    if (!vaultPath || !this.ipc.isAvailable) return;
    this._error.set(null);
    this._isIndexing.set(true);
    try {
      const status = await this.ipc.indexRebuild(vaultPath);
      this._status.set(status);
    } catch (err) {
      this._error.set(this.toMessage(err));
    } finally {
      this._isIndexing.set(false);
    }
  }

  async search(vaultPath: string, query: string, limit = 20): Promise<IndexSearchHit[]> {
    if (!this.ipc.isAvailable) return [];
    try {
      return await this.ipc.indexSearch(vaultPath, query, limit);
    } catch (err) {
      this._error.set(this.toMessage(err));
      return [];
    }
  }

  reset(): void {
    this._status.set(EMPTY_STATUS);
    this._error.set(null);
    this._isIndexing.set(false);
  }

  private toMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
