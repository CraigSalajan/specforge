import { Injectable, computed, inject, signal } from '@angular/core';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEYS,
  type Settings,
  type SettingsKey,
} from '../shared/types';
import { IpcService } from './ipc.service';
import { parseConnectionsMap, type Connection } from '../../../electron/sync/connection';

const LEGACY_VAULT_KEY = 'specforge.vaultPath';

/**
 * Validates a parsed `skills.disabledLocal` value: a record mapping vault path
 * strings to arrays of disabled skill names. Used to reject malformed stored
 * JSON before it reaches the typed settings model.
 */
function isDisabledLocalMap(value: unknown): value is Record<string, string[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every(
    (v) => Array.isArray(v) && v.every((entry) => typeof entry === 'string'),
  );
}

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly ipc = inject(IpcService);

  private readonly _settings = signal<Settings>({ ...DEFAULT_SETTINGS });
  private readonly _hydrated = signal(false);
  private readonly _saving = signal(false);

  readonly settings = this._settings.asReadonly();
  readonly hydrated = this._hydrated.asReadonly();
  readonly saving = this._saving.asReadonly();

  readonly vaultPath = computed<string | null>(() => this._settings().vaultPath);
  readonly editorAutoSave = computed(() => this._settings()['editor.autoSave']);
  readonly aiBaseUrl = computed(() => this._settings()['ai.baseUrl']);
  readonly aiApiKey = computed(() => this._settings()['ai.apiKey']);
  readonly aiChatModel = computed(() => this._settings()['ai.chatModel']);
  readonly aiEmbeddingModel = computed(() => this._settings()['ai.embeddingModel']);
  readonly aiEmbeddingsEnabled = computed(() => this._settings()['ai.embeddingsEnabled']);
  readonly aiToolsEnabled = computed(() => this._settings()['ai.toolsEnabled']);
  readonly disabledTools = computed(() => this._settings()['ai.disabledTools']);
  readonly aiTopK = computed(() => this._settings()['ai.topK']);
  readonly aiMaxContextChars = computed(() => this._settings()['ai.maxContextChars']);
  readonly aiTimeoutSeconds = computed(() => this._settings()['ai.timeoutSeconds']);
  readonly skillsEnabled = computed(() => this._settings()['skills.enabled']);
  readonly skillDirectories = computed(() => this._settings()['skills.directories']);
  readonly disabledGlobalSkills = computed(() => this._settings()['skills.disabledGlobal']);
  readonly disabledLocalSkills = computed(() => this._settings()['skills.disabledLocal']);
  readonly disabledUserSkills = computed(() => this._settings()['skills.disabledUser']);
  readonly leftPaneWidth = computed(() => this._settings()['ui.leftPaneWidth']);
  readonly rightPaneWidth = computed(() => this._settings()['ui.rightPaneWidth']);
  readonly lastOpenFile = computed(() => this._settings()['ui.lastOpenFile']);
  readonly collapsedFolders = computed(() => this._settings()['ui.collapsedFolders']);
  readonly openTabs = computed(() => this._settings()['ui.openTabs']);
  readonly pmConnections = computed(() => this._settings()['pm.connections']);

  constructor() {
    // SpecForge is dark-only (see DESIGN.md). The Tailwind `dark` variant in
    // styles.css keys off the `.dark` class that index.html declares
    // statically; assert it here too (plus `theme-dark` / data-theme for
    // anything keying off those) so the theme can never drift, regardless of
    // any legacy 'light' value still persisted under the `theme` setting key.
    if (typeof document !== 'undefined') {
      const root = document.documentElement;
      root.classList.remove('theme-light');
      root.classList.add('dark', 'theme-dark');
      root.dataset['theme'] = 'dark';
    }
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
      case 'editor.autoSave':
        // Default-on: only an explicit 'false' disables auto-save.
        target['editor.autoSave'] = raw !== 'false';
        return;
      case 'ai.embeddingsEnabled':
        target['ai.embeddingsEnabled'] = raw === 'true';
        return;
      case 'ai.toolsEnabled':
        // Default-on: only an explicit 'false' disables tools.
        target['ai.toolsEnabled'] = raw !== 'false';
        return;
      case 'ai.disabledTools': {
        // Stored as a JSON array of tool names. Parse defensively: any
        // malformed value falls back to "no tools disabled" (all enabled).
        try {
          const parsed: unknown = JSON.parse(raw);
          target['ai.disabledTools'] =
            Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')
              ? (parsed as string[])
              : [];
        } catch {
          target['ai.disabledTools'] = [];
        }
        return;
      }
      case 'skills.enabled':
        // Default-on: only an explicit 'false' disables skills.
        target['skills.enabled'] = raw !== 'false';
        return;
      case 'skills.directories': {
        // Stored as a JSON array of absolute directory paths. Parse
        // defensively: any malformed value falls back to "no extra
        // directories".
        try {
          const parsed: unknown = JSON.parse(raw);
          target['skills.directories'] =
            Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')
              ? (parsed as string[])
              : [];
        } catch {
          target['skills.directories'] = [];
        }
        return;
      }
      case 'skills.disabledGlobal': {
        // Stored as a JSON array of skill names. Parse defensively: any
        // malformed value falls back to "no skills disabled" (all enabled).
        try {
          const parsed: unknown = JSON.parse(raw);
          target['skills.disabledGlobal'] =
            Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')
              ? (parsed as string[])
              : [];
        } catch {
          target['skills.disabledGlobal'] = [];
        }
        return;
      }
      case 'skills.disabledLocal': {
        // Stored as a JSON object mapping vault path -> disabled skill names.
        // Parse defensively: any malformed value falls back to an empty map.
        try {
          const parsed: unknown = JSON.parse(raw);
          target['skills.disabledLocal'] = isDisabledLocalMap(parsed) ? parsed : {};
        } catch {
          target['skills.disabledLocal'] = {};
        }
        return;
      }
      case 'skills.disabledUser': {
        // Stored as a JSON array of skill names (skills from user-configured
        // directories). Parse defensively: any malformed value falls back to
        // "no skills disabled" (all enabled).
        try {
          const parsed: unknown = JSON.parse(raw);
          target['skills.disabledUser'] =
            Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')
              ? (parsed as string[])
              : [];
        } catch {
          target['skills.disabledUser'] = [];
        }
        return;
      }
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
      case 'ai.timeoutSeconds': {
        // 0 is valid and means "wait indefinitely"; only negative or
        // malformed values fall back to the default.
        const n = Number.parseInt(raw, 10);
        target['ai.timeoutSeconds'] = Number.isFinite(n) && n >= 0
          ? n
          : DEFAULT_SETTINGS['ai.timeoutSeconds'];
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
      case 'ui.lastOpenFile':
        target['ui.lastOpenFile'] = raw.length === 0 ? null : raw;
        return;
      case 'ui.collapsedFolders': {
        // Stored as a JSON array of normalized vault-relative folder paths.
        // Parse defensively: any malformed value falls back to "nothing
        // collapsed" (the all-expanded default).
        try {
          const parsed: unknown = JSON.parse(raw);
          target['ui.collapsedFolders'] =
            Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')
              ? (parsed as string[])
              : [];
        } catch {
          target['ui.collapsedFolders'] = [];
        }
        return;
      }
      case 'ui.openTabs': {
        // Stored as a JSON array of vault-relative file paths in tab order.
        // Parse defensively: any malformed value falls back to "no tabs".
        try {
          const parsed: unknown = JSON.parse(raw);
          target['ui.openTabs'] =
            Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')
              ? (parsed as string[])
              : [];
        } catch {
          target['ui.openTabs'] = [];
        }
        return;
      }
      case 'pm.connections': {
        // Stored as a JSON object mapping vault path -> Connection[]. Parse
        // defensively (parseConnectionsMap drops malformed entries): any
        // malformed value falls back to an empty map.
        try {
          const parsed: unknown = JSON.parse(raw);
          target['pm.connections'] = parseConnectionsMap(parsed);
        } catch {
          target['pm.connections'] = {};
        }
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
      'editor.autoSave': s['editor.autoSave'] ? 'true' : 'false',
      'ai.baseUrl': s['ai.baseUrl'],
      'ai.apiKey': s['ai.apiKey'],
      'ai.chatModel': s['ai.chatModel'],
      'ai.embeddingModel': s['ai.embeddingModel'],
      'ai.embeddingsEnabled': s['ai.embeddingsEnabled'] ? 'true' : 'false',
      'ai.toolsEnabled': s['ai.toolsEnabled'] ? 'true' : 'false',
      'ai.disabledTools': JSON.stringify(s['ai.disabledTools'] ?? []),
      'ai.topK': String(s['ai.topK']),
      'ai.maxContextChars': String(s['ai.maxContextChars']),
      'ai.timeoutSeconds': String(s['ai.timeoutSeconds']),
      'skills.enabled': s['skills.enabled'] ? 'true' : 'false',
      'skills.directories': JSON.stringify(s['skills.directories'] ?? []),
      'skills.disabledGlobal': JSON.stringify(s['skills.disabledGlobal'] ?? []),
      'skills.disabledLocal': JSON.stringify(s['skills.disabledLocal'] ?? {}),
      'skills.disabledUser': JSON.stringify(s['skills.disabledUser'] ?? []),
      'ui.leftPaneWidth': String(s['ui.leftPaneWidth']),
      'ui.rightPaneWidth': String(s['ui.rightPaneWidth']),
      'ui.lastOpenFile': s['ui.lastOpenFile'] ?? '',
      'ui.collapsedFolders': JSON.stringify(s['ui.collapsedFolders'] ?? []),
      'ui.openTabs': JSON.stringify(s['ui.openTabs'] ?? []),
      'pm.connections': JSON.stringify(s['pm.connections'] ?? {}),
    };
  }

  /**
   * Returns the persisted PM connections for `vaultPath`, or an empty list when
   * none are configured. Reads the current `pm.connections` map keyed by vault.
   */
  connectionsForVault(vaultPath: string): Connection[] {
    return this._settings()['pm.connections'][vaultPath] ?? [];
  }

  /**
   * Upserts a connection under `vaultPath`, keyed by `connectionId`: an existing
   * entry with the same id is replaced in place, otherwise the connection is
   * appended. Persists the full settings via the existing `settings:*` channels
   * (the read-modify-write mirrors the `skills.disabledLocal` pattern, but
   * centralized here rather than in the settings modal).
   */
  async saveConnection(vaultPath: string, conn: Connection): Promise<void> {
    const map = this._settings()['pm.connections'];
    const current = map[vaultPath] ?? [];
    const exists = current.some((c) => c.connectionId === conn.connectionId);
    const nextList = exists
      ? current.map((c) => (c.connectionId === conn.connectionId ? conn : c))
      : [...current, conn];
    await this.update({ 'pm.connections': { ...map, [vaultPath]: nextList } });
  }

  /**
   * Removes the connection identified by `connectionId` from `vaultPath`. When
   * no connections remain for the vault the key is dropped from the map entirely
   * (rather than left as an empty array), keeping the stored map minimal — same
   * shape `parseConnectionsMap` would produce. Persists via `update`.
   */
  async removeConnection(vaultPath: string, connectionId: string): Promise<void> {
    const map = this._settings()['pm.connections'];
    const current = map[vaultPath] ?? [];
    const nextList = current.filter((c) => c.connectionId !== connectionId);
    const next = { ...map };
    if (nextList.length > 0) {
      next[vaultPath] = nextList;
    } else {
      delete next[vaultPath];
    }
    await this.update({ 'pm.connections': next });
  }
}
