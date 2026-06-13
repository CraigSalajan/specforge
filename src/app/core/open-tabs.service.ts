import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { normalizePath, samePath } from '../shared/path-utils';
import type { FileNode } from '../shared/types';
import { fromVaultRel, toVaultRel, treeContainsFile } from '../shared/vault-paths';
import { SettingsService } from './settings.service';
import { VaultService } from './vault.service';

/** Session-only cap on the reopen-closed-tab stack. */
const MAX_RECENTLY_CLOSED = 10;

/**
 * Open editor tabs (absolute file paths, tab-bar order). The ACTIVE tab is
 * not duplicated here — `VaultService.activeFilePath` stays the canonical
 * focused-file signal that the editor, outline, links panel, AI panel and
 * command guards already consume; this service only owns set membership and
 * order.
 *
 * Integration is deliberately one-way (this service injects VaultService,
 * never the reverse): a constructor `effect()` watches the vault signals so
 * that EVERY existing open entry point — file tree, quick switcher, wikilink
 * clicks, search hits, citations, file creation, boot restore — converges on
 * `setActiveFile()` and gets a tab with zero call-site changes. The
 * alternative (a hook injected into VaultService) was rejected because it
 * couples VaultService to tab semantics and depends on instantiation order;
 * the effect is fully decoupled and self-correcting.
 *
 * Dirty handling on close is owned by the editor: closing the active tab
 * always changes `activeFilePath` (to a neighbor or null), which routes
 * through the editor's `switchTo` — the single place that flushes (auto-save
 * on) or prompts Save/Discard (auto-save off). Background tabs are never
 * dirty (one live buffer, flush-on-switch invariant), so closing them never
 * touches the buffer.
 *
 * Persistence: `'ui.openTabs'` stores vault-relative paths in tab order;
 * `'ui.lastOpenFile'` (pre-existing) remains the active-tab pointer. Both are
 * per-vault state, cleared by VaultService on vault switch/close. Restore
 * hydrates the tab set once per vault — after the tree has loaded — pruning
 * entries whose files no longer exist; VaultService then restores the active
 * file, which the effect folds into the set if it ever got out of sync.
 */
@Injectable({ providedIn: 'root' })
export class OpenTabsService {
  private readonly vault = inject(VaultService);
  private readonly settings = inject(SettingsService);

  private readonly _tabs = signal<string[]>([]);
  /** Absolute paths of the open tabs, in tab-bar order. */
  readonly tabs = this._tabs.asReadonly();

  /** The focused tab — an alias of the canonical active-file signal. */
  readonly activeTab = this.vault.activeFilePath;

  /** Recently closed tabs (session-only), oldest first; reopen pops the end. */
  private readonly _recentlyClosed = signal<string[]>([]);
  readonly canReopen = computed(() => this._recentlyClosed().length > 0);

  /**
   * Normalized vault path whose persisted tab set has been hydrated, or null.
   * Persistence writes are suppressed until hydration so a pre-hydration tab
   * mutation can never clobber the stored set.
   */
  private hydratedVaultKey: string | null = null;

  constructor() {
    effect(() => {
      const vaultPath = this.vault.vaultPath();
      const isLoading = this.vault.isLoading();
      const tree = this.vault.tree();
      const active = this.vault.activeFilePath();
      untracked(() => this.syncWithVault(vaultPath, isLoading, tree, active));
    });
  }

  /** Adds `path` as a tab if missing and focuses it. */
  openTab(path: string): void {
    if (!this.hasTab(path)) {
      this.setTabs([...this._tabs(), path]);
    }
    this.vault.setActiveFile(path);
  }

  /**
   * Closes the tab for `path` (no-op when not open) and remembers it for
   * reopen. Closing the active tab focuses the nearest neighbor — the tab to
   * the right, else the left, else none (editor empty state). The resulting
   * active-file change routes through the editor's `switchTo`, which owns the
   * dirty flush / Save-Discard prompt.
   */
  closeTab(path: string): void {
    this.removeTab(path, { remember: true });
  }

