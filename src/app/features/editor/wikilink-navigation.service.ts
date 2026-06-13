import { Injectable, inject } from '@angular/core';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { EditorNavigationService } from '../../core/editor-navigation.service';
import { IpcService } from '../../core/ipc.service';
import { VaultService } from '../../core/vault.service';
import {
  findAtxHeadingLine,
  joinVaultPath,
  parentDir,
  splitWikiTarget,
} from './wikilink-utils';

/**
 * Handles a click on a rendered `[[wikilink]]` in the editor:
 *
 * - Resolves the target through the main process (`linksResolve`,
 *   Obsidian-style basename matching) and opens the file — landing on the
 *   matching ATX heading's line when the link carries a `#Heading` fragment.
 * - `[[#Heading]]` (no target) jumps within the active file.
 * - Unresolved targets offer to create `Target.md` — alongside the active
 *   file's folder, since the link being clicked lives in that file and
 *   Obsidian-style bare links resolve regardless of folder; vault root when
 *   somehow no file is active. (VaultFileOpsService.createFile is not used
 *   here: it prompts for a name, and the name is already known.)
 */
@Injectable({ providedIn: 'root' })
export class WikilinkNavigationService {
  private readonly ipc = inject(IpcService);
  private readonly vault = inject(VaultService);
  private readonly editorNav = inject(EditorNavigationService);
  private readonly confirmDialog = inject(ConfirmDialogService);

  /** Raw target as written: alias already stripped, `#fragment` kept. */
  async open(rawTarget: string): Promise<void> {
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) return;
    const { target, fragment } = splitWikiTarget(rawTarget);

    // Same-file anchor: [[#Heading]].
    if (target === '') {
      const active = this.vault.activeFilePath();
      if (active && fragment) await this.openAtHeading(active, fragment);
      return;
    }

    let relPath: string | null = null;
    try {
      relPath = await this.ipc.linksResolve(vaultPath, target);
    } catch (err) {
      await this.confirmDialog.notice({
        title: 'Could not resolve link',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (relPath !== null) {
      const absPath = joinVaultPath(vaultPath, relPath);
      if (fragment) {
        await this.openAtHeading(absPath, fragment);
      } else {
        this.vault.setActiveFile(absPath);
      }
      return;
    }

    await this.confirmCreateAndOpen(vaultPath, target);
  }

  /**
   * Opens `absPath` on the first ATX heading matching `fragment`
   * (case-insensitive); plain open when no heading matches or the file
   * cannot be read.
   */
  private async openAtHeading(absPath: string, fragment: string): Promise<void> {
    let line: number | null = null;
    try {
      const content = await this.ipc.readFile(absPath);
      line = findAtxHeadingLine(content, fragment);
    } catch {
      // Unreadable: fall through to a plain open; the editor surfaces its
      // own read error there.
    }
    if (line !== null) {
      this.editorNav.openFileAtLine(absPath, line);
    } else {
      this.vault.setActiveFile(absPath);
    }
  }

  private async confirmCreateAndOpen(vaultPath: string, target: string): Promise<void> {
    const fileName = `${target}.md`;
    const confirmed = await this.confirmDialog.confirm({
      title: 'Create file',
      message: `"${fileName}" does not exist yet. Create it?`,
      confirmLabel: 'Create',
    });
    if (!confirmed) return;

    const active = this.vault.activeFilePath();
    const baseDir = active ? parentDir(active) : vaultPath;
    const absPath = joinVaultPath(baseDir, fileName);
    try {
      await this.ipc.createFile(absPath);
      await this.vault.refreshTree();
      this.vault.setActiveFile(absPath);
    } catch (err) {
      await this.confirmDialog.notice({
        title: 'Could not create file',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
