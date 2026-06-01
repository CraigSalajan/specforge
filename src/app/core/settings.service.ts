import { Injectable, computed, effect, inject, signal } from '@angular/core';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEYS,
  type Settings,
  type SettingsKey,
  type Theme,
} from '../shared/types';
import { IpcService } from './ipc.service';

const LEGACY_VAULT_KEY = 'specforge.vaultPath';

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly ipc = inject(IpcService);

  private readonly _settings = signal<Settings>({ ...DEFAULT_SETTINGS });
  private readonly _hydrated = signal(false);
  private readonly _saving = signal(false);

  readonly settings = this._settings.asReadonly();
  readonly hydrated = this._hydrated.asReadonly();
  readonly saving = this._saving.asReadonly();

  readonly theme = computed<Theme>(() => this._settings().theme);
  readonly vaultPath = computed<string | null>(() => this._settings().vaultPath);
  readonly aiBaseUrl = computed(() => this._settings()['ai.baseUrl']);
  readonly aiApiKey = computed(() => this._settings()['ai.apiKey']);
  readonly aiChatModel = computed(() => this._settings()['ai.chatModel']);
  readonly aiEmbeddingModel = computed(() => this._settings()['ai.embeddingModel']);
  readonly aiEmbeddingsEnabled = computed(() => this._settings()['ai.embeddingsEnabled']);
  readonly aiTopK = computed(() => this._settings()['ai.topK']);
  readonly aiMaxContextChars = computed(() => this._settings()['ai.maxContextChars']);
  readonly leftPaneWidth = computed(() => this._settings()['ui.leftPaneWidth']);
  readonly rightPaneWidth = computed(() => this._settings()['ui.rightPaneWidth']);

  constructor() {
    // Reflect theme on <html> for Tailwind variants to pick up.
    effect(() => {
      const theme = this.theme();
      if (typeof document !== 'undefined') {
        const root = document.documentElement;
        root.classList.remove('theme-dark', 'theme-light');
        root.classList.add(theme === 'light' ? 'theme-light' : 'theme-dark');
        root.dataset['theme'] = theme;
      }
    });
  }

  async init(): Promise<void> {
    if (this._hydrated()) return;
    if (!this.ipc.isAvailable) {
      this._hydrated.set(true);
      return;
    }

    try {
      const stored = await this.ipc.settingsGetAll();
      const parsed = this.parseSettings(stored);
      await this.migrateLegacyVaultPath(parsed);
      this._settings.set(parsed);
    } catch (err) {
      console.error('[settings] hydrate failed', err);
    } finally {
      this._hydrated.set(true);
    }
  }

  private async migrateLegacyVaultPath(current: Settings): Promise<void> {
    if (current.vaultPath !== null) return;
    if (typeof localStorage === 'undefined') return;
    const legacy = localStorage.getItem(LEGACY_VAULT_KEY);
    if (!legacy) return;
    try {
      await this.ipc.settingsSet('vaultPath', legacy);
      current.vaultPath = legacy;
      localStorage.removeItem(LEGACY_VAULT_KEY);
    } catch (err) {
      console.warn('[settings] legacy vaultPath migration failed', err);
    }
  }

  async setVaultPath(path: string | null): Promise<void> {
    await this.update({ vaultPath: path });
  }

  async setPaneWidths(left: number, right: number): Promise<void> {
    await this.update({
      'ui.leftPaneWidth': left,
      'ui.rightPaneWidth': right,
    });
  }

  async update(patch: Partial<Settings>): Promise<void> {
    const next: Settings = { ...this._settings(), ...patch };
    this._settings.set(next);
    if (!this.ipc.isAvailable) return;
    this._saving.set(true);
    try {
      await this.ipc.settingsSetMany(this.serializeSettings(next));
    } finally {
      this._saving.set(false);
    }
  }

  private parseSettings(raw: Record<string, string>): Settings {
    const out: Settings = { ...DEFAULT_SETTINGS };
    for (const key of SETTINGS_KEYS) {
      const v = raw[key];
      if (v === undefined) continue;
      this.assign(out, key, v);
    }
    return out;
  }

  private assign(target: Settings, key: SettingsKey, raw: string): void {
    switch (key) {
      case 'vaultPath':
        target.vaultPath = raw.length === 0 ? null : raw;
        return;
      case 'theme':
        target.theme = raw === 'light' ? 'light' : 'dark';
        return;
      case 'ai.embeddingsEnabled':
        target['ai.embeddingsEnabled'] = raw === 'true';
        return;
      case 'ai.topK': {
        const n = Number.parseInt(raw, 10);
        target['ai.topK'] = Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS['ai.topK'];
        return;
      }
      case 'ai.maxContextChars': {
        const n = Number.parseInt(raw, 10);
        target['ai.maxContextChars'] = Number.isFinite(n) && n > 0
          ? n
          : DEFAULT_SETTINGS['ai.maxContextChars'];
        return;
      }
      case 'ui.leftPaneWidth': {
        const n = Number.parseInt(raw, 10);
        target['ui.leftPaneWidth'] = Number.isFinite(n) && n >= 180 && n <= 600
          ? n
          : DEFAULT_SETTINGS['ui.leftPaneWidth'];
        return;
      }
      case 'ui.rightPaneWidth': {
        const n = Number.parseInt(raw, 10);
        target['ui.rightPaneWidth'] = Number.isFinite(n) && n >= 180 && n <= 600
          ? n
          : DEFAULT_SETTINGS['ui.rightPaneWidth'];
        return;
      }
      case 'ai.baseUrl':
      case 'ai.apiKey':
      case 'ai.chatModel':
      case 'ai.embeddingModel':
        target[key] = raw;
        return;
    }
  }

  private serializeSettings(s: Settings): Record<string, string> {
    return {
      vaultPath: s.vaultPath ?? '',
      theme: s.theme,
      'ai.baseUrl': s['ai.baseUrl'],
      'ai.apiKey': s['ai.apiKey'],
      'ai.chatModel': s['ai.chatModel'],
      'ai.embeddingModel': s['ai.embeddingModel'],
      'ai.embeddingsEnabled': s['ai.embeddingsEnabled'] ? 'true' : 'false',
      'ai.topK': String(s['ai.topK']),
      'ai.maxContextChars': String(s['ai.maxContextChars']),
      'ui.leftPaneWidth': String(s['ui.leftPaneWidth']),
      'ui.rightPaneWidth': String(s['ui.rightPaneWidth']),
    };
  }
}