  /** Closes every tab except `path` and focuses it. */
  closeOthers(path: string): void {
    const tabs = this._tabs();
    const keep = tabs.find((t) => samePath(t, path));
    if (keep === undefined) return;
    const closed = tabs.filter((t) => !samePath(t, keep));
    if (closed.length === 0) return;
    for (const tab of closed) this.pushRecentlyClosed(tab);
    this.setTabs([keep]);
    const active = this.vault.activeFilePath();
    if (active === null || !samePath(active, keep)) {
      this.vault.setActiveFile(keep);
    }
  }

  /**
   * Reopens the most recently closed tab and focuses it. Entries that are
   * already open again, or whose file has since disappeared from the vault,
   * are skipped (popped and dropped).
   */
  reopenClosed(): void {
    for (;;) {
      const stack = this._recentlyClosed();
      const candidate = stack[stack.length - 1];
      if (candidate === undefined) return;
      this._recentlyClosed.set(stack.slice(0, -1));
      if (this.hasTab(candidate)) continue;
      if (!treeContainsFile(this.vault.tree(), candidate)) continue;
      this.openTab(candidate);
      return;
    }
  }

  /** Focuses the next tab in tab-bar order (cyclic). */
  next(): void {
    this.step(1);
  }

  /** Focuses the previous tab in tab-bar order (cyclic). */
  previous(): void {
    this.step(-1);
  }

  /** Reorders the tab at `from` to position `to` (drag reorder). */
  moveTab(from: number, to: number): void {
    const tabs = [...this._tabs()];
    if (from === to) return;
    if (from < 0 || from >= tabs.length || to < 0 || to >= tabs.length) return;
    const [moved] = tabs.splice(from, 1);
    tabs.splice(to, 0, moved);
    this.setTabs(tabs);
  }

  /**
   * Re-points the tab for a renamed/moved file, keeping its position. Also
   * re-points the active file when it was the renamed one — fixing the
   * pre-existing bug where renaming the active file left `activeFilePath` on
   * the stale path. Callers must flush the editor buffer BEFORE the rename so
   * the switch-away flush cannot recreate the old file.
   */
  handleRename(oldPath: string, newPath: string): void {
    const tabs = this._tabs();
    const idx = tabs.findIndex((t) => samePath(t, oldPath));
    if (idx >= 0) {
      const dupIdx = tabs.findIndex((t) => samePath(t, newPath));
      const nextTabs = [...tabs];
      if (dupIdx >= 0 && dupIdx !== idx) {
        // The destination is already open in another tab; drop the stale one.
        nextTabs.splice(idx, 1);
      } else {
        nextTabs[idx] = newPath;
      }
      this.setTabs(nextTabs);
    }
    const active = this.vault.activeFilePath();
    if (active !== null && samePath(active, oldPath)) {
      this.vault.setActiveFile(newPath);
    }
  }

  /**
   * Closes the tab for an in-app confirmed file deletion (not remembered for
   * reopen — the file is gone). External deletions of the active file are
   * deliberately NOT routed here: they keep their tab and surface the
   * editor's deleted-on-disk banner instead.
   */
  handleDelete(path: string): void {
    this.removeTab(path, { remember: false });
  }

  /** Closes every tab under a deleted folder (in-app confirmed delete). */
  handleFolderDelete(dirPath: string): void {
    const prefix = normalizePath(dirPath) + '/';
    const doomed = this._tabs().filter((t) => normalizePath(t).startsWith(prefix));
    for (const tab of doomed) this.removeTab(tab, { remember: false });
  }

  private hasTab(path: string): boolean {
    return this._tabs().some((t) => samePath(t, path));
  }

  private step(delta: 1 | -1): void {
    const tabs = this._tabs();
    if (tabs.length === 0) return;
    const active = this.vault.activeFilePath();
    const idx = active !== null ? tabs.findIndex((t) => samePath(t, active)) : -1;
    const next =
      idx < 0
        ? delta === 1
          ? tabs[0]
          : tabs[tabs.length - 1]
        : tabs[(idx + delta + tabs.length) % tabs.length];
    if (active !== null && samePath(next, active)) return;
    this.vault.setActiveFile(next);
  }

