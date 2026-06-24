import { vi } from 'vitest';
import type {
  ChatChunk,
  ChatMessage,
  ChatOptions,
  TokenUsage,
  ToolCall,
  ToolDef,
} from './providers/chat.provider';
import { runAgenticLoop, type AgenticLoopDeps } from './agentic-loop';

/**
 * One scripted model round: streamed text deltas plus an optional set of tool
 * calls emitted on the round's final `done` chunk. Optional `reasoning` deltas
 * are interleaved on their own sibling channel.
 */
interface ScriptedRound {
  deltas: string[];
  reasoning?: string[];
  toolCalls?: ToolCall[];
  /** Token usage emitted on this round's final `done` chunk, when present. */
  usage?: TokenUsage;
}

/**
 * Builds a fake `chat` that yields ChatChunks for each scripted round in turn
 * and records every `messages`/`opts` pair it was invoked with. The orchestrator
 * mutates `convo` in place between rounds, so the messages are snapshotted at
 * call time for ordering assertions.
 */
function scriptedChat(rounds: ScriptedRound[]): {
  chat: AgenticLoopDeps['chat'];
  calls: Array<{ messages: ChatMessage[]; opts: ChatOptions }>;
} {
  const calls: Array<{ messages: ChatMessage[]; opts: ChatOptions }> = [];
  const chat: AgenticLoopDeps['chat'] = (messages, opts) => {
    const index = calls.length;
    calls.push({ messages: messages.map((m) => ({ ...m })), opts });
    const round = rounds[index] ?? { deltas: [] };
    return (async function* (): AsyncIterable<ChatChunk> {
      // Reasoning streams first on its own channel (mirroring a model that
      // thinks before it answers), then the answer deltas.
      for (const reasoning of round.reasoning ?? []) {
        yield { delta: '', done: false, reasoning };
      }
      for (const delta of round.deltas) {
        yield { delta, done: false };
      }
      yield { delta: '', done: true, toolCalls: round.toolCalls, usage: round.usage };
    })();
  };
  return { chat, calls };
}

/** A tool-role message echoing the call it answers, for ordering assertions. */
function toolReply(call: ToolCall): ChatMessage {
  return {
    role: 'tool',
    tool_call_id: call.id,
    name: call.function.name,
    content: `result for ${call.id}`,
  };
}

function toolCall(id: string, name = 'write_file'): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: '{}' },
  };
}

const NO_SCHEMAS: ToolDef[] = [];

