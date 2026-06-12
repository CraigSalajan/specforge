import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
} from '@angular/core';
import { EditorSelectionService, resolveActiveSelection } from '../../core/editor-selection.service';
import { VaultService } from '../../core/vault.service';
import { SettingsService } from '../../core/settings.service';
import { ChatService } from './chat.service';
import { absToRel, canonicalRelPath } from './providers/path-utils';
import type { FileNode } from '../../shared/types';
import type { AutocompleteGroup, AutocompleteItem } from './composer-autocomplete.component';

/** A flattened vault entry used to populate the @-mention picker. */
interface PickerEntry {
  relPath: string;
  name: string;
  isDirectory: boolean;
}

/** A synthetic "Whole Vault" sentinel rendered at the top of the picker. */
const WHOLE_VAULT_KEY = ' whole-vault';

/**
 * Over-budget heuristic. We cannot cheaply read file sizes from the renderer
 * without a new IPC round-trip, so we project the verbatim-injected payload
 * (active file when included + each pinned file) using a conservative average.
 * 8 KB/file is a deliberately pessimistic markdown-doc estimate — most specs
 * are smaller, so this errs toward warning early rather than truncating
 * silently. When the projection exceeds `aiMaxContextChars`, we surface the
 * amber "may be truncated" line.
 */
const ASSUMED_CHARS_PER_FILE = 8 * 1024;

