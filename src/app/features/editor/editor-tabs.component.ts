import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { ContextMenuService, type ContextMenuItem } from '../../core/context-menu.service';
import { EditorStatusService } from '../../core/editor-status.service';
import { OpenTabsService } from '../../core/open-tabs.service';
import { VaultService } from '../../core/vault.service';
import { normalizePath, samePath } from '../../shared/path-utils';
import { toVaultRel } from '../../shared/vault-paths';

/** One rendered tab. `key` is the normalized path (stable identity). */
interface TabItem {
  path: string;
  key: string;
  label: string;
  /** Parent-folder disambiguator when basenames collide, or null. */
  detail: string | null;
  /** Tooltip — the vault-relative path. */
  title: string;
  active: boolean;
  dirty: boolean;
  index: number;
}

/**
 * Tab strip above the editor: one tab per open file (OpenTabsService), the
 * active tab tracking `VaultService.activeFilePath`. Quiet chrome per
 * DESIGN.md — surface ramp + 1px borders, no shadows, no motion. The strip
 * renders nothing while no tabs are open (the editor's empty state leads).
 *
 * Interactions: click focuses, middle-click / × / Delete closes, drag
 * reorders (same HTML5 drag vocabulary as the vault tree), right-click opens
 * the shared context menu, ArrowLeft/Right/Home/End move focus within the
 * tablist (roving tabindex; Enter/Space activate via native button
 * semantics). Overflow scrolls horizontally with a hidden scrollbar; the
 * active tab is kept in view on activation.
 */
