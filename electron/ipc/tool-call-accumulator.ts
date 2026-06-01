/**
 * Pure helpers for folding streamed OpenAI `tool_calls` deltas into complete
 * tool calls. Deliberately free of any Electron / Node imports so it can be
 * unit-tested under the renderer's (browser) test runner as well as bundled
 * into the main process.
 *
 * OpenAI emits the `id`/`function.name` once and then streams
 * `function.arguments` in pieces, all keyed by the same `index`.
 */

export interface StreamToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface AccumulatedToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolCallAccumEntry {
  id: string;
  name: string;
  args: string;
}

/**
 * Folds one SSE chunk's `tool_calls` deltas into the per-index accumulator.
 *
 * Deltas with a non-numeric `index` are ignored. The `id` of an index is kept
 * once set (the model emits it in the first fragment); `name` and `arguments`
 * fragments are concatenated in arrival order.
 */
export function accumulateToolCallDeltas(
  accumulator: Map<number, ToolCallAccumEntry>,
  deltas: StreamToolCallDelta[] | undefined,
): void {
  if (!deltas) return;
  for (const td of deltas) {
    if (typeof td.index !== 'number') continue;
    const entry = accumulator.get(td.index) ?? { id: '', name: '', args: '' };
    if (td.id) entry.id = td.id;
    if (td.function?.name) entry.name += td.function.name;
    if (td.function?.arguments) entry.args += td.function.arguments;
    accumulator.set(td.index, entry);
  }
}

/**
 * Assembles the per-index accumulator into the final `toolCalls` array sorted
 * ascending by index, or `undefined` when no tool calls were streamed.
 */
export function assembleToolCalls(
  accumulator: Map<number, ToolCallAccumEntry>,
): AccumulatedToolCall[] | undefined {
  if (accumulator.size === 0) return undefined;
  return [...accumulator.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({
      id: v.id,
      type: 'function' as const,
      function: { name: v.name, arguments: v.args },
    }));
}
