import { Injectable, signal } from '@angular/core';
import { samePath } from '../shared/path-utils';

/**
 * Snapshot of the editor's current non-empty selection, published by the
 * single EditorComponent instance. Ephemeral, signal-only state: it is
 * deliberately NOT part of `ContextScope` (which is persisted per chat
 * session) — a selection lives and dies with the open editor view.
 */
export interface EditorSelectionSnapshot {
  /** Absolute path of the file the selection belongs to. */
  filePath: string;
  /** The selected text, verbatim. */
  text: string;
  /** Document character offset where the selection starts. */
  from: number;
  /** Document character offset where the selection ends. */
  to: number;
  /** 1-based first selected line. */
  startLine: number;
  /** 1-based last selected line (inclusive). */
  endLine: number;
}

/**
 * Single source of truth a selection must pass before it may focus an AI
 * turn: the scope opts the active file in, the snapshot belongs to that file,
 * and the selected text is not just whitespace. Shared by the orchestrator
 * (prompt assembly) and the chat UI (Selection chip) so they never disagree.
 */
export function resolveActiveSelection(
  snapshot: EditorSelectionSnapshot | null,
  activeFilePath: string | null,
  includeActiveFile: boolean,
): EditorSelectionSnapshot | null {
  if (!snapshot || !includeActiveFile || !activeFilePath) return null;
  if (!samePath(snapshot.filePath, activeFilePath)) return null;
  if (snapshot.text.trim().length === 0) return null;
  return snapshot;
}

/**
 * Cross-feature seam between the editor and the AI harness: the editor
 * publishes its selection here; the chat UI and orchestrator read it.
 */
@Injectable({ providedIn: 'root' })
export class EditorSelectionService {
  private readonly _selection = signal<EditorSelectionSnapshot | null>(null);
  readonly selection = this._selection.asReadonly();

  set(snapshot: EditorSelectionSnapshot): void {
    this._selection.set(snapshot);
  }

  clear(): void {
    this._selection.set(null);
  }
}
