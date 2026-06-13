import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { SettingsService } from '../../core/settings.service';
import { VaultService } from '../../core/vault.service';
import type { FileNode } from '../../shared/types';
import { collectFolderPaths, toVaultRel } from '../../shared/vault-paths';

/**
 * Single source of truth for file-tree folder expansion. The default is
 * expanded, so only the COLLAPSED set is tracked — it stays small and is the
 * stable representation across tree refreshes (new folders appear expanded
 * without any bookkeeping).
 *
 * Keys are normalized vault-relative folder paths (forward slashes,
 * lowercase) persisted as-is under `ui.collapsedFolders`. Per-vault
 * correctness comes for free: VaultService clears the setting on vault
 * switch/close, and this service re-hydrates whenever the vault path
 * changes, so collapsing in vault A can never leak into vault B. Entries
 * whose folder no longer exists are pruned opportunistically whenever the
 * tree refreshes.
 */
@Injectable({ providedIn: 'root' })
export class TreeExpansionService {
  private readonly vault = inject(VaultService);
  private readonly settings = inject(SettingsService);

  private readonly _collapsed = signal<ReadonlySet<string>>(new Set());

  constructor() {
    // Re-hydrate from the persisted setting whenever the vault identity
    // changes (boot restore, switch, close). The setting itself is read
    // untracked so persisting a toggle does not re-trigger hydration.
    effect(() => {
      const vaultPath = this.vault.vaultPath();
      this.settings.hydrated();
      untracked(() => {
        this._collapsed.set(
          vaultPath === null ? new Set() : new Set(this.settings.collapsedFolders()),
        );
      });
    });

    // Opportunistic pruning of stale entries. Skipped while the tree is
    // empty (boot, vault switch in flight) so a not-yet-loaded tree can
    // never wipe the persisted state.
    effect(() => {
      const tree = this.vault.tree();
      untracked(() => this.prune(tree));
    });
  }

  /**
   * Reactive: reads the collapsed-set (and vault-path) signals, so node
   * `computed`s re-evaluate on toggle and on vault switches.
   */
  isCollapsed(absFolderPath: string): boolean {
    const key = this.keyFor(absFolderPath);
    return key !== null && this._collapsed().has(key);
  }

  toggle(absFolderPath: string): void {
    const key = this.keyFor(absFolderPath);
    if (key === null) return;
    const next = new Set(this._collapsed());
    if (!next.delete(key)) next.add(key);
    this.commit(next);
  }

  /** Ensures a folder is expanded (used by the "create inside" affordances). */
  expand(absFolderPath: string): void {
    const key = this.keyFor(absFolderPath);
    if (key === null || !this._collapsed().has(key)) return;
    const next = new Set(this._collapsed());
    next.delete(key);
    this.commit(next);
  }

  private prune(tree: readonly FileNode[]): void {
    if (tree.length === 0) return;
    const current = this._collapsed();
    if (current.size === 0) return;
    const vaultPath = this.vault.vaultPath();
    if (vaultPath === null) return;
    const existing = new Set<string>();
    for (const dir of collectFolderPaths(tree)) {
      const key = toVaultRel(vaultPath, dir)?.toLowerCase();
      if (key) existing.add(key);
    }
    const kept = [...current].filter((k) => existing.has(k));
    if (kept.length === current.size) return;
    this.commit(new Set(kept));
  }

  private commit(next: ReadonlySet<string>): void {
    this._collapsed.set(next);
    void this.settings.update({ 'ui.collapsedFolders': [...next].sort() });
  }

  private keyFor(absFolderPath: string): string | null {
    const vaultPath = this.vault.vaultPath();
    if (vaultPath === null) return null;
    const rel = toVaultRel(vaultPath, absFolderPath);
    return rel === null || rel.length === 0 ? null : rel.toLowerCase();
  }
}
