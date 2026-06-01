import { Injectable, computed, inject, signal } from '@angular/core';
import { IpcService } from '../../../core/ipc.service';
import { SettingsService } from '../../../core/settings.service';
import { AiProviderService } from './ai-provider.service';

const BATCH_SIZE = 64;
const MAX_INPUT_CHARS = 6000;

export interface EmbedRebuildProgress {
  processed: number;
  total: number;
  status: 'idle' | 'running' | 'done' | 'error';
  error: string | null;
}

const INITIAL: EmbedRebuildProgress = {
  processed: 0,
  total: 0,
  status: 'idle',
  error: null,
};

/**
 * Embedding indexer.
 *
 * Phase 3 policy: embeddings are only generated on explicit "Rebuild
 * embeddings" action or as a one-shot pass for chunks that have never been
 * embedded for the active model. Per-save auto-embedding is intentionally
 * deferred until Phase 4 so we don't burn quota on every keystroke during
 * the freshly enabled state.
 */
@Injectable({ providedIn: 'root' })
export class EmbeddingIndexerService {
  private readonly ipc = inject(IpcService);
  private readonly settings = inject(SettingsService);
  private readonly providers = inject(AiProviderService);

  private readonly _progress = signal<EmbedRebuildProgress>(INITIAL);
  readonly progress = this._progress.asReadonly();
  readonly isRunning = computed(() => this._progress().status === 'running');

  private abortRequested = false;

  async rebuild(vaultPath: string): Promise<void> {
    if (this.isRunning()) return;
    if (!vaultPath) return;
    if (!this.settings.aiEmbeddingsEnabled()) {
      this._progress.set({ ...INITIAL, status: 'error', error: 'Embeddings are disabled in Settings.' });
      return;
    }
    if (!this.providers.isConfigured()) {
      this._progress.set({ ...INITIAL, status: 'error', error: 'AI provider is not configured.' });
      return;
    }

    this.abortRequested = false;
    this._progress.set({ processed: 0, total: 0, status: 'running', error: null });

    try {
      await this.ipc.embeddingsClear({ vaultPath, model: this.providers.embeddings.model });
      await this.embedPendingChunks(vaultPath);
      this._progress.update((p) => ({ ...p, status: 'done' }));
    } catch (err) {
      this._progress.update((p) => ({
        ...p,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }

  /**
   * Embed any chunks that don't yet have a vector for the active model.
   * Used on first-index of a brand-new file (called from chat or commands)
   * and by the manual rebuild flow.
   */
  async embedPendingChunks(vaultPath: string): Promise<number> {
    let totalProcessed = 0;
    const model = this.providers.embeddings.model;

    while (true) {
      if (this.abortRequested) break;
      const pending = await this.ipc.embeddingsListPendingChunks({
        vaultPath,
        model,
        limit: BATCH_SIZE,
      });
      if (pending.length === 0) break;

      this._progress.update((p) => ({
        ...p,
        total: Math.max(p.total, p.processed + pending.length),
      }));

      const inputs = pending.map((c) => truncate(c.content, MAX_INPUT_CHARS));
      const vectors = await this.providers.embeddings.embed(inputs);
      if (vectors.length !== pending.length) {
        throw new Error(
          `Embedding count mismatch: expected ${pending.length}, got ${vectors.length}`,
        );
      }

      const items = pending.map((chunk, i) => ({
        chunkId: chunk.chunkId,
        model,
        vector: vectors[i],
        dim: vectors[i].length,
      }));
      await this.ipc.embeddingsUpsert(items);

      totalProcessed += pending.length;
      this._progress.update((p) => ({ ...p, processed: p.processed + pending.length }));
    }

    return totalProcessed;
  }

  cancel(): void {
    this.abortRequested = true;
  }

  reset(): void {
    this._progress.set(INITIAL);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max);
}
