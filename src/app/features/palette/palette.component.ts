import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { CommandRegistryService } from '../../core/command-registry.service';
import { UiStateService } from '../../core/ui-state.service';
import { VaultService } from '../../core/vault.service';
import { normalizePath } from '../../shared/path-utils';
import type { FileNode } from '../../shared/types';
import { toVaultRel } from '../../shared/vault-paths';
import { rankItems } from './fuzzy-match';

/** A vault file flattened out of the tree for matching. */
interface PaletteFile {
  name: string;
  relPath: string;
  absPath: string;
}

/** One row in the palette list (file or command, never mixed). */
interface PaletteItem {
  kind: 'file' | 'command';
  /** File: absolute path. Command: registry id. Unique within a mode. */
  id: string;
  label: string;
  /** Dimmed context — vault-relative path or command category. */
  detail?: string;
  /** Right-aligned mono hint — command shortcut. */
  hint?: string;
}

/** Stable listbox id for the combobox `aria-controls` wiring. */
const LISTBOX_ID = 'palette-listbox';

/** Render cap; ranking runs over everything, only display is bounded. */
const MAX_RESULTS = 100;

/**
 * Quick switcher (Ctrl+P) and command palette (Ctrl+Shift+P) in a single
 * overlay, VS Code-style: one input, where a leading `>` switches the list
 * from vault files to registry commands. Mounted once at the app root next to
 * the other shared dialogs; opened via UiStateService.
 *
 * Focus model: the input is the only focusable element (combobox pattern, as
 * in composer-autocomplete), so the trap is simply "Tab does nothing". The
 * previously focused element is captured on open and restored on close.
 */
