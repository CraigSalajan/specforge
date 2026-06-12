import { Injectable, computed, inject } from '@angular/core';
import { IpcService } from '../../../core/ipc.service';
import { SettingsService } from '../../../core/settings.service';
import type { ChatProvider } from './chat.provider';
import type { EmbeddingProvider } from './embedding.provider';
import {
  OpenAiCompatibleChatProvider,
  OpenAiCompatibleEmbeddingProvider,
  type OpenAiCompatibleConfig,
} from './openai-compatible.provider';

/**
 * Centralized factory that builds chat / embedding providers from live
 * settings signals. Provider methods read the current config on every call,
 * so toggling base URL or model in Settings takes effect immediately without
 * tearing down provider instances.
 */
@Injectable({ providedIn: 'root' })
export class AiProviderService {
  private readonly settings = inject(SettingsService);
  private readonly ipc = inject(IpcService);

  private readonly getConfig = (): OpenAiCompatibleConfig => {
    const s = this.settings.settings();
    return {
      baseUrl: s['ai.baseUrl'] || 'https://api.openai.com/v1',
      apiKey: s['ai.apiKey'] ?? '',
      chatModel: s['ai.chatModel'] || 'gpt-4o-mini',
      embeddingModel: s['ai.embeddingModel'] || 'text-embedding-3-small',
      timeoutMs: (s['ai.timeoutSeconds'] ?? 30) * 1000,
    };
  };

  readonly isConfigured = computed(() => (this.settings.settings()['ai.apiKey'] ?? '').length > 0);

  readonly chat: ChatProvider = new OpenAiCompatibleChatProvider(this.getConfig, this.ipc);
  readonly embeddings: EmbeddingProvider = new OpenAiCompatibleEmbeddingProvider(
    this.getConfig,
    this.ipc,
  );
}