  private removeTab(path: string, opts: { remember: boolean }): void {
    const tabs = this._tabs();
    const idx = tabs.findIndex((t) => samePath(t, path));
    if (idx < 0) return;
    const closing = tabs[idx];
    const remaining = tabs.filter((_, i) => i !== idx);
    if (opts.remember) this.pushRecentlyClosed(closing);
    this.setTabs(remaining);
    const active = this.vault.activeFilePath();
    if (active !== null && samePath(active, closing)) {
      this.vault.setActiveFile(remaining[idx] ?? remaining[idx - 1] ?? null);
    }
  }

  private pushRecentlyClosed(path: string): void {
    this._recentlyClosed.update((stack) =>
      [...stack.filter((p) => !samePath(p, path)), path].slice(-MAX_RECENTLY_CLOSED),
    );
  }

  /**
   * Keeps tab state consistent with the vault lifecycle:
   *  - no vault → no tabs;
   *  - vault changed and still loading → drop the old vault's tabs, wait;
   *  - vault loaded for the first time → hydrate the persisted set (pruned
   *    against the freshly loaded tree);
   *  - always → the active file has a tab (covers every open entry point).
   */
  private syncWithVault(
    vaultPath: string | null,
    isLoading: boolean,
    tree: readonly FileNode[],
    active: string | null,
  ): void {
    if (vaultPath === null) {
      this.resetState();
      return;
    }
    if (normalizePath(vaultPath) !== this.hydratedVaultKey) {
      if (isLoading) {
        // Mid vault-switch: the tree (and the cleared settings) for the new
        // vault are not in place yet. Old-vault tabs must not leak through.
        this.resetState();
        return;
      }
      this.hydrate(vaultPath, tree);
    }
    if (active !== null && !this.hasTab(active)) {
      this.setTabs([...this._tabs(), active]);
    }
  }

  private resetState(): void {
    if (this._tabs().length > 0) this._tabs.set([]);
    if (this._recentlyClosed().length > 0) this._recentlyClosed.set([]);
    this.hydratedVaultKey = null;
  }

  private hydrate(vaultPath: string, tree: readonly FileNode[]): void {
    const restored: string[] = [];
    const seen = new Set<string>();
    for (const rel of this.settings.openTabs()) {
      if (rel.length === 0) continue;
      const abs = fromVaultRel(vaultPath, rel);
      const key = normalizePath(abs);
      if (seen.has(key)) continue;
      // Stale entries (file deleted while the app was closed) are pruned,
      // mirroring VaultService.restoreLastOpenFile.
      if (!treeContainsFile(tree, abs)) continue;
      seen.add(key);
      restored.push(abs);
    }
    this.hydratedVaultKey = normalizePath(vaultPath);
    this._recentlyClosed.set([]);
    this.setTabs(restored);
  }

  private setTabs(next: string[]): void {
    this._tabs.set(next);
    this.persistTabs();
  }

  /**
   * Persists the tab set as vault-relative paths (same scheme as
   * `ui.lastOpenFile`). Paths outside the vault root serialize to nothing, so
   * a file still open from a previous vault can never be restored into the
   * wrong one. Redundant writes are skipped.
   */
  private persistTabs(): void {
    if (this.hydratedVaultKey === null) return;
    const vaultPath = this.vault.vaultPath();
    if (vaultPath === null) return;
    const rels: string[] = [];
    for (const tab of this._tabs()) {
      const rel = toVaultRel(vaultPath, tab);
      if (rel !== null) rels.push(rel);
    }
    const current = this.settings.openTabs();
    if (current.length === rels.length && current.every((v, i) => v === rels[i])) return;
    void this.settings.update({ 'ui.openTabs': rels });
  }
}
