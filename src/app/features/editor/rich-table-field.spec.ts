import { buildCellContent, parseMarkdownTable, parseRow } from './rich-table-field';

describe('parseRow', () => {
  it('splits a simple row with leading and trailing pipes', () => {
    const line = '| a | b |';

    const cells = parseRow(line);

    expect(cells.map((c) => c.text)).toEqual(['a', 'b']);
    expect(cells[0].start).toBe(line.indexOf('a'));
    expect(cells[1].start).toBe(line.indexOf('b'));
  });

  it('splits a row without leading and trailing pipes', () => {
    const cells = parseRow('a | b');

    expect(cells.map((c) => c.text)).toEqual(['a', 'b']);
    expect(cells[0].start).toBe(0);
    expect(cells[1].start).toBe(4);
  });

  it('unescapes \\| inside a cell and keeps cell-start offsets correct', () => {
    const line = '| pre \\| post | next |';

    const cells = parseRow(line);

    expect(cells.map((c) => c.text)).toEqual(['pre | post', 'next']);
    // Offsets point at the cell's first character in the RAW line; the cell
    // after the escaped pipe must not be shifted by the unescaping.
    expect(cells[0].start).toBe(line.indexOf('pre'));
    expect(cells[1].start).toBe(line.indexOf('next'));
  });

  it('keeps interior empty cells and drops the empty edge segments', () => {
    const cells = parseRow('| a |  | b |');

    expect(cells.map((c) => c.text)).toEqual(['a', '', 'b']);
  });

  it('trims cell whitespace and records the trimmed content start', () => {
    const line = '|   padded   | x |';

    const cells = parseRow(line);

    expect(cells[0].text).toBe('padded');
    expect(cells[0].start).toBe(line.indexOf('padded'));
    expect(line.slice(cells[0].start, cells[0].start + 6)).toBe('padded');
  });
});

describe('parseMarkdownTable', () => {
  it('parses a valid table with headers, rows and line offsets', () => {
    const source = '| H1 | H2 |\n| --- | --- |\n| a | b |';

    const table = parseMarkdownTable(source);

    expect(table).not.toBeNull();
    expect(table!.headers.map((c) => c.text)).toEqual(['H1', 'H2']);
    expect(table!.alignments).toEqual([null, null]);
    expect(table!.rows.map((row) => row.map((c) => c.text))).toEqual([['a', 'b']]);
    expect(table!.headerOffset).toBe(0);
    expect(table!.rowOffsets).toEqual([source.indexOf('| a | b |')]);
  });

  it('parses the alignment row variants', () => {
    const source = '| A | B | C | D |\n| :-- | --: | :-: | --- |\n| 1 | 2 | 3 | 4 |';

    const table = parseMarkdownTable(source);

    expect(table!.alignments).toEqual(['left', 'right', 'center', null]);
  });

  it('rejects a table without a separator row', () => {
    expect(parseMarkdownTable('| A |\n| b |')).toBeNull();
  });

  it('rejects a table whose separator column count mismatches the header', () => {
    expect(parseMarkdownTable('| A | B |\n| --- | --- | --- |\n| a | b |')).toBeNull();
  });

  it('rejects sources with fewer than two non-blank lines', () => {
    expect(parseMarkdownTable('| A | B |')).toBeNull();
    expect(parseMarkdownTable('')).toBeNull();
  });

  it('pads short rows to the header width with empty cells', () => {
    const table = parseMarkdownTable('| A | B |\n| --- | --- |\n| only |');

    expect(table!.rows[0].map((c) => c.text)).toEqual(['only', '']);
  });

  it('keeps line offsets correct when the source contains a blank line', () => {
    const source = '| H |\n| --- |\n\n| [ ] task |';

    const table = parseMarkdownTable(source);

    expect(table).not.toBeNull();
    expect(table!.rows[0][0].text).toBe('[ ] task');
    // The recorded line offset + cell start must land exactly on the task
    // marker in the original source despite the blank line.
    const markerPos = table!.rowOffsets[0] + table!.rows[0][0].start;
    expect(source.slice(markerPos, markerPos + 3)).toBe('[ ]');
  });

  it('keeps the task-marker offset correct after an escaped pipe earlier in the row', () => {
    const source = '| H1 | H2 |\n| --- | --- |\n| a \\| b | [ ] task |';

    const table = parseMarkdownTable(source);

    expect(table!.rows[0].map((c) => c.text)).toEqual(['a | b', '[ ] task']);
    // The toggle slices the RAW document at rowOffset + cell start, where the
    // earlier cell still contains `\|` — the marker offset must not be
    // shifted by the unescaping.
    const markerPos = table!.rowOffsets[0] + table!.rows[0][1].start;
    expect(source.slice(markerPos, markerPos + 3)).toBe('[ ]');
  });
});

