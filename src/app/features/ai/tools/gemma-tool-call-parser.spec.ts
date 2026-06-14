import {
  createGemmaContentFilter,
  extractGemmaToolCalls,
  parseGemmaArgs,
} from '../../../../../electron/ipc/gemma-tool-call-parser';

/**
 * Tests the pure Gemma (vLLM) text-format tool-call parser used by the
 * main-process SSE handler. Gemma emits tool calls as raw text inside
 * `delta.content` — `<|tool_call>call:NAME{...}<tool_call|>` — with string arg
 * values wrapped in the `<|"|>` escape token. These tests assert the parsed
 * arguments (by JSON-parsing the returned string), the extracted call shape,
 * and that the streaming filter never leaks markup to the renderer while
 * capturing each completed call.
 */
describe('gemma tool-call parser', () => {
  describe('parseGemmaArgs', () => {
    it('restores the escape token and parses a string + number pair', () => {
      const json = parseGemmaArgs('location:<|"|>Paris<|"|>,days:7');
      expect(JSON.parse(json)).toEqual({ location: 'Paris', days: 7 });
    });

    it('keeps commas and braces that live inside an escaped string value', () => {
      const json = parseGemmaArgs('note:<|"|>a, b {c}<|"|>,n:1');
      expect(JSON.parse(json)).toEqual({ note: 'a, b {c}', n: 1 });
    });

    it('returns {} for an empty (or whitespace-only) argument string', () => {
      expect(parseGemmaArgs('')).toBe('{}');
      expect(parseGemmaArgs('   ')).toBe('{}');
    });

    it('parses a nested object and array happy path', () => {
      // Realistic JSON-shaped body: keys quoted, string values via the escape
      // token. Wrapping in {} yields valid JSON the primary path parses.
      const json = parseGemmaArgs(
        '<|"|>filter<|"|>:{<|"|>tag<|"|>:<|"|>urgent<|"|>},<|"|>ids<|"|>:[1,2,3]',
      );
      expect(JSON.parse(json)).toEqual({ filter: { tag: 'urgent' }, ids: [1, 2, 3] });
    });

    it('falls back to the regex recovery for malformed input', () => {
      // Trailing comma makes the JSON.parse throw, exercising the fallback,
      // which also coerces scalar tokens.
      const json = parseGemmaArgs('name:hello, active:true, count:42, missing:null,');
      expect(JSON.parse(json)).toEqual({
        name: 'hello',
        active: true,
        count: 42,
        missing: null,
      });
    });
  });

  describe('extractGemmaToolCalls', () => {
    it('extracts a single call and strips its markup', () => {
      const text = '<|tool_call>call:get_weather{location:<|"|>Paris<|"|>,days:7}<tool_call|>';
      const { cleanedText, toolCalls } = extractGemmaToolCalls(text);

      expect(cleanedText).toBe('');
      expect(toolCalls.length).toBe(1);
      expect(toolCalls[0].id).toBe('gemma-0');
      expect(toolCalls[0].type).toBe('function');
      expect(toolCalls[0].function.name).toBe('get_weather');
      expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({
        location: 'Paris',
        days: 7,
      });
    });

    it('extracts two concatenated calls with deterministic ids', () => {
      const text =
        '<|tool_call>call:a{x:1}<tool_call|><|tool_call>call:b{y:2}<tool_call|>';
      const { cleanedText, toolCalls } = extractGemmaToolCalls(text);

      expect(cleanedText).toBe('');
      expect(toolCalls.map((c) => c.id)).toEqual(['gemma-0', 'gemma-1']);
      expect(toolCalls.map((c) => c.function.name)).toEqual(['a', 'b']);
      expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ x: 1 });
      expect(JSON.parse(toolCalls[1].function.arguments)).toEqual({ y: 2 });
    });

    it('preserves prose around a call and removes only the markup', () => {
      const text =
        'Sure, let me check.<|tool_call>call:get_weather{city:<|"|>Oslo<|"|>}<tool_call|> Done.';
      const { cleanedText, toolCalls } = extractGemmaToolCalls(text);

      expect(cleanedText).toBe('Sure, let me check. Done.');
      expect(toolCalls.length).toBe(1);
      expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ city: 'Oslo' });
    });

    it('accepts the <turn|> terminator', () => {
      const text = '<|tool_call>call:ping{}<turn|>';
      const { cleanedText, toolCalls } = extractGemmaToolCalls(text);

      expect(cleanedText).toBe('');
      expect(toolCalls.length).toBe(1);
      expect(toolCalls[0].function.name).toBe('ping');
      expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({});
    });

    it('returns the text unchanged when there is no markup', () => {
      const text = 'Just a normal assistant reply with no tools.';
      expect(extractGemmaToolCalls(text)).toEqual({ cleanedText: text, toolCalls: [] });
    });
  });

  describe('createGemmaContentFilter', () => {
    it('captures a call whose start marker is split across two pushes', () => {
      const filter = createGemmaContentFilter();
      let out = '';
      out += filter.push('<|tool_').emit;
      out += filter.push('call>call:foo{a:1}<tool_call|>').emit;
      const { emit, toolCalls } = filter.flush();
      out += emit;

      expect(out).toBe('');
      expect(out).not.toContain('<|tool_call>');
      expect(out).not.toContain('<tool_call|>');
      expect(toolCalls.length).toBe(1);
      expect(toolCalls[0].id).toBe('gemma-0');
      expect(toolCalls[0].function.name).toBe('foo');
      expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ a: 1 });
    });

    it('emits surrounding text and captures a call from a single push', () => {
      const filter = createGemmaContentFilter();
      const { emit } = filter.push('before <|tool_call>call:foo{a:1}<tool_call|> after');
      const { emit: tail, toolCalls } = filter.flush();
      const out = emit + tail;

      expect(out).toBe('before  after');
      expect(out).not.toContain('<|tool_call>');
      expect(toolCalls.length).toBe(1);
      expect(toolCalls[0].function.name).toBe('foo');
    });

    it('emits a held partial start on flush when it is just plain text', () => {
      const filter = createGemmaContentFilter();
      // `<|too` is a prefix of the start marker, so it is held back from emit.
      const { emit } = filter.push('abc<|too');
      const { emit: tail, toolCalls } = filter.flush();
      const out = emit + tail;

      expect(out).toBe('abc<|too');
      expect(toolCalls.length).toBe(0);
    });

    it('drops an unterminated tool call on flush without leaking markup', () => {
      const filter = createGemmaContentFilter();
      const { emit } = filter.push('text <|tool_call>call:foo{');
      const { emit: tail, toolCalls } = filter.flush();
      const out = emit + tail;

      expect(out).toBe('text ');
      expect(out).not.toContain('<|tool_call>');
      expect(toolCalls.length).toBe(0);
    });

    it('captures multiple calls arriving across several pushes with unique ids', () => {
      const filter = createGemmaContentFilter();
      let out = '';
      out += filter.push('one<|tool_call>call:a{x:').emit;
      out += filter.push('1}<tool_call|>two<|tool_').emit;
      out += filter.push('call>call:b{y:2}<tool_call|>three').emit;
      const { emit, toolCalls } = filter.flush();
      out += emit;

      expect(out).toBe('onetwothree');
      expect(out).not.toContain('<|tool_call>');
      expect(out).not.toContain('<tool_call|>');
      expect(toolCalls.map((c) => c.id)).toEqual(['gemma-0', 'gemma-1']);
      expect(toolCalls.map((c) => c.function.name)).toEqual(['a', 'b']);
      expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ x: 1 });
      expect(JSON.parse(toolCalls[1].function.arguments)).toEqual({ y: 2 });
    });
  });
});