@Component({
  selector: 'app-context-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cb-root flex flex-col gap-1">
      <!-- Chip row -->
      <div class="flex flex-wrap items-center gap-1.5">
        @if (activeFileRel(); as rel) {
          <span
            class="cb-chip inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface-2 px-2 py-0.5 text-xs text-text-secondary"
            title="Currently open file, included automatically.">
            <svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 17v5" />
              <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
            </svg>
            <span class="cb-label max-w-[14rem] truncate">{{ rel }}</span>
            <button
              type="button"
              class="cb-x -mr-0.5 rounded-full p-0.5 hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              [attr.aria-label]="'Remove context: ' + rel"
              (click)="removeActiveFile()">
              <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
            </button>
          </span>
        }

        @if (selectionLabel(); as sel) {
          <span
            class="cb-chip inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface-2 px-2 py-0.5 text-xs text-text-secondary"
            title="Selected text in the active file — the AI will focus on it.">
            <svg class="h-3.5 w-3.5 shrink-0 text-accent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 7V5a2 2 0 0 1 2-2h2" />
              <path d="M17 3h2a2 2 0 0 1 2 2v2" />
              <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
              <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
              <path d="M7 8h8" />
              <path d="M7 12h10" />
              <path d="M7 16h6" />
            </svg>
            <span class="cb-label">{{ sel }}</span>
            <button
              type="button"
              class="cb-x -mr-0.5 rounded-full p-0.5 hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label="Remove context: selection"
              (click)="clearSelection()">
              <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
            </button>
          </span>
        }

        @if (scope().wholeVault) {
          <span
            class="cb-chip inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-secondary"
            title="Search the entire vault index.">
            <svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M3 5v14a9 3 0 0 0 18 0V5" />
              <path d="M3 12a9 3 0 0 0 18 0" />
            </svg>
            <span class="cb-label">Whole Vault</span>
            <button
              type="button"
              class="cb-x -mr-0.5 rounded-full p-0.5 hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              aria-label="Remove context: Whole Vault"
              (click)="removeWholeVault()">
              <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
            </button>
          </span>
        }

        @for (folder of scope().folders; track folder) {
          <span class="cb-chip inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-secondary">
            <svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
            </svg>
            <span class="cb-label max-w-[14rem] truncate">{{ folder }}/</span>
            <button
              type="button"
              class="cb-x -mr-0.5 rounded-full p-0.5 hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              [attr.aria-label]="'Remove context: ' + folder + '/'"
              (click)="removeFolder(folder)">
              <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
            </button>
          </span>
        }

        @for (file of scope().files; track file) {
          <span class="cb-chip inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-text-secondary">
            <svg class="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
              <path d="M14 2v4a2 2 0 0 0 2 2h4" />
            </svg>
            <span class="cb-label max-w-[14rem] truncate">{{ file }}</span>
            <button
              type="button"
              class="cb-x -mr-0.5 rounded-full p-0.5 hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              [attr.aria-label]="'Remove context: ' + file"
              (click)="removeFile(file)">
              <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
            </button>
          </span>
        }

        <button
          type="button"
          class="cb-add inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface-2 px-2 py-0.5 text-xs text-text-secondary hover:border-accent hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          title="Add context"
          aria-label="Add context"
          (click)="requestContextPicker.emit()">
          <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14" /><path d="M12 5v14" /></svg>
          @if (isEmpty()) {
            <span>Add context</span>
          }
        </button>
      </div>

      <!-- Over-budget / attachment indicator -->
      @if (attachedFileCount() > 0) {
        <p
          class="cb-status text-xs"
          [class.text-text-muted]="!overBudget()"
          [class.text-amber-400]="overBudget()">
          {{ attachedFileCount() }} {{ attachedFileCount() === 1 ? 'file' : 'files' }} attached@if (overBudget()) {<span> — context may be truncated.</span>}
        </p>
      }
    </div>
  `,
  styles: [
    `
      .cb-chip,
      .cb-add,
      .cb-x,
      .cb-status {
        transition:
          color 120ms ease,
          background-color 120ms ease,
          border-color 120ms ease,
          opacity 120ms ease;
      }
      @media (prefers-reduced-motion: reduce) {
        .cb-chip,
        .cb-add,
        .cb-x,
        .cb-status {
          transition: none;
        }
      }
    `,
  ],
})
export class ContextBarComponent {
  private readonly chat = inject(ChatService);
  private readonly vault = inject(VaultService);
  private readonly settings = inject(SettingsService);
  private readonly editorSelection = inject(EditorSelectionService);

  readonly scope = this.chat.contextScope;

  /**
   * Asks the host (`ai-panel`) to open the shared autocomplete popover in
   * context mode. The host focuses the textarea, inserts `@`, and drives the
   * popover; the chip state itself still lives in `ChatService`.
   */
  readonly requestContextPicker = output<void>();

  /** Vault-relative path of the active file (only when scope opts in). */
  readonly activeFileRel = computed<string | null>(() => {
    const s = this.scope();
    if (!s.includeActiveFile) return null;
    const abs = this.vault.activeFilePath();
    const vaultPath = this.vault.vaultPath();
    if (!abs || !vaultPath) return null;
    return absToRel(vaultPath, abs);
  });

  /**
   * The editor selection that will focus the next turn, validated through the
   * same rules the orchestrator applies (`resolveActiveSelection`), so the
   * chip and the prompt can never disagree.
   */
  private readonly selection = computed(() =>
    resolveActiveSelection(
      this.editorSelection.selection(),
      this.vault.activeFilePath(),
      this.scope().includeActiveFile,
    ),
  );

  /** Chip label, `Selection · L4–L9` (or `Selection · L4` for one line). */
  readonly selectionLabel = computed<string | null>(() => {
    const sel = this.selection();
    if (!sel) return null;
    return sel.startLine === sel.endLine
      ? `Selection · L${sel.startLine}`
      : `Selection · L${sel.startLine}–L${sel.endLine}`;
  });

  readonly isEmpty = computed(() => {
    const s = this.scope();
    return !s.wholeVault && s.folders.length === 0 && s.files.length === 0 && !this.activeFileRel();
  });

  /** Count of verbatim-injected files (active file + pinned files). */
  readonly attachedFileCount = computed(() => {
    const s = this.scope();
    return s.files.length + (this.activeFileRel() ? 1 : 0);
  });

  readonly overBudget = computed(() => {
    const projected = this.attachedFileCount() * ASSUMED_CHARS_PER_FILE;
    return projected > this.settings.aiMaxContextChars();
  });

  /** Flat list of every vault file + folder, with the Whole Vault sentinel. */
  private readonly entries = computed<PickerEntry[]>(() => {
    const vaultPath = this.vault.vaultPath();
    const out: PickerEntry[] = [
      { relPath: WHOLE_VAULT_KEY, name: 'Whole Vault', isDirectory: false },
    ];
    if (!vaultPath) return out;
    flattenTree(this.vault.tree(), vaultPath, out);
    return out;
  });

  // --- Chip removal -------------------------------------------------------

  clearSelection(): void {
    this.editorSelection.clear();
  }

  removeActiveFile(): void {
    void this.chat.setScope({ ...this.scope(), includeActiveFile: false });
  }

  removeWholeVault(): void {
    void this.chat.setScope({ ...this.scope(), wholeVault: false });
  }

  removeFolder(folder: string): void {
    const s = this.scope();
    void this.chat.setScope({ ...s, folders: s.folders.filter((f) => f !== folder) });
  }

  removeFile(file: string): void {
    const s = this.scope();
    void this.chat.setScope({ ...s, files: s.files.filter((f) => f !== file) });
  }

  /** Removes the last chip (token-field Backspace behavior from the composer). */
  removeLastChip(): boolean {
    const s = this.scope();
    // The selection is the most recently added context, so it goes first.
    if (this.selection()) {
      this.clearSelection();
      return true;
    }
    if (s.files.length > 0) {
      void this.chat.setScope({ ...s, files: s.files.slice(0, -1) });
      return true;
    }
    if (s.folders.length > 0) {
      void this.chat.setScope({ ...s, folders: s.folders.slice(0, -1) });
      return true;
    }
    if (s.wholeVault) {
      void this.chat.setScope({ ...s, wholeVault: false });
      return true;
    }
    if (this.activeFileRel()) {
      void this.chat.setScope({ ...s, includeActiveFile: false });
      return true;
    }
    return false;
  }

  // --- Shared-popover API (driven by ai-panel) ----------------------------

  /**
   * Builds the context-mode groups for the shared autocomplete popover:
   * the Whole Vault sentinel + every vault file/folder, substring-filtered by
   * `query`, with `checked` reflecting in-scope membership.
   */
  contextGroups(query: string): AutocompleteGroup[] {
    const q = query.trim().toLowerCase();
    const matched = this.entries().filter((e) => {
      if (!q) return true;
      if (e.relPath === WHOLE_VAULT_KEY) return 'whole vault'.includes(q);
      return e.relPath.toLowerCase().includes(q) || e.name.toLowerCase().includes(q);
    });
    const items: AutocompleteItem[] = matched.map((e) => {
      if (e.relPath === WHOLE_VAULT_KEY) {
        return {
          id: WHOLE_VAULT_KEY,
          label: 'Whole Vault',
          iconType: 'vault',
          checked: this.scope().wholeVault,
        };
      }
      return {
        id: e.relPath,
        label: e.isDirectory ? `${e.relPath}/` : e.relPath,
        iconType: e.isDirectory ? 'folder' : 'file',
        checked: this.isInScope(e),
      };
    });
    return [{ items }];
  }

  /**
   * Adds the selected context item to scope. Mirrors the Pass-2 picker's
   * select behavior: file→files, folder→folders, vault sentinel→toggle.
   */
  applyContextSelection(item: AutocompleteItem): void {
    const s = this.scope();
    if (item.id === WHOLE_VAULT_KEY) {
      void this.chat.setScope({ ...s, wholeVault: !s.wholeVault });
      return;
    }
    const rel = canonicalRelPath(item.id);
    if (!rel) return;
    const isDirectory = item.iconType === 'folder';
    if (isDirectory) {
      if (!s.folders.includes(rel)) {
        void this.chat.setScope({ ...s, folders: [...s.folders, rel] });
      }
    } else {
      if (!s.files.includes(rel)) {
        void this.chat.setScope({ ...s, files: [...s.files, rel] });
      }
    }
  }

  private isInScope(entry: PickerEntry): boolean {
    const s = this.scope();
    if (entry.relPath === WHOLE_VAULT_KEY) return s.wholeVault;
    const rel = canonicalRelPath(entry.relPath);
    if (!rel) return false;
    return entry.isDirectory ? s.folders.includes(rel) : s.files.includes(rel);
  }
}

/** Walks the in-memory vault tree into a flat, breadth-first-ish list. */
function flattenTree(nodes: FileNode[], vaultPath: string, out: PickerEntry[]): void {
  for (const node of nodes) {
    const rel = absToRel(vaultPath, node.path).replace(/\/+$/, '');
    if (rel.length > 0) {
      out.push({ relPath: rel, name: node.name, isDirectory: node.isDirectory });
    }
    if (node.isDirectory && node.children?.length) {
      flattenTree(node.children, vaultPath, out);
    }
  }
}