describe('buildCellContent', () => {
  function renderCell(text: string): {
    host: HTMLDivElement;
    checkbox: HTMLInputElement | null;
  } {
    const { fragment, checkbox } = buildCellContent(text);
    const host = document.createElement('div');
    host.appendChild(fragment);
    return { host, checkbox };
  }

  it('renders bold, italic, code and strikethrough as elements', () => {
    const { host } = renderCell('**b** *i* ~~s~~ `c`');

    expect(host.querySelector('strong')?.textContent).toBe('b');
    expect(host.querySelector('em')?.textContent).toBe('i');
    expect(host.querySelector('del')?.textContent).toBe('s');
    expect(host.querySelector('code')?.textContent).toBe('c');
  });

  it('strips script tags via sanitization', () => {
    const { host } = renderCell('<script>window.alert(1)</script>safe');

    expect(host.querySelector('script')).toBeNull();
    expect(host.textContent).toContain('safe');
  });

  it('strips javascript: hrefs via sanitization', () => {
    const { host } = renderCell('[click](javascript:alert(1))');

    const anchor = host.querySelector('a');
    expect(anchor?.textContent).toBe('click');
    expect(anchor?.hasAttribute('href')).toBe(false);
    expect(host.innerHTML).not.toContain('javascript:');
  });

  it('makes regular links open in a new tab', () => {
    const { host } = renderCell('[site](https://example.com)');

    const anchor = host.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://example.com');
    expect(anchor?.getAttribute('target')).toBe('_blank');
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('renders [[Page]] as a visual-only wikilink anchor', () => {
    const { host } = renderCell('see [[Page]] here');

    const anchor = host.querySelector('a.cm-link-widget.cm-wikilink-widget');
    expect(anchor?.textContent).toBe('Page');
    // No href: wikilinks never navigate, and the widget's ignoreEvent only
    // ignores `a[href]` — so clicks on wikilinks fall through to the
    // editor's click-to-edit instead of hitting a dead target.
    expect(anchor?.hasAttribute('href')).toBe(false);
    expect(anchor?.hasAttribute('target')).toBe(false);
    expect(host.textContent).toBe('see Page here');
  });

  it('renders [[Page|Alias]] with the alias as display text', () => {
    const { host } = renderCell('[[Page|Alias]]');

    expect(host.querySelector('a.cm-wikilink-widget')?.textContent).toBe('Alias');
  });

  it('leaves wikilinks inside inline code literal', () => {
    const { host } = renderCell('`[[x]]`');

    expect(host.querySelector('code')?.textContent).toBe('[[x]]');
    expect(host.querySelector('a')).toBeNull();
  });

  it('renders a checked checkbox for a cell starting with [x]', () => {
    const { host, checkbox } = renderCell('[x] done');

    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(true);
    expect(host.querySelector('input.cm-task-checkbox')).toBe(checkbox);
    expect(host.textContent).toContain('done');
    expect(host.textContent).not.toContain('[x]');
  });

  it('renders an unchecked checkbox for a cell starting with [ ]', () => {
    const { checkbox } = renderCell('[ ] todo');

    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(false);
  });

  it('renders a checked checkbox for a cell starting with [X]', () => {
    const { checkbox } = renderCell('[X] DONE');

    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(true);
  });

  it('renders a bare [x] cell as a checkbox with no trailing text', () => {
    const { host, checkbox } = renderCell('[x]');

    expect(checkbox).not.toBeNull();
    expect(host.textContent).toBe('');
  });

  it('still renders markdown after the task marker', () => {
    const { host, checkbox } = renderCell('[x] **done**');

    expect(checkbox).not.toBeNull();
    expect(host.querySelector('strong')?.textContent).toBe('done');
  });

  it('leaves a marker that is not at the cell start literal', () => {
    const { host, checkbox } = renderCell('do [x] later');

    expect(checkbox).toBeNull();
    expect(host.querySelector('input')).toBeNull();
    expect(host.textContent).toBe('do [x] later');
  });

  it('leaves a marker without a following space literal', () => {
    const { checkbox } = renderCell('[x]done');

    expect(checkbox).toBeNull();
  });
});
