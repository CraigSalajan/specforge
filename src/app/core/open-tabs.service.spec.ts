import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileNode } from '../shared/types';
import { OpenTabsService } from './open-tabs.service';
import { SettingsService } from './settings.service';
import { VaultService } from './vault.service';

const VAULT = 'C:\\vault';
const A = 'C:\\vault\\a.md';
const B = 'C:\\vault\\b.md';
const C = 'C:\\vault\\sub\\c.md';

function file(path: string): FileNode {
  return { name: path.split(/[\\/]/).pop() ?? path, path, isDirectory: false };
}

function defaultTree(): FileNode[] {
  return [
    file(A),
    file(B),
    { name: 'sub', path: 'C:\\vault\\sub', isDirectory: true, children: [file(C)] },
  ];
}

/**
 * Structural stand-in for VaultService: writable signals plus a
 * setActiveFile that mirrors the real one's signal write (MRU tracking and
 * lastOpenFile persistence are irrelevant to tab logic).
 */
class FakeVaultService {
  readonly vaultPath = signal<string | null>(VAULT);
  readonly isLoading = signal(false);
  readonly tree = signal<FileNode[]>(defaultTree());
  readonly activeFilePath = signal<string | null>(null);

  readonly setActiveFile = vi.fn((path: string | null): void => {
    this.activeFilePath.set(path);
  });
}

class FakeSettingsService {
  readonly openTabs = signal<string[]>([]);
  readonly update = vi.fn(async (): Promise<void> => undefined);
}

