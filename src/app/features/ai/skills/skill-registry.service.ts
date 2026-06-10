import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { IpcService } from '../../../core/ipc.service';
import { SettingsService } from '../../../core/settings.service';
import { VaultService } from '../../../core/vault.service';
import type { SkillMeta } from '../../../shared/types';

/**
 * Reactive, IPC-backed registry of AI Skills discovered by the Electron main
 * process. Skills are folders of on-demand instructions the model can load via
 * the `use_skill` tool. This service mirrors {@link ToolRegistryService} in
 * spirit but is dynamic: the underlying list is owned by main and refreshed
 * whenever the active vault changes (local skills live inside the vault).
 *
 * Enablement is layered on top of the raw list: a master switch
 * (`skills.enabled`) plus per-origin disable sets (global and user by name,
 * local by vault path). `enabled()` is what the orchestrator advertises to the
 * model; `skills()` is the full raw list used by settings UI.
 */
@Injectable({ providedIn: 'root' })
export class SkillRegistryService {
  private readonly ipc = inject(IpcService);
  private readonly settings = inject(SettingsService);
  private readonly vault = inject(VaultService);

  private readonly _skills = signal<SkillMeta[]>([]);

  /** The full raw skill list as discovered by main (no enablement filtering). */
  readonly skills = this._skills.asReadonly();

  /**
   * Skills the model may actually use this turn: empty when the master switch
   * is off, otherwise the raw list minus any disabled per origin. Local
   * disables are keyed by the current vault path.
   */
  readonly enabled = computed<SkillMeta[]>(() => {
    if (!this.settings.skillsEnabled()) return [];
    return this._skills().filter((s) => this.isEnabledWith(s));
  });

  constructor() {
    // Reload whenever the active vault changes (including the initial null →
    // path transition). The effect tracks ONLY vaultPath(); `reload()` writes
    // `_skills` (not read here), so there is no feedback loop.
    effect(() => {
      this.vault.vaultPath();
      void this.reload();
    });
  }

  /**
   * Re-fetches the skill list from main for the current vault. Errors are
   * swallowed to an empty list so a malformed skill folder can never break the
   * app or the chat loop.
   */
  async reload(): Promise<void> {
    try {
      const list = await this.ipc.skillsList(this.vault.vaultPath() ?? undefined);
      this._skills.set(list);
    } catch (err) {
      console.error('[skills] reload failed', err);
      this._skills.set([]);
    }
  }

  /** True when the skill is not disabled under the current settings + vault. */
  isEnabled(skill: SkillMeta): boolean {
    if (!this.settings.skillsEnabled()) return false;
    return this.isEnabledWith(skill);
  }

  /** Resolve an enabled skill by name (local already overrides global in main). */
  find(name: string): SkillMeta | undefined {
    return this.enabled().find((s) => s.name === name);
  }

  /**
   * Enablement check that ignores the master switch (used by `enabled`).
   * Global and user-directory skills are keyed by name (user-dir skills are
   * merged by name across directories in main, so a name disable applies to
   * whichever directory currently provides that skill); local skills are
   * keyed per vault path.
   */
  private isEnabledWith(skill: SkillMeta): boolean {
    if (skill.origin === 'global') {
      return !this.settings.disabledGlobalSkills().includes(skill.name);
    }
    if (skill.origin === 'user') {
      return !this.settings.disabledUserSkills().includes(skill.name);
    }
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) return true;
    const disabled = this.settings.disabledLocalSkills()[vaultPath] ?? [];
    return !disabled.includes(skill.name);
  }
}
