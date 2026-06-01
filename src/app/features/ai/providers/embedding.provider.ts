/**
 * Provider-agnostic embedding surface used by the indexing service.
 */

export interface EmbeddingProvider {
  /** Compute embedding vectors for a batch of input strings. */
  embed(texts: string[]): Promise<number[][]>;
  /** Resolved embedding model identifier (e.g. text-embedding-3-small). */
  readonly model: string;
  /** Optional reported vector dimensionality. Filled after first call. */
  readonly dim?: number;
}
