import { Injectable, inject } from '@angular/core';
import type { IndexSearchHit } from '../../../shared/types';
import { IpcService } from '../../../core/ipc.service';
import { SettingsService } from '../../../core/settings.service';
import { AiProviderService } from './ai-provider.service';

/**
 * Retrieval over the SQLite vault index.
 *
 * Phase 3 strategy:
 *  - Always run the keyword search (`index:search`). It is cheap, deterministic,
 *    and works offline / without an API key.
 *  - When embeddings are enabled AND there is at least one embedding stored for
 *    the configured model, also embed the query and run a cosine-similarity
 *    pass. Results are merged with a simple reciprocal-rank-fusion (RRF) score
 *    so we don't have to normalize raw BM25 and cosine scores against each
 *    other.
 *  - If the embeddings call fails (network, quota, model mismatch) we silently
 *    fall back to keyword-only results so a planning chat never crashes
 *    because retrieval failed.
 */
@Injectable({ providedIn: 'root' })
export class RetrievalService {
  private readonly ipc = inject(IpcService);
  private readonly settings = inject(SettingsService);
  private readonly providers = inject(AiProviderService);

  async retrieve(
    query: string,
    vaultPath: string,
    topK: number,
    filter?: { folders?: string[]; files?: string[] },
  ): Promise<IndexSearchHit[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0 || !vaultPath) return [];

    const k = Math.max(1, Math.min(topK, 50));
    const overFetch = Math.max(k * 2, 12);
    const keywordHits = await this.safeKeywordSearch(vaultPath, trimmed, overFetch, filter);

    const useEmbeddings =
      this.settings.aiEmbeddingsEnabled() && this.providers.isConfigured();
    if (!useEmbeddings) {
      return keywordHits.slice(0, k);
    }

    const vectorHits = await this.safeVectorSearch(vaultPath, trimmed, overFetch, filter);
    if (vectorHits.length === 0) return keywordHits.slice(0, k);

    return rankFuse(keywordHits, vectorHits, k);
  }

  private async safeKeywordSearch(
    vaultPath: string,
    query: string,
    limit: number,
    filter?: { folders?: string[]; files?: string[] },
  ): Promise<IndexSearchHit[]> {
    try {
      return await this.ipc.indexSearch(vaultPath, query, limit, filter);
    } catch (err) {
      console.warn('[retrieval] keyword search failed', err);
      return [];
    }
  }

  private async safeVectorSearch(
    vaultPath: string,
    query: string,
    limit: number,
    filter?: { folders?: string[]; files?: string[] },
  ): Promise<IndexSearchHit[]> {
    try {
      const [vec] = await this.providers.embeddings.embed([query]);
      if (!vec || vec.length === 0) return [];
      return await this.ipc.embeddingsSearch({
        vaultPath,
        vector: vec,
        limit,
        model: this.providers.embeddings.model,
        filter,
      });
    } catch (err) {
      console.warn('[retrieval] vector search failed; falling back to keyword only', err);
      return [];
    }
  }
}

/**
 * Reciprocal rank fusion: score = sum(1 / (k + rank_i)). Avoids needing to
 * normalize raw scores from different search backends.
 */
function rankFuse(
  keyword: IndexSearchHit[],
  vector: IndexSearchHit[],
  topK: number,
): IndexSearchHit[] {
  const K = 60;
  const fused = new Map<string, { hit: IndexSearchHit; score: number }>();

  function key(h: IndexSearchHit): string {
    return `${h.relPath}::${h.headingPath}`;
  }

  function add(list: IndexSearchHit[]): void {
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      const k = key(h);
      const prev = fused.get(k);
      const inc = 1 / (K + i + 1);
      if (prev) {
        prev.score += inc;
      } else {
        fused.set(k, { hit: h, score: inc });
      }
    }
  }

  add(keyword);
  add(vector);

  const ordered = [...fused.values()].sort((a, b) => b.score - a.score);
  return ordered.slice(0, topK).map((entry) => ({
    ...entry.hit,
    score: entry.score,
  }));
}