@Component({
  selector: 'app-editor-tabs',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (tabItems().length > 0) {
      <div
        role="tablist"
        aria-label="Open files"
        class="tab-strip flex h-9 shrink-0 items-stretch overflow-x-auto overflow-y-hidden border-b border-border-subtle bg-surface-1">
        @for (tab of tabItems(); track tab.key) {
          <button
            type="button"
            role="tab"
            [id]="tabElementId(tab.key)"
            [attr.aria-selected]="tab.active"
            [tabindex]="tabIndexFor(tab)"
            draggable="true"
            [class]="tabClass(tab)"
            [title]="tab.title"
            (click)="onActivate(tab)"
            (mousedown)="onMousedown($event)"
            (auxclick)="onAuxClick($event, tab)"
            (keydown)="onTabKeydown($event, tab)"
            (contextmenu)="onTabContextMenu($event, tab)"
            (dragstart)="onDragStart($event, tab)"
            (dragover)="onDragOver($event, tab)"
            (dragleave)="onDragLeave(tab)"
            (drop)="onDrop($event, tab)"
            (dragend)="onDragEnd()">
            <span class="truncate">{{ tab.label }}</span>
            @if (tab.detail; as detail) {
              <span class="shrink-0 truncate text-text-muted">{{ detail }}</span>
            }
            <span class="flex h-4 w-4 shrink-0 items-center justify-center">
              @if (tab.dirty) {
                <span
                  class="h-1.5 w-1.5 rounded-full bg-accent group-hover:hidden"
                  title="Unsaved changes"></span>
              }
              <!-- Pointer-only affordance (keyboard: Ctrl+W / Delete), so it
                   stays out of the tab order and the accessibility tree. -->
              <span
                aria-hidden="true"
                [class]="closeClass(tab)"
                title="Close tab"
                (click)="onCloseClick($event, tab)">×</span>
            </span>
          </button>
        }
      </div>
    }
  `,
  styles: [
    `
      .tab-strip {
        scrollbar-width: none;
      }
      .tab-strip::-webkit-scrollbar {
        display: none;
      }
    `,
  ],
})
export class EditorTabsComponent {
  private readonly openTabs = inject(OpenTabsService);
  private readonly vault = inject(VaultService);
  private readonly editorStatus = inject(EditorStatusService);
  private readonly contextMenu = inject(ContextMenuService);

  /** Tab currently hovered by a drag, for the drop-target highlight. */
  private readonly dropTargetKey = signal<string | null>(null);

  readonly tabItems = computed<TabItem[]>(() => {
    const vaultPath = this.vault.vaultPath();
    const active = this.vault.activeFilePath();
    const activeDirty = this.editorStatus.activeDirty();
    const tabs = this.openTabs.tabs();

    // Duplicate basenames (case-insensitive) get a parent-folder suffix.
    const nameCounts = new Map<string, number>();
    for (const path of tabs) {
      const name = basenameOf(path).toLowerCase();
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }

    return tabs.map((path, index) => {
      const label = basenameOf(path);
      const duplicated = (nameCounts.get(label.toLowerCase()) ?? 0) > 1;
      const isActive = active !== null && samePath(path, active);
      return {
        path,
        key: normalizePath(path),
        label,
        detail: duplicated ? parentFolderOf(path) : null,
        title: (vaultPath !== null ? toVaultRel(vaultPath, path) : null) ?? path,
        active: isActive,
        dirty: isActive && activeDirty,
        index,
      };
    });
  });

  /** True when some tab is the active one (false e.g. after a pruned restore). */
  private readonly hasActiveTab = computed(() => this.tabItems().some((t) => t.active));

  constructor() {
    // Keep the active tab visible when activation comes from elsewhere
    // (quick switcher, wikilink, Ctrl+Tab). rAF defers past the render that
    // may have just created the tab element. 'nearest' is a no-op when the
    // tab is already in view, so this never fights a manual scroll.
    effect(() => {
      const active = this.vault.activeFilePath();
      this.openTabs.tabs();
      if (active === null) return;
      const id = this.tabElementId(normalizePath(active));
      untracked(() => {
        requestAnimationFrame(() => {
          document
            .getElementById(id)
            ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        });
      });
    });
  }

  /**
   * Roving tabindex: the active tab is the focusable one. When NO tab is
   * active (tabs restored but the last open file was pruned), the first tab
   * takes the slot so the tablist stays keyboard-reachable — the WAI-ARIA
   * tabs pattern requires exactly one tab with tabindex 0.
   */
  protected tabIndexFor(tab: TabItem): number {
    if (tab.active) return 0;
    return !this.hasActiveTab() && tab.index === 0 ? 0 : -1;
  }

  protected onActivate(tab: TabItem): void {
    this.openTabs.openTab(tab.path);
  }

  /** Middle-click closes (auxclick button 1), VS Code-style. */
  protected onAuxClick(evt: MouseEvent, tab: TabItem): void {
    if (evt.button !== 1) return;
    evt.preventDefault();
    this.openTabs.closeTab(tab.path);
  }

  /** Suppress Chromium's middle-click autoscroll on the strip. */
  protected onMousedown(evt: MouseEvent): void {
    if (evt.button === 1) evt.preventDefault();
  }

  protected onCloseClick(evt: MouseEvent, tab: TabItem): void {
    evt.stopPropagation();
    this.openTabs.closeTab(tab.path);
  }

  /**
   * WAI-ARIA tabs pattern (manual activation): arrows/Home/End move focus
   * within the tablist; Enter/Space activate via the button's native click.
   * Delete closes the focused tab.
   */
  protected onTabKeydown(evt: KeyboardEvent, tab: TabItem): void {
    const items = this.tabItems();
    switch (evt.key) {
      case 'ArrowRight':
        evt.preventDefault();
        this.focusTabAt((tab.index + 1) % items.length);
        break;
      case 'ArrowLeft':
        evt.preventDefault();
        this.focusTabAt((tab.index - 1 + items.length) % items.length);
        break;
      case 'Home':
        evt.preventDefault();
        this.focusTabAt(0);
        break;
      case 'End':
        evt.preventDefault();
        this.focusTabAt(items.length - 1);
        break;
      case 'Delete':
        evt.preventDefault();
        this.openTabs.closeTab(tab.path);
        break;
    }
  }

  protected onTabContextMenu(evt: MouseEvent, tab: TabItem): void {
    evt.preventDefault();
    const items: ContextMenuItem[] = [
      { type: 'item', label: 'Close', action: () => this.openTabs.closeTab(tab.path) },
    ];
    if (this.openTabs.tabs().length > 1) {
      items.push({
        type: 'item',
        label: 'Close Others',
        action: () => this.openTabs.closeOthers(tab.path),
      });
    }
    if (this.openTabs.canReopen()) {
      items.push(
        { type: 'separator' },
        { type: 'item', label: 'Reopen Closed Tab', action: () => this.openTabs.reopenClosed() },
      );
    }
    this.contextMenu.open(evt.clientX, evt.clientY, items);
  }

  protected onDragStart(evt: DragEvent, tab: TabItem): void {
    evt.dataTransfer?.setData('application/x-specforge-tab', tab.path);
    if (evt.dataTransfer) evt.dataTransfer.effectAllowed = 'move';
  }

  protected onDragOver(evt: DragEvent, tab: TabItem): void {
    if (!evt.dataTransfer?.types.includes('application/x-specforge-tab')) return;
    evt.preventDefault();
    evt.dataTransfer.dropEffect = 'move';
    this.dropTargetKey.set(tab.key);
  }

  protected onDragLeave(tab: TabItem): void {
    if (this.dropTargetKey() === tab.key) this.dropTargetKey.set(null);
  }

  protected onDrop(evt: DragEvent, tab: TabItem): void {
    evt.preventDefault();
    this.dropTargetKey.set(null);
    const source = evt.dataTransfer?.getData('application/x-specforge-tab');
    if (!source) return;
    const from = this.tabItems().findIndex((t) => samePath(t.path, source));
    if (from < 0 || from === tab.index) return;
    // No animated reordering — the list re-renders in place (reduced-motion
    // friendly by construction).
    this.openTabs.moveTab(from, tab.index);
  }

  protected onDragEnd(): void {
    this.dropTargetKey.set(null);
  }

  /**
   * Active tab adopts the editor surface (`surface-0`) + primary ink so it
   * reads as part of the document below; inactive tabs stay quiet secondary
   * ink with a soft hover fill. Drop target gets the tree's drag highlight.
   */
  protected tabClass(tab: TabItem): string {
    const base =
      'group flex min-w-0 max-w-56 shrink-0 cursor-pointer select-none items-center gap-1.5 ' +
      'border-r border-border-subtle px-3 text-xs transition-colors ' +
      'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent';
    const state = tab.active
      ? 'bg-surface-0 text-text-primary'
      : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary';
    const drop = this.dropTargetKey() === tab.key ? ' ring-1 ring-inset ring-accent' : '';
    return `${base} ${state}${drop}`;
  }

  /**
   * VS Code-style close affordance: always visible on the active tab, on
   * hover elsewhere; while dirty, the dot holds the slot until hover swaps
   * the × in.
   */
  protected closeClass(tab: TabItem): string {
    const base =
      'h-4 w-4 items-center justify-center rounded leading-none text-text-muted ' +
      'hover:bg-surface-3 hover:text-text-primary';
    const visibility = tab.active && !tab.dirty ? 'flex' : 'hidden group-hover:flex';
    return `${base} ${visibility}`;
  }

  /** Sanitized element id (same scheme as the palette's option ids). */
  protected tabElementId(key: string): string {
    return `editor-tab-${key.replace(/[^\w-]+/g, '_')}`;
  }

  private focusTabAt(index: number): void {
    const item = this.tabItems()[index];
    if (!item) return;
    document.getElementById(this.tabElementId(item.key))?.focus();
  }
}

function basenameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function parentFolderOf(path: string): string | null {
  const segments = path.split(/[\\/]/).filter((s) => s.length > 0);
  return segments.length >= 2 ? segments[segments.length - 2] : null;
}
