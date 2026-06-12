import {
  assembleSystemMessage,
  selectionRangeLabel,
  type PinnedFile,
  type SelectionContext,
} from './system-context';

/**
 * Tests the SELECTION block of the assembled system message: placement
 * (immediately after the matching PINNED FILE block), exact format, the
 * focus instruction, and budget capping — a select-all must never blow the
 * context the way an uncapped pinned file would. Pure unit tests on the
 * prompt assembler; no Angular, no TestBed.
 */
describe('selectionRangeLabel', () => {
  it('labels a single-line selection as `line N`', () => {
    expect(selectionRangeLabel(4, 4)).toBe('line 4');
  });

  it('labels a multi-line selection as `lines X–Y` with an en dash', () => {
    expect(selectionRangeLabel(4, 9)).toBe('lines 4–9');
  });
});

describe('assembleSystemMessage SELECTION block', () => {
  const BUDGET = 100_000;

  function pinned(title: string, content: string): PinnedFile {
    return { title, content };
  }

  function selection(overrides: Partial<SelectionContext> = {}): SelectionContext {
    return {
      relPath: 'docs/prd.md',
      text: 'beta\ngamma',
      startLine: 2,
      endLine: 3,
      ...overrides,
    };
  }

  it('renders the SELECTION block immediately after the matching PINNED FILE block', () => {
    const { systemMessage } = assembleSystemMessage([], {
      maxContextChars: BUDGET,
      pinnedFiles: [pinned('docs/prd.md', 'alpha\nbeta\ngamma\ndelta')],
      selection: selection(),
    });

    expect(systemMessage.content).toContain(
      'PINNED FILE: docs/prd.md\n---\nalpha\nbeta\ngamma\ndelta\n---\n\n' +
        'SELECTION (lines 2–3 of docs/prd.md):\n---\nbeta\ngamma\n---\n',
    );
  });

  it('includes the focus instruction telling the model to use the full file as context', () => {
    const { systemMessage } = assembleSystemMessage([], {
      maxContextChars: BUDGET,
      pinnedFiles: [pinned('docs/prd.md', 'alpha\nbeta')],
      selection: selection({ text: 'beta', startLine: 2, endLine: 2 }),
    });

    expect(systemMessage.content).toContain('Focus your\nresponse on the selection');
    expect(systemMessage.content).toContain('the full PINNED FILE above is provided for');
  });

  it('uses the singular `line N` header for single-line selections', () => {
    const { systemMessage } = assembleSystemMessage([], {
      maxContextChars: BUDGET,
      pinnedFiles: [pinned('docs/prd.md', 'alpha\nbeta')],
      selection: selection({ text: 'beta', startLine: 2, endLine: 2 }),
    });

    expect(systemMessage.content).toContain('SELECTION (line 2 of docs/prd.md):');
  });

  it('renders after the matching file, before any later pinned files', () => {
    const { systemMessage } = assembleSystemMessage([], {
      maxContextChars: BUDGET,
      pinnedFiles: [pinned('a.md', 'aaa'), pinned('b.md', 'bbb')],
      selection: selection({ relPath: 'a.md', text: 'aaa', startLine: 1, endLine: 1 }),
    });

    const content = systemMessage.content ?? '';
    const selIdx = content.indexOf('SELECTION (');
    expect(selIdx).toBeGreaterThan(content.indexOf('PINNED FILE: a.md'));
    expect(selIdx).toBeLessThan(content.indexOf('PINNED FILE: b.md'));
  });

  it('omits the block when the selection references no pinned file', () => {
    const { systemMessage } = assembleSystemMessage([], {
      maxContextChars: BUDGET,
      pinnedFiles: [pinned('docs/prd.md', 'alpha')],
      selection: selection({ relPath: 'docs/unpinned.md' }),
    });

    expect(systemMessage.content).not.toContain('SELECTION (');
  });

  it('omits the block when there are no pinned files at all', () => {
    const { systemMessage } = assembleSystemMessage([], {
      maxContextChars: BUDGET,
      pinnedFiles: [],
      selection: selection(),
    });

    expect(systemMessage.content).not.toContain('SELECTION (');
  });

  it('does not add a citation for the selection (the pinned file already has one)', () => {
    const { citations } = assembleSystemMessage([], {
      maxContextChars: BUDGET,
      pinnedFiles: [pinned('docs/prd.md', 'alpha\nbeta')],
      selection: selection(),
    });

    expect(citations).toEqual([{ relPath: 'docs/prd.md', headingPath: '' }]);
  });

  it('truncates oversized selection text like pinned files (select-all stays budget-capped)', () => {
    const huge = 'x'.repeat(2000);
    const { systemMessage } = assembleSystemMessage([], {
      maxContextChars: 800,
      pinnedFiles: [pinned('docs/prd.md', 'short')],
      selection: selection({ text: huge, startLine: 1, endLine: 1 }),
    });

    const content = systemMessage.content;
    expect(content).toContain('SELECTION (line 1 of docs/prd.md):');
    expect(content).toContain('…(truncated)');
    // The full selection must not survive verbatim.
    expect(content).not.toContain(huge);
  });

  it('drops the block gracefully when the remaining budget cannot fit even its frame', () => {
    // A pinned file sized to consume nearly the whole budget leaves too
    // little room for the SELECTION header + focus note.
    const { systemMessage } = assembleSystemMessage([], {
      maxContextChars: 540,
      pinnedFiles: [pinned('docs/prd.md', 'y'.repeat(600))],
      selection: selection({ text: 'yyy', startLine: 1, endLine: 1 }),
    });

    expect(systemMessage.content).toContain('PINNED FILE: docs/prd.md');
    expect(systemMessage.content).not.toContain('SELECTION (');
  });

  it('reserves a budget slot for the selection so one huge pinned file cannot starve it', () => {
    // With one pinned file and a selection, the per-file cap halves: the file
    // truncates earlier, leaving room for the SELECTION block to render.
    const { systemMessage } = assembleSystemMessage([], {
      maxContextChars: 2400,
      pinnedFiles: [pinned('docs/prd.md', 'z'.repeat(5000))],
      selection: selection({ text: 'zzz', startLine: 1, endLine: 1 }),
    });

    const content = systemMessage.content;
    expect(content).toContain('PINNED FILE: docs/prd.md');
    expect(content).toContain('…(truncated)');
    expect(content).toContain('SELECTION (line 1 of docs/prd.md):\n---\nzzz\n---\n');
  });
});