describe('OpenTabsService', () => {
  let vault: FakeVaultService;
  let settings: FakeSettingsService;

  beforeEach(() => {
    vault = new FakeVaultService();
    settings = new FakeSettingsService();
    TestBed.configureTestingModule({
      providers: [
        { provide: VaultService, useValue: vault as unknown as VaultService },
        { provide: SettingsService, useValue: settings as unknown as SettingsService },
      ],
    });
  });

  /** Instantiates the service and flushes its vault-sync effect. */
  function createService(): OpenTabsService {
    const service = TestBed.inject(OpenTabsService);
    TestBed.tick();
    return service;
  }

  describe('hydration', () => {
    it('restores persisted vault-relative tabs as absolute paths in order', () => {
      settings.openTabs.set(['a.md', 'sub/c.md']);
      const service = createService();
      expect(service.tabs()).toEqual([A, C]);
    });

    it('prunes entries whose files no longer exist in the tree', () => {
      settings.openTabs.set(['a.md', 'ghost.md', 'sub/c.md']);
      const service = createService();
      expect(service.tabs()).toEqual([A, C]);
    });

    it('drops duplicate entries (case/separator-insensitive)', () => {
      settings.openTabs.set(['a.md', 'A.MD', 'b.md']);
      const service = createService();
      expect(service.tabs()).toEqual([A, B]);
    });

    it('folds the restored active file into the tab set when missing', () => {
      settings.openTabs.set(['b.md']);
      vault.activeFilePath.set(A);
      const service = createService();
      expect(service.tabs()).toEqual([B, A]);
    });

    it('clears all tab state while a different vault is loading', () => {
      settings.openTabs.set(['a.md']);
      const service = createService();
      expect(service.tabs()).toEqual([A]);

      vault.vaultPath.set('D:\\other');
      vault.isLoading.set(true);
      TestBed.tick();
      expect(service.tabs()).toEqual([]);
    });

    it('holds no tabs without a vault', () => {
      vault.vaultPath.set(null);
      const service = createService();
      expect(service.tabs()).toEqual([]);
    });
  });

  describe('openTab', () => {
    it('appends a missing tab and focuses it', () => {
      const service = createService();
      service.openTab(A);
      expect(service.tabs()).toEqual([A]);
      expect(vault.activeFilePath()).toBe(A);
    });

    it('only focuses when the tab is already open', () => {
      const service = createService();
      service.openTab(A);
      service.openTab(B);
      service.openTab(A);
      expect(service.tabs()).toEqual([A, B]);
      expect(vault.activeFilePath()).toBe(A);
    });

    it('gives every file opened via setActiveFile a tab (effect interception)', () => {
      const service = createService();
      vault.setActiveFile(B);
      TestBed.tick();
      expect(service.tabs()).toEqual([B]);
    });
  });

  describe('closeTab', () => {
    function openAll(service: OpenTabsService): void {
      service.openTab(A);
      service.openTab(B);
      service.openTab(C);
    }

    it('removes a background tab without changing focus', () => {
      const service = createService();
      openAll(service); // active: C
      service.closeTab(A);
      expect(service.tabs()).toEqual([B, C]);
      expect(vault.activeFilePath()).toBe(C);
    });

    it('focuses the right neighbor when closing the active tab', () => {
      const service = createService();
      openAll(service);
      service.openTab(B); // active: B
      service.closeTab(B);
      expect(service.tabs()).toEqual([A, C]);
      expect(vault.activeFilePath()).toBe(C);
    });

    it('falls back to the left neighbor, then to none', () => {
      const service = createService();
      openAll(service);
      service.openTab(C); // active: C (rightmost)
      service.closeTab(C);
      expect(vault.activeFilePath()).toBe(B);
      service.closeTab(B);
      expect(vault.activeFilePath()).toBe(A);
      service.closeTab(A);
      expect(service.tabs()).toEqual([]);
      expect(vault.activeFilePath()).toBeNull();
    });

    it('ignores paths that are not open', () => {
      const service = createService();
      service.openTab(A);
      service.closeTab(B);
      expect(service.tabs()).toEqual([A]);
    });
  });

  describe('closeOthers', () => {
    it('keeps only the given tab and focuses it', () => {
      const service = createService();
      service.openTab(A);
      service.openTab(B);
      service.openTab(C); // active: C
      service.closeOthers(A);
      expect(service.tabs()).toEqual([A]);
      expect(vault.activeFilePath()).toBe(A);
      expect(service.canReopen()).toBe(true);
    });
  });

  describe('reopenClosed', () => {
    it('reopens the most recently closed tab and focuses it', () => {
      const service = createService();
      service.openTab(A);
      service.openTab(B);
      service.closeTab(B);
      expect(service.canReopen()).toBe(true);
      service.reopenClosed();
      expect(service.tabs()).toEqual([A, B]);
      expect(vault.activeFilePath()).toBe(B);
      expect(service.canReopen()).toBe(false);
    });

    it('skips entries that are already open again', () => {
      const service = createService();
      service.openTab(A);
      service.openTab(B);
      service.closeTab(B);
      service.openTab(B); // reopened by other means
      service.reopenClosed();
      expect(service.tabs()).toEqual([A, B]);
      expect(service.canReopen()).toBe(false);
    });

    it('skips entries whose files were deleted since closing', () => {
      const service = createService();
      service.openTab(A);
      service.openTab(B);
      service.closeTab(B);
      vault.tree.set([file(A)]);
      TestBed.tick();
      service.reopenClosed();
      expect(service.tabs()).toEqual([A]);
      expect(service.canReopen()).toBe(false);
    });
  });

  describe('next / previous', () => {
    it('cycles forward and backward in tab-bar order', () => {
      const service = createService();
      service.openTab(A);
      service.openTab(B);
      service.openTab(C);
      service.openTab(A); // active: A
      service.next();
      expect(vault.activeFilePath()).toBe(B);
      service.previous();
      expect(vault.activeFilePath()).toBe(A);
      service.previous(); // wraps to the end
      expect(vault.activeFilePath()).toBe(C);
      service.next(); // wraps to the start
      expect(vault.activeFilePath()).toBe(A);
    });

    it('does nothing with a single tab or none', () => {
      const service = createService();
      service.next();
      expect(vault.activeFilePath()).toBeNull();
      service.openTab(A);
      vault.setActiveFile.mockClear();
      service.next();
      expect(vault.setActiveFile).not.toHaveBeenCalled();
    });
  });

  describe('moveTab', () => {
    it('reorders tabs (drag reorder)', () => {
      const service = createService();
      service.openTab(A);
      service.openTab(B);
      service.openTab(C);
      service.moveTab(0, 2);
      expect(service.tabs()).toEqual([B, C, A]);
      service.moveTab(2, 0);
      expect(service.tabs()).toEqual([A, B, C]);
    });

    it('ignores out-of-range indices', () => {
      const service = createService();
      service.openTab(A);
      service.openTab(B);
      service.moveTab(0, 5);
      service.moveTab(-1, 1);
      expect(service.tabs()).toEqual([A, B]);
    });
  });

  describe('handleRename', () => {
    const RENAMED = 'C:\\vault\\renamed.md';

    it('re-points the tab in place', () => {
      const service = createService();
      service.openTab(A);
      service.openTab(B); // active: B
      service.handleRename(A, RENAMED);
      expect(service.tabs()).toEqual([RENAMED, B]);
      expect(vault.activeFilePath()).toBe(B);
    });

    it('re-points the active file when it was the renamed one', () => {
      const service = createService();
      service.openTab(A); // active: A
      service.handleRename(A, RENAMED);
      expect(service.tabs()).toEqual([RENAMED]);
      expect(vault.activeFilePath()).toBe(RENAMED);
    });

    it('drops the stale tab when the destination is already open', () => {
      const service = createService();
      service.openTab(A);
      service.openTab(B);
      service.handleRename(A, B);
      expect(service.tabs()).toEqual([B]);
    });
  });

  describe('handleDelete', () => {
    it('closes the tab without remembering it for reopen', () => {
      const service = createService();
      service.openTab(A);
      service.openTab(B); // active: B
      service.handleDelete(B);
      expect(service.tabs()).toEqual([A]);
      expect(vault.activeFilePath()).toBe(A);
      expect(service.canReopen()).toBe(false);
    });
  });

  describe('handleFolderDelete', () => {
    it('closes every tab under the deleted folder', () => {
      const service = createService();
      service.openTab(A);
      service.openTab(C); // lives in sub\
      service.handleFolderDelete('C:\\vault\\sub');
      expect(service.tabs()).toEqual([A]);
    });
  });

  describe('persistence', () => {
    it('persists vault-relative forward-slash paths in tab order', () => {
      const service = createService();
      service.openTab(A);
      service.openTab(C);
      expect(settings.update).toHaveBeenLastCalledWith({ 'ui.openTabs': ['a.md', 'sub/c.md'] });
    });

    it('persists removals', () => {
      const service = createService();
      service.openTab(A);
      service.openTab(B);
      service.closeTab(A);
      expect(settings.update).toHaveBeenLastCalledWith({ 'ui.openTabs': ['b.md'] });
    });

    it('skips redundant writes when nothing changed', () => {
      settings.openTabs.set(['a.md']);
      createService();
      // Hydration restores exactly the stored set — no write-back needed.
      expect(settings.update).not.toHaveBeenCalled();
    });
  });
});