describe('runAgenticLoop', () => {
  it('returns the streamed text in a single round and appends the final assistant message when no tools are called', async () => {
    const { chat, calls } = scriptedChat([{ deltas: ['Hello, ', 'world.'] }]);
    const executeToolCall = vi.fn(async (c: ToolCall): Promise<ChatMessage> => toolReply(c));
    const convo: ChatMessage[] = [{ role: 'user', content: 'hi' }];

    const result = await runAgenticLoop(convo, {
      chat,
      toolSchemas: NO_SCHEMAS,
      executeToolCall,
    });

    expect(result.finalText).toBe('Hello, world.');
    expect(result.toolCalls).toEqual([]);
    expect(result.rounds).toBe(1);
    expect(result.exhaustedToolRounds).toBe(false);

    // The final text-only assistant turn is appended so `convo` is a complete
    // log: the original user message is untouched and exactly one assistant
    // message (the concatenated streamed deltas, no tool_calls) follows it.
    expect(convo).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello, world.' },
    ]);
    expect(calls.length).toBe(1);
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  it('executes one tool round then returns the final reply, preserving assistant→tool ordering', async () => {
    const call = toolCall('call_1');
    const { chat, calls } = scriptedChat([
      { deltas: ['Working on it. '], toolCalls: [call] },
      { deltas: ['All set.'] },
    ]);
    const executed: ToolCall[] = [];
    const executeToolCall = vi.fn(async (c: ToolCall): Promise<ChatMessage> => {
      executed.push(c);
      return toolReply(c);
    });
    const convo: ChatMessage[] = [{ role: 'user', content: 'create a file' }];

    const result = await runAgenticLoop(convo, {
      chat,
      toolSchemas: NO_SCHEMAS,
      executeToolCall,
    });

    // The tool was executed once with the model's call.
    expect(executeToolCall).toHaveBeenCalledTimes(1);
    expect(executed[0].id).toBe('call_1');

    // convo gained the assistant(tool_calls) message, then exactly one matching
    // tool message, then the final text-only assistant reply — in that order,
    // after the original user message.
    expect(convo.length).toBe(4);
    const asst = convo[1];
    expect(asst.role).toBe('assistant');
    expect(asst.content).toBe('Working on it. ');
    expect(asst.tool_calls).toEqual([call]);
    const toolMsg = convo[2];
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.tool_call_id).toBe('call_1');
    const finalAsst = convo[3];
    expect(finalAsst.role).toBe('assistant');
    expect(finalAsst.content).toBe('All set.');
    expect(finalAsst.tool_calls).toBeUndefined();

    // The second model call saw the assistant message immediately followed by
    // its single tool reply.
    const second = calls[1].messages;
    const asstIdx = second.findIndex(
      (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
    );
    expect(asstIdx).toBeGreaterThan(-1);
    expect(second[asstIdx + 1].role).toBe('tool');
    expect(second.filter((m) => m.role === 'tool').length).toBe(1);

    // finalText is the concatenation of round 1 + round 2 text.
    expect(result.finalText).toBe('Working on it. All set.');
    expect(result.toolCalls).toEqual([call]);
    expect(result.rounds).toBe(2);
    expect(result.exhaustedToolRounds).toBe(false);
  });

  it('stops at the round cap and reports exhaustion when every round requests a tool', async () => {
    const { chat, calls } = scriptedChat([
      { deltas: [], toolCalls: [toolCall('a')] },
      { deltas: [], toolCalls: [toolCall('b')] },
      { deltas: [], toolCalls: [toolCall('c')] },
    ]);
    const executeToolCall = vi.fn(async (c: ToolCall): Promise<ChatMessage> => toolReply(c));
    const convo: ChatMessage[] = [{ role: 'user', content: 'go' }];

    const result = await runAgenticLoop(convo, {
      chat,
      toolSchemas: NO_SCHEMAS,
      executeToolCall,
      maxRounds: 2,
    });

    expect(result.rounds).toBe(2);
    expect(result.exhaustedToolRounds).toBe(true);
    expect(executeToolCall).toHaveBeenCalledTimes(2);
    expect(calls.length).toBe(2);
  });

  it('synthesizes a stable id for a tool call missing one and shares it with the assistant message', async () => {
    const call = toolCall('', 'write_file');
    const { chat } = scriptedChat([
      { deltas: [], toolCalls: [call] },
      { deltas: ['done'] },
    ]);
    let seenId: string | undefined;
    const executeToolCall = vi.fn(async (c: ToolCall): Promise<ChatMessage> => {
      seenId = c.id;
      return toolReply(c);
    });
    const convo: ChatMessage[] = [{ role: 'user', content: 'go' }];

    await runAgenticLoop(convo, {
      chat,
      toolSchemas: NO_SCHEMAS,
      executeToolCall,
    });

    // executeToolCall saw the synthesized id (round 0, index 0).
    expect(seenId).toBe('call_0_0');

    // The pushed assistant message's tool_call references the same synthesized
    // id (mutated in place), and the tool reply answers it.
    const asst = convo[1];
    expect(asst.tool_calls?.[0].id).toBe('call_0_0');
    expect(convo[2].tool_call_id).toBe('call_0_0');
  });

  it('invokes onText with the cumulative text as deltas stream', async () => {
    const call = toolCall('call_1');
    const { chat } = scriptedChat([
      { deltas: ['Round ', 'one. '], toolCalls: [call] },
      { deltas: ['Round ', 'two.'] },
    ]);
    const executeToolCall = vi.fn(async (c: ToolCall): Promise<ChatMessage> => toolReply(c));
    const seen: string[] = [];
    const convo: ChatMessage[] = [{ role: 'user', content: 'go' }];

    const result = await runAgenticLoop(convo, {
      chat,
      toolSchemas: NO_SCHEMAS,
      executeToolCall,
      onText: (text) => seen.push(text),
    });

    // Each delta reports the running total across all rounds.
    expect(seen).toEqual([
      'Round ',
      'Round one. ',
      'Round one. Round ',
      'Round one. Round two.',
    ]);
    // The final onText value matches the returned finalText.
    expect(seen[seen.length - 1]).toBe(result.finalText);
  });

  it('accumulates reasoning across rounds and reports cumulative onReasoning', async () => {
    const call = toolCall('call_1');
    const { chat } = scriptedChat([
      { reasoning: ['Think ', 'one. '], deltas: ['Answer one. '], toolCalls: [call] },
      { reasoning: ['Think ', 'two.'], deltas: ['Answer two.'] },
    ]);
    const executeToolCall = vi.fn(async (c: ToolCall): Promise<ChatMessage> => toolReply(c));
    const seenReasoning: string[] = [];
    const convo: ChatMessage[] = [{ role: 'user', content: 'go' }];

    const result = await runAgenticLoop(convo, {
      chat,
      toolSchemas: NO_SCHEMAS,
      executeToolCall,
      onReasoning: (text) => seenReasoning.push(text),
    });

    // Each reasoning delta reports the running total across all rounds.
    expect(seenReasoning).toEqual([
      'Think ',
      'Think one. ',
      'Think one. Think ',
      'Think one. Think two.',
    ]);
    // The final onReasoning value matches the returned finalReasoning.
    expect(seenReasoning[seenReasoning.length - 1]).toBe(result.finalReasoning);
    expect(result.finalReasoning).toBe('Think one. Think two.');
    // The answer text is unaffected by the sibling reasoning channel.
    expect(result.finalText).toBe('Answer one. Answer two.');
    // Reasoning is never replayed into convo's assistant messages.
    for (const m of convo) {
      expect(m).not.toHaveProperty('reasoning');
    }
  });

  it('reports no reasoning and never calls onReasoning when none is streamed', async () => {
    const { chat } = scriptedChat([{ deltas: ['Hello.'] }]);
    const executeToolCall = vi.fn(async (c: ToolCall): Promise<ChatMessage> => toolReply(c));
    const onReasoning = vi.fn();
    const convo: ChatMessage[] = [{ role: 'user', content: 'hi' }];

    const result = await runAgenticLoop(convo, {
      chat,
      toolSchemas: NO_SCHEMAS,
      executeToolCall,
      onReasoning,
    });

    expect(result.finalReasoning).toBe('');
    expect(onReasoning).not.toHaveBeenCalled();
  });

  it('splits inline closing-tag-only reasoning out of streamed content (the real-model format)', async () => {
    // The model emits reasoning then a CLOSING `</think>` with NO opening tag
    // (the chat template injected the opener into the prompt). The single
    // `splitThinkTags` peels the pre-`</think>` text off into reasoning.
    const { chat } = scriptedChat([{ deltas: ['Thinking hard', '</think>', 'Final answer'] }]);
    const executeToolCall = vi.fn(async (c: ToolCall): Promise<ChatMessage> => toolReply(c));
    const convo: ChatMessage[] = [{ role: 'user', content: 'hi' }];

    const result = await runAgenticLoop(convo, {
      chat,
      toolSchemas: NO_SCHEMAS,
      executeToolCall,
    });

    // finalText is CLEAN (the `</think>` and the reasoning are gone).
    expect(result.finalText).toBe('Final answer');
    expect(result.finalReasoning).toContain('Thinking hard');
    // The pushed convo assistant message carries the clean answer, not the tag.
    expect(convo).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Final answer' },
    ]);
    expect(convo[1].content).not.toContain('</think>');
  });

  it('splits an explicit <think>…</think> block delivered in a single delta', async () => {
    const { chat } = scriptedChat([{ deltas: ['<think>reasoning</think>answer'] }]);
    const executeToolCall = vi.fn(async (c: ToolCall): Promise<ChatMessage> => toolReply(c));
    const convo: ChatMessage[] = [{ role: 'user', content: 'hi' }];

    const result = await runAgenticLoop(convo, {
      chat,
      toolSchemas: NO_SCHEMAS,
      executeToolCall,
    });

    expect(result.finalText).toBe('answer');
    expect(result.finalReasoning).toBe('reasoning');
    expect(convo[1]).toEqual({ role: 'assistant', content: 'answer' });
  });

  it('leaves a native-reasoning round (no inline tags) producing the prior finalReasoning value', async () => {
    // Regression guard: a round whose reasoning arrives only on the native
    // sibling channel must yield the same cumulative reasoning as before.
    const { chat } = scriptedChat([
      { reasoning: ['Think ', 'one. '], deltas: ['Answer one.'] },
    ]);
    const executeToolCall = vi.fn(async (c: ToolCall): Promise<ChatMessage> => toolReply(c));
    const convo: ChatMessage[] = [{ role: 'user', content: 'hi' }];

    const result = await runAgenticLoop(convo, {
      chat,
      toolSchemas: NO_SCHEMAS,
      executeToolCall,
    });

    expect(result.finalReasoning).toBe('Think one. ');
    expect(result.finalText).toBe('Answer one.');
  });

  it('sums token usage across rounds and returns the cross-round total', async () => {
    const call = toolCall('call_1');
    const { chat } = scriptedChat([
      { deltas: ['Working. '], toolCalls: [call], usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 } },
      { deltas: ['Done.'], usage: { promptTokens: 150, completionTokens: 20, totalTokens: 170 } },
    ]);
    const executeToolCall = vi.fn(async (c: ToolCall): Promise<ChatMessage> => toolReply(c));
    const convo: ChatMessage[] = [{ role: 'user', content: 'go' }];

    const result = await runAgenticLoop(convo, { chat, toolSchemas: NO_SCHEMAS, executeToolCall });

    expect(result.usage).toEqual({ promptTokens: 250, completionTokens: 30, totalTokens: 280 });
  });

  it('leaves usage undefined when no round reports token usage', async () => {
    const { chat } = scriptedChat([{ deltas: ['Hi.'] }]);
    const executeToolCall = vi.fn(async (c: ToolCall): Promise<ChatMessage> => toolReply(c));
    const convo: ChatMessage[] = [{ role: 'user', content: 'hi' }];

    const result = await runAgenticLoop(convo, { chat, toolSchemas: NO_SCHEMAS, executeToolCall });

    expect(result.usage).toBeUndefined();
  });
});
