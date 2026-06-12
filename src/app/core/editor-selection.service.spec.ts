import {
  EditorSelectionService,
  resolveActiveSelection,
  type EditorSelectionSnapshot,
} from './editor-selection.service';

/**
 * Tests the ephemeral editor-selection seam: the shared
 * `resolveActiveSelection` validation (used by the orchestrator, the
 * Selection chip, and the panel caption — they must never disagree) and the
 * signal-backed service itself. Pure unit tests, no TestBed and no CodeMirror.
 */
describe('resolveActiveSelection', () => {
  const ACTIVE_PATH = 'C:/vault/docs/prd.md';

  function snapshot(overrides: Partial<EditorSelectionSnapshot> = {}): EditorSelectionSnapshot {
    return {
      filePath: ACTIVE_PATH,
      text: 'selected text',
      from: 10,
      to: 23,
      startLine: 2,
      endLine: 3,
      ...overrides,
    };
  }

  it('returns the snapshot when the scope includes the active file, paths match, and text is non-whitespace', () => {
    const snap = snapshot();
    expect(resolveActiveSelection(snap, ACTIVE_PATH, true)).toBe(snap);
  });

  it('returns null when there is no snapshot', () => {
    expect(resolveActiveSelection(null, ACTIVE_PATH, true)).toBeNull();
  });

  it('returns null when the scope excludes the active file', () => {
    expect(resolveActiveSelection(snapshot(), ACTIVE_PATH, false)).toBeNull();
  });

  it('returns null when no file is active', () => {
    expect(resolveActiveSelection(snapshot(), null, true)).toBeNull();
  });

  it('returns null when the selection belongs to a different file', () => {
    const stale = snapshot({ filePath: 'C:/vault/docs/other.md' });
    expect(resolveActiveSelection(stale, ACTIVE_PATH, true)).toBeNull();
  });

  it('matches paths case-insensitively and across separator styles (Windows)', () => {
    const snap = snapshot({ filePath: 'C:\\Vault\\Docs\\PRD.md' });
    expect(resolveActiveSelection(snap, 'c:/vault/docs/prd.md', true)).toBe(snap);
  });

  it('returns null for whitespace-only selections', () => {
    const blank = snapshot({ text: '  \n\t  ' });
    expect(resolveActiveSelection(blank, ACTIVE_PATH, true)).toBeNull();
  });
});

describe('EditorSelectionService', () => {
  it('starts with no selection', () => {
    const service = new EditorSelectionService();
    expect(service.selection()).toBeNull();
  });

  it('publishes the latest snapshot via set()', () => {
    const service = new EditorSelectionService();
    const snap: EditorSelectionSnapshot = {
      filePath: 'C:/vault/a.md',
      text: 'alpha',
      from: 0,
      to: 5,
      startLine: 1,
      endLine: 1,
    };
    service.set(snap);
    expect(service.selection()).toEqual(snap);

    const next = { ...snap, text: 'alpha beta', to: 10 };
    service.set(next);
    expect(service.selection()).toEqual(next);
  });

  it('clears the selection via clear()', () => {
    const service = new EditorSelectionService();
    service.set({
      filePath: 'C:/vault/a.md',
      text: 'alpha',
      from: 0,
      to: 5,
      startLine: 1,
      endLine: 1,
    });
    service.clear();
    expect(service.selection()).toBeNull();
  });
});