@Component({
  selector: 'app-palette',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (request()) {
      <!-- Lighter scrim than modal dialogs (no blur): the palette is a
           transient, quiet surface that opens and closes constantly. -->
      <div
        class="fixed inset-0 z-50 flex justify-center bg-black/30 px-4 pt-[12vh]"
        (click)="close()">
        <div
          class="palette-panel flex h-fit max-h-[60vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-border-strong bg-surface-1 shadow-2xl"
          role="dialog"
          aria-modal="true"
          aria-label="Quick switcher"
          (click)="$event.stopPropagation()"
          (mousedown)="onPanelMousedown($event)">
          <div class="border-b border-border-subtle p-2">
            <input
              #queryInput
              type="text"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-label="Search files and commands"
              [attr.aria-controls]="listboxId"
              [attr.aria-activedescendant]="activeDescendantId()"
              autocomplete="off"
              spellcheck="false"
              class="w-full rounded border border-border-subtle bg-surface-2 px-3 py-1.5 text-sm text-text-primary placeholder:text-text-secondary focus:border-accent focus:outline-none"
              placeholder="Search files by name…"
              [value]="query()"
              (input)="onInput($event)"
              (keydown)="onKeydown($event)" />
          </div>

          <div
            class="min-h-0 flex-1 overflow-y-auto py-1"
            role="listbox"
            [id]="listboxId"
            [attr.aria-label]="commandMode() ? 'Commands' : 'Files'">
            @for (item of items(); track item.id; let i = $index) {
              <div
                [id]="optionId(item.id)"
                role="option"
                [attr.aria-selected]="i === activeIndex()"
                class="mx-1 flex cursor-pointer items-baseline gap-2 rounded px-2 py-1 text-sm"
                [class.bg-surface-3]="i === activeIndex()"
                [class.text-text-primary]="i === activeIndex()"
                [class.text-text-secondary]="i !== activeIndex()"
                (mouseenter)="onHover(i)"
                (click)="onSelect(item)">
                <span class="min-w-0 shrink truncate" [title]="item.label">{{ item.label }}</span>
                @if (item.detail; as detail) {
                  <span
                    class="min-w-0 shrink-[9999] grow basis-0 truncate text-right text-xs text-text-muted"
                    [title]="detail">{{ detail }}</span>
                }
                @if (item.hint; as hint) {
                  <span class="shrink-0 font-mono text-xs text-text-muted">{{ hint }}</span>
                }
              </div>
            } @empty {
              <div class="px-3 py-2 text-sm text-text-muted">{{ emptyMessage() }}</div>
            }
          </div>

          <footer
            class="flex items-center gap-3 border-t border-border-subtle px-3 py-1.5 text-xs text-text-muted">
            <span>↑↓ to navigate</span>
            <span>↵ to {{ commandMode() ? 'run' : 'open' }}</span>
            <span>esc to dismiss</span>
            @if (!commandMode()) {
              <span class="ml-auto">type &gt; for commands</span>
            }
          </footer>
        </div>
      </div>
    }
  `,
  styles: [
    `
      .palette-panel {
        animation: palette-in 120ms ease-out;
      }
      @keyframes palette-in {
        from {
          opacity: 0;
          transform: translateY(-4px);
        }
        to {
          opacity: 1;
          transform: none;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .palette-panel {
          animation: none;
        }
      }
    `,
  ],
})
export class PaletteComponent {
  private readonly ui = inject(UiStateService);
  private readonly vault = inject(VaultService);
  private readonly registry = inject(CommandRegistryService);
  private readonly injector = inject(Injector);

  protected readonly listboxId = LISTBOX_ID;

  readonly request = this.ui.paletteRequest;

  readonly query = signal('');
  /** Raw highlight position; clamped via activeIndex when the list shrinks. */
  readonly highlightedIndex = signal(0);

  private readonly queryInput = viewChild<ElementRef<HTMLInputElement>>('queryInput');

  /** Element to give focus back to when the palette closes. */
  private restoreFocusTo: HTMLElement | null = null;
  private handledSeq = 0;
  private isOpen = false;

  /** `>` prefix flips file mode into command mode, VS Code-style. */
  readonly commandMode = computed(() => this.query().startsWith('>'));

  private readonly effectiveQuery = computed(() => {
    const q = this.query();
    return (this.commandMode() ? q.slice(1) : q).trim();
  });

  private readonly allFiles = computed<PaletteFile[]>(() => {
    const vaultPath = this.vault.vaultPath();
    if (!vaultPath) return [];
    const files: PaletteFile[] = [];
    flattenFiles(this.vault.tree(), vaultPath, files);
    return files;
  });

  readonly items = computed<PaletteItem[]>(() => {
    if (!this.request()) return [];
    return this.commandMode() ? this.commandItems() : this.fileItems();
  });

  readonly activeIndex = computed(() => {
    const count = this.items().length;
    if (count === 0) return -1;
    return Math.min(this.highlightedIndex(), count - 1);
  });

  readonly emptyMessage = computed(() => {
    if (this.commandMode()) return 'No matching commands';
    return this.vault.hasVault() ? 'No matching files' : 'No vault open';
  });

  constructor() {
    // Open / re-arm: every new request seq resets the query to the mode's
    // seed ('' or '>') and focuses the input. The restore target is captured
    // only on a closed→open transition, so switching modes while open keeps
    // pointing back at the element that was focused before the palette.
    effect(() => {
      const req = this.request();
      untracked(() => {
        if (!req) {
          this.isOpen = false;
          return;
        }
        if (req.seq === this.handledSeq) return;
        this.handledSeq = req.seq;
        if (!this.isOpen) {
          this.isOpen = true;
          const active = document.activeElement;
          this.restoreFocusTo = active instanceof HTMLElement ? active : null;
        }
        this.query.set(req.mode === 'commands' ? '>' : '');
        this.highlightedIndex.set(0);
        afterNextRender(
          { write: () => this.queryInput()?.nativeElement.focus() },
          { injector: this.injector },
        );
      });
    });
  }

  protected onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
    this.highlightedIndex.set(0);
  }

  protected onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.moveHighlight(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        this.moveHighlight(-1);
        break;
      case 'Enter': {
        event.preventDefault();
        const item = this.items()[this.activeIndex()];
        if (item) this.onSelect(item);
        break;
      }
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        this.close();
        break;
      case 'Tab':
        // The input is the palette's only focusable element; swallowing Tab
        // is the entire focus trap.
        event.preventDefault();
        break;
    }
  }

  protected onHover(index: number): void {
    this.highlightedIndex.set(index);
  }

  /**
   * Part of the focus trap: clicks anywhere on the panel (options, footer,
   * padding) must not blur the input — the palette is keyboard-first and the
   * input is its only focusable element.
   */
  protected onPanelMousedown(evt: MouseEvent): void {
    if (evt.target !== this.queryInput()?.nativeElement) evt.preventDefault();
  }

  protected onSelect(item: PaletteItem): void {
    this.close();
    if (item.kind === 'file') {
      this.vault.setActiveFile(item.id);
      // Keyboard-first: opening a file lands the user in the editor.
      this.ui.requestEditorFocus();
    } else {
      void this.registry.run(item.id);
    }
  }

  protected close(): void {
    this.ui.closePalette();
    const target = this.restoreFocusTo;
    this.restoreFocusTo = null;
    if (target && document.contains(target)) target.focus();
  }

  protected optionId(id: string): string {
    // Ids carry path separators/spaces; sanitize to a valid HTML id token so
    // `aria-activedescendant` reliably resolves (same as composer-autocomplete).
    return `${LISTBOX_ID}-opt-${id.replace(/[^\w-]+/g, '_')}`;
  }

  protected activeDescendantId(): string | null {
    const item = this.items()[this.activeIndex()];
    return item ? this.optionId(item.id) : null;
  }

  private moveHighlight(delta: 1 | -1): void {
    const count = this.items().length;
    if (count === 0) return;
    const next = (this.activeIndex() + delta + count) % count;
    this.highlightedIndex.set(next);
    this.scrollOptionIntoView(next);
  }

  private scrollOptionIntoView(index: number): void {
    const item = this.items()[index];
    if (!item) return;
    // Option elements already exist (only highlight classes change), so the
    // lookup is safe to do synchronously.
    document.getElementById(this.optionId(item.id))?.scrollIntoView({ block: 'nearest' });
  }

  /**
   * File mode: fuzzy-ranked matches (filename first, then relPath); with an
   * empty query, recently-opened files lead and the rest follow alphabetically.
   */
  private fileItems(): PaletteItem[] {
    const files = this.allFiles();
    const q = this.effectiveQuery();

    let ordered: PaletteFile[];
    if (q.length > 0) {
      ordered = rankItems(files, q, (f) => f.name, (f) => f.relPath);
    } else {
      const byKey = new Map(files.map((f) => [normalizePath(f.absPath), f]));
      const recent: PaletteFile[] = [];
      for (const path of this.vault.recentFiles()) {
        const key = normalizePath(path);
        const file = byKey.get(key);
        if (file) {
          recent.push(file);
          byKey.delete(key);
        }
      }
      const rest = [...byKey.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
      ordered = [...recent, ...rest];
    }

    return ordered.slice(0, MAX_RESULTS).map((f) => ({
      kind: 'file' as const,
      id: f.absPath,
      label: f.name,
      detail: f.relPath,
    }));
  }

  /** Command mode: enabled registry commands, fuzzy-ranked on title/category. */
  private commandItems(): PaletteItem[] {
    const commands = this.registry.enabledCommands();
    const q = this.effectiveQuery();
    const ordered =
      q.length > 0
        ? rankItems(commands, q, (c) => c.title, (c) => c.category ?? '')
        : commands;
    return ordered.slice(0, MAX_RESULTS).map((c) => ({
      kind: 'command' as const,
      id: c.id,
      label: c.title,
      detail: c.category,
      hint: c.shortcut,
    }));
  }
}

/** Depth-first flatten of the vault tree into matchable file entries. */
function flattenFiles(nodes: readonly FileNode[], vaultPath: string, out: PaletteFile[]): void {
  for (const node of nodes) {
    if (node.isDirectory) {
      if (node.children) flattenFiles(node.children, vaultPath, out);
    } else {
      // toVaultRel only returns null for paths outside the vault, which tree
      // nodes never are; fall back to the absolute path just in case.
      out.push({
        name: node.name,
        relPath: toVaultRel(vaultPath, node.path) ?? node.path,
        absPath: node.path,
      });
    }
  }
}
