import {
  accumulateToolCallDeltas,
  assembleToolCalls,
  type StreamToolCallDelta,
  type ToolCallAccumEntry,
} from '../../../../../electron/ipc/tool-call-accumulator';

/**
 * Tests the pure tool-call stream accumulator used by the main-process SSE
 * handler. Feeds synthetic indexed deltas (mirroring OpenAI's streaming shape:
 * id + name on the first fragment, arguments split across later fragments) and
 * asserts the assembled, index-sorted tool calls.
 */
describe('tool-call stream accumulator', () => {
  let acc: Map<number, ToolCallAccumEntry>;

  beforeEach(() => {
    acc = new Map<number, ToolCallAccumEntry>();
  });

  function feed(deltas: StreamToolCallDelta[] | undefined): void {
    accumulateToolCallDeltas(acc, deltas);
  }

  it('folds a single call whose name + arguments arrive across fragments', () => {
    feed([{ index: 0, id: 'call_a', function: { name: 'write_file' } }]);
    feed([{ index: 0, function: { arguments: '{"path":"a' } }]);
    feed([{ index: 0, function: { arguments: '.md","content":"hi"}' } }]);

    expect(assembleToolCalls(acc)).toEqual([
      {
        id: 'call_a',
        type: 'function',
        function: { name: 'write_file', arguments: '{"path":"a.md","content":"hi"}' },
      },
    ]);
  });

  it('captures the id only from the fragment that carries it', () => {
    feed([{ index: 0, id: 'call_x', function: { name: 'write_file' } }]);
    feed([{ index: 0, function: { arguments: '{}' } }]);

    expect(assembleToolCalls(acc)?.[0].id).toBe('call_x');
  });

  it('assembles two interleaved calls and sorts them ascending by index', () => {
    // Deltas for index 0 and index 1 arrive interleaved across chunks.
    feed([
      { index: 0, id: 'call_0', function: { name: 'write_file' } },
      { index: 1, id: 'call_1', function: { name: 'write_file' } },
    ]);
    feed([{ index: 1, function: { arguments: '{"path":"b.md"' } }]);
    feed([{ index: 0, function: { arguments: '{"path":"a.md"' } }]);
    feed([{ index: 0, function: { arguments: ',"content":"A"}' } }]);
    feed([{ index: 1, function: { arguments: ',"content":"B"}' } }]);

    expect(assembleToolCalls(acc)).toEqual([
      {
        id: 'call_0',
        type: 'function',
        function: { name: 'write_file', arguments: '{"path":"a.md","content":"A"}' },
      },
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'write_file', arguments: '{"path":"b.md","content":"B"}' },
      },
    ]);
  });

  it('sorts by index even when the higher index appears first', () => {
    feed([{ index: 2, id: 'call_2', function: { name: 'b' } }]);
    feed([{ index: 0, id: 'call_0', function: { name: 'a' } }]);

    const result = assembleToolCalls(acc);
    expect(result?.map((c) => c.id)).toEqual(['call_0', 'call_2']);
  });

  it('ignores deltas with a non-numeric index', () => {
    feed([{ index: undefined as unknown as number, id: 'x', function: { name: 'n' } }]);

    expect(assembleToolCalls(acc)).toBeUndefined();
  });

  it('returns undefined when no tool-call deltas were seen', () => {
    feed(undefined);
    expect(assembleToolCalls(acc)).toBeUndefined();
  });

  it('concatenates name fragments in arrival order', () => {
    feed([{ index: 0, id: 'c', function: { name: 'write_' } }]);
    feed([{ index: 0, function: { name: 'file' } }]);

    expect(assembleToolCalls(acc)?.[0].function.name).toBe('write_file');
  });
});
