/**
 * Pure helpers for parsing Gemma (vLLM) text-format tool calls out of an
 * assistant's `content`. Deliberately free of any Electron / Node imports so it
 * can be unit-tested under the renderer's (browser) test runner as well as
 * bundled into the main process.
 *
 * Some OpenAI-compatible endpoints (Gemma via vLLM with no server-side tool
 * parsing) emit tool calls as RAW TEXT inside `delta.content` rather than as
 * structured `tool_calls`, e.g.:
 *
 *   <|tool_call>call:get_weather{location:<|"|>Paris<|"|>,days:7}<tool_call|>
 *
 * The wire format mirrors vLLM's gemma4_tool_parser.py / gemma4_utils.py:
 *   - start marker `<|tool_call>`, terminator `<tool_call|>` (alt: `<turn|>`)
 *   - function-name prefix `call:` (name chars `[\w\-.]+`)
 *   - string values wrapped in the escape token `<|"|>` (stands in for `"`)
 *
 * These helpers fold that text into the SAME `AccumulatedToolCall` shape the
 * structured streaming path produces, so everything downstream of IPC stays
 * format-agnostic.
 */

import type { AccumulatedToolCall } from './tool-call-accumulator';

/** The escape token vLLM substitutes for a literal `"` inside arg values. */
const QUOTE_ESCAPE = '<|"|>';
/** Marks the beginning of a tool call in the model's text output. */
const START = '<|tool_call>';
/** Terminators that close a tool-call block; either may follow the args. */
const TERMINATORS = ['<tool_call|>', '<turn|>'] as const;

/**
 * Coerces a regex-fallback scalar token into its JSON value: booleans, null and
 * numbers are recognized, everything else stays a string.
 */
function coerceScalar(raw: string): string | number | boolean | null {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/**
 * Parses the raw text between a tool call's braces into a JSON STRING suitable
 * for `call.function.arguments` (downstream tools do
 * `JSON.parse(call.function.arguments)`). The escape token is first restored to
 * a real `"`, then the body is wrapped in `{}` and JSON-parsed. On failure a
 * lenient regex fallback recovers `key:value` pairs.
 */
export function parseGemmaArgs(argStr: string): string {
  const trimmed = argStr.trim();
  if (trimmed.length === 0) return '{}';

  const cleaned = trimmed.split(QUOTE_ESCAPE).join('"');

  try {
    return JSON.stringify(JSON.parse('{' + cleaned + '}'));
  } catch {
    const obj: Record<string, string | number | boolean | null> = {};
    const re = /(\w+)\s*:\s*(?:"([^"]*)"|([^,}]+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(cleaned)) !== null) {
      const key = m[1];
      obj[key] = m[2] !== undefined ? m[2] : coerceScalar(m[3]);
    }
    return JSON.stringify(obj);
  }
}

/**
 * Whole-string (non-streaming) parse: extracts every Gemma tool-call block from
 * `text`, returning the assembled calls and the `cleanedText` with all markup
 * removed. Ids are deterministic (`gemma-0`, `gemma-1`, …) for stable tests.
 */
export function extractGemmaToolCalls(text: string): {
  cleanedText: string;
  toolCalls: AccumulatedToolCall[];
} {
  const re = /<\|tool_call>call:([\w\-.]+)\{([\s\S]*?)\}(?:<tool_call\|>|<turn\|>)/g;
  const toolCalls: AccumulatedToolCall[] = [];
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    toolCalls.push({
      id: 'gemma-' + i,
      type: 'function',
      function: { name: m[1], arguments: parseGemmaArgs(m[2]) },
    });
    i++;
  }

  if (toolCalls.length === 0) return { cleanedText: text, toolCalls: [] };

  const cleanedText = text.replace(re, '');
  return { cleanedText, toolCalls };
}

/**
 * The streaming content filter. Tool-call markup can arrive split across SSE
 * chunks, so this stateful filter buffers just enough to (a) never emit partial
 * markup to the renderer and (b) capture each completed call. Blocks are
 * delimited by the terminator token — NOT brace-matching — because arg values
 * can contain `}` inside escaped strings.
 *
 * Ids are numbered via a shared `seq` so they stay unique across `push` and the
 * final `flush` within one filter instance.
 */
export function createGemmaContentFilter(): {
  push(delta: string): { emit: string };
  flush(): { emit: string; toolCalls: AccumulatedToolCall[] };
} {
  let buffer = '';
  const toolCalls: AccumulatedToolCall[] = [];
  let seq = 0;

  /**
   * Length of the longest suffix of `buffer` that is a non-empty prefix of
   * `START` — i.e. how many trailing chars might be the beginning of a tool
   * call still in flight and must be held back from `emit`.
   */
  function partialStartHold(): number {
    const max = Math.min(buffer.length, START.length - 1);
    for (let k = max; k > 0; k--) {
      if (buffer.endsWith(START.slice(0, k))) return k;
    }
    return 0;
  }

  /** Locates the earliest terminator in `rest` at/after `START.length`. */
  function findTerminator(rest: string): { index: number; length: number } | null {
    let best: { index: number; length: number } | null = null;
    for (const term of TERMINATORS) {
      const idx = rest.indexOf(term, START.length);
      if (idx === -1) continue;
      if (best === null || idx < best.index) {
        best = { index: idx, length: term.length };
      }
    }
    return best;
  }

  return {
    push(delta: string): { emit: string } {
      buffer += delta;
      let emit = '';

      for (;;) {
        const i = buffer.indexOf(START);
        if (i === -1) {
          const hold = partialStartHold();
          emit += buffer.slice(0, buffer.length - hold);
          buffer = buffer.slice(buffer.length - hold);
          break;
        }

        emit += buffer.slice(0, i);
        const rest = buffer.slice(i);
        const term = findTerminator(rest);
        if (term === null) {
          // Incomplete tool call — keep the unterminated remainder buffered.
          buffer = rest;
          break;
        }

        const block = rest.slice(0, term.index + term.length);
        const inner = block.slice(START.length, block.length - term.length);
        const parsed = /^call:([\w\-.]+)\{([\s\S]*)\}$/.exec(inner);
        if (parsed) {
          toolCalls.push({
            id: 'gemma-' + seq++,
            type: 'function',
            function: { name: parsed[1], arguments: parseGemmaArgs(parsed[2]) },
          });
        } else {
          // Not a recognizable call after all — pass it through as plain text.
          emit += block;
        }
        buffer = rest.slice(term.index + term.length);
      }

      return { emit };
    },

    flush(): { emit: string; toolCalls: AccumulatedToolCall[] } {
      // An unterminated tool call left in the buffer is dropped so no markup
      // leaks; any other trailing text is emitted as-is.
      const emit = buffer.startsWith(START) ? '' : buffer;
      buffer = '';
      return { emit, toolCalls };
    },
  };
}
