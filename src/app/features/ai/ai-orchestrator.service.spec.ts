import { vi, type MockInstance } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { EMPTY_CONTEXT_SCOPE, type AiErrorInfo } from '../../shared/types';
import { IpcService } from '../../core/ipc.service';
import { SettingsService } from '../../core/settings.service';
import { VaultService } from '../../core/vault.service';
import { EditorBufferService } from '../../core/editor-buffer.service';
import { EditorSelectionService } from '../../core/editor-selection.service';
import { AiProviderService } from './providers/ai-provider.service';
import { RetrievalService } from './providers/retrieval.service';
import { ChatService, type UiChatMessage } from './chat.service';
import { FileChangeService } from './file-change.service';
import { ToolRegistryService } from './tools/tool-registry.service';
import { SkillRegistryService } from './skills/skill-registry.service';
import { SyncService } from '../../core/sync.service';
import { UiStateService } from '../../core/ui-state.service';
import type {
  ChatChunk,
  ChatMessage,
  ChatOptions,
  ChatProvider,
} from './providers/chat.provider';
import { AiHarnessError } from './providers/ai-harness-error';
import { AiOrchestratorService, type ProposalOutcome } from './ai-orchestrator.service';
import type { CanonicalItem } from '../../../../electron/sync/canonical-item';

/**
 * One scripted model round: either a plain chunk sequence, or a sequence that
 * throws after its chunks (simulating a provider failure / abort mid-stream).
 */
type ScriptedRound = ChatChunk[] | { chunks: ChatChunk[]; thenThrow: unknown };

/**
 * A scripted chat provider: each call to `chat()` yields the next pre-programmed
 * round of chunks, and records the `messages` it was invoked with so tests can
 * assert the in-memory conversation ordering across rounds.
 */
class FakeChatProvider implements ChatProvider {
  readonly calls: Array<{ messages: ChatMessage[]; opts?: ChatOptions }> = [];
  private rounds: ScriptedRound[] = [];

  setRounds(rounds: ScriptedRound[]): void {
    this.rounds = rounds;
  }

  chat(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<ChatChunk> {
    // Snapshot the messages array — the orchestrator mutates `convo` in place
    // between rounds, so we must capture a copy at call time.
    const index = this.calls.length;
    this.calls.push({ messages: messages.map((m) => ({ ...m })), opts });
    const round = this.rounds[index] ?? [{ delta: '', done: true }];
    const chunks = Array.isArray(round) ? round : round.chunks;
    const thenThrow = Array.isArray(round) ? undefined : round.thenThrow;
    return (async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
      if (thenThrow !== undefined) {
        throw thenThrow;
      }
    })();
  }

  async chatComplete(): Promise<never> {
    throw new Error('chatComplete should not be called in tool-loop tests');
  }
}

function assistantTextChunk(text: string): ChatChunk[] {
  return [
    { delta: text, done: false },
    { delta: '', done: true },
  ];
}

/** A round that streams reasoning first, then the answer text. */
function reasoningThenTextChunk(reasoning: string, text: string): ChatChunk[] {
  return [
    { delta: '', done: false, reasoning },
    { delta: text, done: false },
    { delta: '', done: true },
  ];
}

function toolCallChunk(): ChatChunk[] {
  return [
    {
      delta: '',
      done: true,
      finishReason: 'tool_calls',
      toolCalls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({
              path: 'prd/x.md',
              title: 'X',
              content: '# X\n\nbody',
            }),
          },
        },
      ],
    },
  ];
}

describe('AiOrchestratorService.runWithTools', () => {
  let provider: FakeChatProvider;
  let orchestrator: AiOrchestratorService;
  let messagesSig: ReturnType<typeof signal<UiChatMessage[]>>;
  let proposeSpy: MockInstance | undefined;
  let persistCalls: Array<{ role: string; content: string; reasoning: string | null }>;
  let lastTurnError: AiErrorInfo | null;

  function setup(): void {
    provider = new FakeChatProvider();
    messagesSig = signal<UiChatMessage[]>([]);
    persistCalls = [];
    lastTurnError = null;

    // Typed as a structural stand-in; signal-typed members make a strict
    // Partial<ChatService> awkward, so we assert through unknown at injection.
    const chatStub = {
      activeSession: () => ({ id: 7 }),
      contextScope: () => EMPTY_CONTEXT_SCOPE,
      messages: messagesSig.asReadonly(),
      streaming: () => false,
      appendLocal: (m: UiChatMessage) => messagesSig.update((cur) => [...cur, m]),
      // Merge patches into the trailing assistant message (mirroring the real
      // service) so tests can assert streamed content / attached errors.
      updateLastAssistant: (patch: Partial<UiChatMessage>) =>
        messagesSig.update((cur) => {
          if (cur.length === 0) return cur;
          const last = cur[cur.length - 1];
          if (last.role !== 'assistant') return cur;
          return [...cur.slice(0, -1), { ...last, ...patch }];
        }),
      setStreaming: () => undefined,
      setError: () => undefined,
      setTurnError: (e: AiErrorInfo | null) => {
        lastTurnError = e;
      },
      persistMessage: async (
        _id: number,
        role: string,
        content: string,
        reasoning?: string | null,
      ) => {
        persistCalls.push({ role, content, reasoning: reasoning ?? null });
        return null;
      },
      refreshSessions: async () => undefined,
    } as unknown as ChatService;

    const providerStub = {
      isConfigured: () => true,
      chat: provider,
    } as unknown as AiProviderService;

    TestBed.configureTestingModule({
      providers: [
        AiOrchestratorService,
        ToolRegistryService,
        { provide: IpcService, useValue: {} },
        {
          provide: SettingsService,
          useValue: {
            aiMaxContextChars: () => 8000,
            aiTopK: () => 5,
            aiToolsEnabled: () => true,
            disabledTools: () => [],
          },
        },
        {
          provide: VaultService,
          useValue: {
            vaultPath: () => '/vault',
            activeFilePath: () => null,
          },
        },
        { provide: AiProviderService, useValue: providerStub },
        { provide: RetrievalService, useValue: { retrieve: async () => [] } },
        { provide: ChatService, useValue: chatStub },
        { provide: FileChangeService, useValue: {} },
        { provide: SyncService, useValue: {} },
        { provide: UiStateService, useValue: {} },
        // Without this stub the real root-provided registry is constructed
        // against the bare SettingsService stub above; `enabled()` then throws
        // (settings.skillsEnabled is undefined) and the orchestrator aborts
        // before ever calling the provider.
        {
          provide: SkillRegistryService,
          useValue: {
            enabled: () => [],
            find: () => undefined,
          } as unknown as SkillRegistryService,
        },
      ],
    });

    orchestrator = TestBed.inject(AiOrchestratorService);
  }

  /** Invokes the private tool loop with the public-equivalent signature. */
  function runTools(): Promise<void> {
    return (
      orchestrator as unknown as {
        runWithTools(opts: {
          userContent: string;
          scope: typeof EMPTY_CONTEXT_SCOPE;
          selection: null;
        }): Promise<void>;
      }
    ).runWithTools({ userContent: 'Create a PRD', scope: EMPTY_CONTEXT_SCOPE, selection: null });
  }

  beforeEach(() => {
    setup();
  });

  it('on accept: inserts assistant(tool_calls) then exactly one matching tool message before the 2nd model call, and produces a final reply', async () => {
    provider.setRounds([toolCallChunk(), assistantTextChunk('All set — created the PRD.')]);

    // Accept the staged proposal as soon as it opens.
    proposeSpy = vi.spyOn(orchestrator, 'proposeAndAwait').mockImplementation(
      async (): Promise<ProposalOutcome> => ({
        applied: true,
        relPath: 'prd/x.md',
        absPath: '/vault/prd/x.md',
      }),
    );

    await runTools();

    // The proposal was staged exactly once.
    expect(proposeSpy).toHaveBeenCalledTimes(1);

    // Two model invocations: tool round, then the final reply round.
    expect(provider.calls.length).toBe(2);

    // The SECOND chat() call must carry the assistant(tool_calls) message
    // immediately followed by exactly one tool message with the matching id.
    const second = provider.calls[1].messages;
    const asstIdx = second.findIndex(
      (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
    );
    expect(asstIdx).toBeGreaterThan(-1);

    const toolMsg = second[asstIdx + 1];
    expect(toolMsg.role).toBe('tool');
    expect(toolMsg.tool_call_id).toBe('call_1');

    // Exactly one tool message overall in the convo handed to round 2.
    expect(second.filter((m) => m.role === 'tool').length).toBe(1);

    // The accepted tool result reports the created path back to the model.
    expect(toolMsg.content).toContain('prd/x.md');

    // A non-tool final reply is persisted.
    const lastAssistant = persistCalls.filter((c) => c.role === 'assistant').pop();
    expect(lastAssistant?.content).toBe('All set — created the PRD.');
  });

  it('on reject: pushes a rejection tool result and does not invoke a write/second proposal', async () => {
    provider.setRounds([toolCallChunk(), assistantTextChunk('No problem, nothing was saved.')]);

    proposeSpy = vi.spyOn(orchestrator, 'proposeAndAwait').mockImplementation(
      async (): Promise<ProposalOutcome> => ({ applied: false }),
    );

    await runTools();

    // Only one proposal was ever staged (no retry write after rejection).
    expect(proposeSpy).toHaveBeenCalledTimes(1);

    const second = provider.calls[1].messages;
    const toolMsg = second.find((m) => m.role === 'tool');
    expect(toolMsg?.tool_call_id).toBe('call_1');
    expect((toolMsg?.content ?? '').toLowerCase()).toContain('reject');

    // A graceful final reply is still produced.
    const lastAssistant = persistCalls.filter((c) => c.role === 'assistant').pop();
    expect(lastAssistant?.content).toBe('No problem, nothing was saved.');
  });

  it('makes only a single model call when the first round returns plain text', async () => {
    provider.setRounds([assistantTextChunk('Here is your answer.')]);
    proposeSpy = vi.spyOn(orchestrator, 'proposeAndAwait');

    await runTools();

    expect(provider.calls.length).toBe(1);
    expect(proposeSpy).not.toHaveBeenCalled();
    const lastAssistant = persistCalls.filter((c) => c.role === 'assistant').pop();
    expect(lastAssistant?.content).toBe('Here is your answer.');
  });

  it('surfaces an honest, retryable notice when the tool-round cap is exhausted (no fake "Done.")', async () => {
    // Every round requests another tool call, so the cap (8) cuts the turn off.
    provider.setRounds(Array.from({ length: 8 }, () => toolCallChunk()));
    proposeSpy = vi.spyOn(orchestrator, 'proposeAndAwait').mockImplementation(
      async (): Promise<ProposalOutcome> => ({ applied: false }),
    );

    await runTools();

    expect(provider.calls.length).toBe(8);

    const last = messagesSig()[messagesSig().length - 1];
    expect(last.role).toBe('assistant');
    expect(last.streaming).toBe(false);
    expect(last.error?.retryable).toBe(true);
    expect(last.error?.message).toContain('tool rounds');

    // The cap notice is retryable and never persisted as a normal reply.
    expect(orchestrator.retryAvailable()).toBe(true);
    expect(persistCalls.filter((c) => c.role === 'assistant')).toEqual([]);
    expect(persistCalls.some((c) => c.content === 'Done.')).toBe(false);
  });

  it('attaches the structured error to the failed bubble and persists the partial text', async () => {
    const info: AiErrorInfo = {
      code: 'rate_limit',
      status: 429,
      retryAfterMs: 2000,
      retryable: true,
      message: 'Rate limit exceeded',
    };
    provider.setRounds([
      { chunks: [{ delta: 'Partial answer', done: false }], thenThrow: new AiHarnessError(info) },
    ]);

    await runTools();

    const last = messagesSig()[messagesSig().length - 1];
    expect(last.error).toEqual(info);
    expect(last.streaming).toBe(false);
    expect(last.content).toBe('Partial answer');

    // The structured error reaches the composer surface unchanged…
    expect(lastTurnError).toEqual(info);
    // …the turn is retryable, and the non-empty partial is persisted as a
    // normal assistant message (no DB migration for failed turns).
    expect(orchestrator.retryAvailable()).toBe(true);
    expect(persistCalls.filter((c) => c.role === 'assistant')).toEqual([
      { role: 'assistant', content: 'Partial answer', reasoning: null },
    ]);
  });

  it('skips persistence for a failed turn with no partial text', async () => {
    provider.setRounds([
      {
        chunks: [],
        thenThrow: new AiHarnessError({
          code: 'network',
          retryable: true,
          message: 'Could not reach the provider.',
        }),
      },
    ]);

    await runTools();

    expect(messagesSig()[messagesSig().length - 1].error?.code).toBe('network');
    expect(persistCalls.filter((c) => c.role === 'assistant')).toEqual([]);
  });

  it('persists a reasoning-only failed turn so streamed thinking survives reload', async () => {
    // The model streamed reasoning but failed before producing any answer text.
    provider.setRounds([
      {
        chunks: [{ delta: '', done: false, reasoning: 'Half a thought…' }],
        thenThrow: new AiHarnessError({
          code: 'network',
          retryable: true,
          message: 'Could not reach the provider.',
        }),
      },
    ]);

    await runTools();

    expect(messagesSig()[messagesSig().length - 1].error?.code).toBe('network');
    // Empty content but non-empty reasoning still persists the row (and its
    // reasoning) rather than dropping the streamed thinking.
    expect(persistCalls.filter((c) => c.role === 'assistant')).toEqual([
      { role: 'assistant', content: '', reasoning: 'Half a thought…' },
    ]);
  });

  it('retryLastFailed re-runs without re-appending or re-persisting the user message, reusing the failed bubble', async () => {
    provider.setRounds([
      {
        chunks: [],
        thenThrow: new AiHarnessError({
          code: 'server',
          status: 500,
          retryable: true,
          message: 'Internal server error',
        }),
      },
      assistantTextChunk('Recovered.'),
    ]);

    await runTools();

    expect(orchestrator.retryAvailable()).toBe(true);
    expect(messagesSig().length).toBe(2); // user + failed assistant bubble
    expect(persistCalls.filter((c) => c.role === 'user').length).toBe(1);

    await orchestrator.retryLastFailed();

    // Second model call ran, against the same (not duplicated) user turn.
    expect(provider.calls.length).toBe(2);
    expect(provider.calls[1].messages.filter((m) => m.role === 'user').length).toBe(1);

    // The failed bubble was reused in place, not appended next to.
    expect(messagesSig().length).toBe(2);
    const last = messagesSig()[messagesSig().length - 1];
    expect(last.content).toBe('Recovered.');
    expect(last.error).toBeNull();
    expect(last.streaming).toBe(false);

    // The user message was persisted exactly once; the recovery reply once.
    expect(persistCalls.filter((c) => c.role === 'user').length).toBe(1);
    expect(persistCalls.filter((c) => c.role === 'assistant')).toEqual([
      { role: 'assistant', content: 'Recovered.', reasoning: null },
    ]);
    expect(orchestrator.retryAvailable()).toBe(false);
  });

  it('treats a user Stop (AbortError) as a non-error and keeps the partial text', async () => {
    provider.setRounds([
      {
        chunks: [{ delta: 'partial before stop', done: false }],
        thenThrow: new DOMException('Aborted', 'AbortError'),
      },
    ]);

    await runTools();

    const last = messagesSig()[messagesSig().length - 1];
    expect(last.error).toBeNull();
    expect(last.streaming).toBe(false);
    expect(last.content).toBe('partial before stop');

    // No error surface, no retry affordance, nothing persisted for the turn.
    expect(lastTurnError).toBeNull();
    expect(orchestrator.retryAvailable()).toBe(false);
    expect(persistCalls.filter((c) => c.role === 'assistant')).toEqual([]);
  });

  it('streams reasoning into the assistant bubble and persists it with the reply', async () => {
    provider.setRounds([reasoningThenTextChunk('Thinking hard…', 'Here is your answer.')]);

    await runTools();

    // The reasoning reached the live assistant bubble via updateLastAssistant.
    const last = messagesSig()[messagesSig().length - 1];
    expect(last.role).toBe('assistant');
    expect(last.reasoning).toBe('Thinking hard…');
    expect(last.content).toBe('Here is your answer.');

    // The persisted assistant call carries the accumulated reasoning.
    const lastAssistant = persistCalls.filter((c) => c.role === 'assistant').pop();
    expect(lastAssistant).toEqual({
      role: 'assistant',
      content: 'Here is your answer.',
      reasoning: 'Thinking hard…',
    });
  });
});

describe('AiOrchestratorService.run (non-tool streaming path)', () => {
  let provider: FakeChatProvider;
  let orchestrator: AiOrchestratorService;
  let messagesSig: ReturnType<typeof signal<UiChatMessage[]>>;
  let persistCalls: Array<{ role: string; content: string; reasoning: string | null }>;

  function setup(): void {
    provider = new FakeChatProvider();
    messagesSig = signal<UiChatMessage[]>([]);
    persistCalls = [];

    const chatStub = {
      activeSession: () => ({ id: 7 }),
      contextScope: () => EMPTY_CONTEXT_SCOPE,
      messages: messagesSig.asReadonly(),
      streaming: () => false,
      appendLocal: (m: UiChatMessage) => messagesSig.update((cur) => [...cur, m]),
      updateLastAssistant: (patch: Partial<UiChatMessage>) =>
        messagesSig.update((cur) => {
          if (cur.length === 0) return cur;
          const last = cur[cur.length - 1];
          if (last.role !== 'assistant') return cur;
          return [...cur.slice(0, -1), { ...last, ...patch }];
        }),
      setStreaming: () => undefined,
      setError: () => undefined,
      setTurnError: () => undefined,
      persistMessage: async (
        _id: number,
        role: string,
        content: string,
        reasoning?: string | null,
      ) => {
        persistCalls.push({ role, content, reasoning: reasoning ?? null });
        return null;
      },
      refreshSessions: async () => undefined,
    } as unknown as ChatService;

    const providerStub = {
      isConfigured: () => true,
      chat: provider,
    } as unknown as AiProviderService;

    TestBed.configureTestingModule({
      providers: [
        AiOrchestratorService,
        ToolRegistryService,
        { provide: IpcService, useValue: {} },
        {
          provide: SettingsService,
          useValue: {
            aiMaxContextChars: () => 8000,
            aiTopK: () => 5,
            aiToolsEnabled: () => true,
            disabledTools: () => [],
          },
        },
        {
          provide: VaultService,
          useValue: {
            vaultPath: () => '/vault',
            activeFilePath: () => null,
          },
        },
        { provide: AiProviderService, useValue: providerStub },
        { provide: RetrievalService, useValue: { retrieve: async () => [] } },
        { provide: ChatService, useValue: chatStub },
        { provide: FileChangeService, useValue: {} },
        { provide: SyncService, useValue: {} },
        { provide: UiStateService, useValue: {} },
        {
          provide: SkillRegistryService,
          useValue: {
            enabled: () => [],
            find: () => undefined,
          } as unknown as SkillRegistryService,
        },
      ],
    });

    orchestrator = TestBed.inject(AiOrchestratorService);
  }

  /** Invokes the private streaming `run()` for an Ask-mode turn (no proposal). */
  function runStream(): Promise<void> {
    return (
      orchestrator as unknown as {
        run(opts: {
          userContent: string;
          scope: typeof EMPTY_CONTEXT_SCOPE;
          selection: null;
          additionalInstructions: null;
          expectsFileProposal: boolean;
          forcedEditRelPath: null;
          defaultFolder: null;
          defaultTitle: string;
        }): Promise<void>;
      }
    ).run({
      userContent: 'Explain the plan',
      scope: EMPTY_CONTEXT_SCOPE,
      selection: null,
      additionalInstructions: null,
      expectsFileProposal: false,
      forcedEditRelPath: null,
      defaultFolder: null,
      defaultTitle: 'Draft',
    });
  }

  beforeEach(() => {
    setup();
  });

  it('peels inline </think> reasoning out of streamed content: persists the clean answer and the pre-</think> reasoning', async () => {
    // Closing-tag-only (the real-model format): reasoning, then a CLOSING
    // </think> with no opening tag, then the answer.
    provider.setRounds([
      [
        { delta: 'Let me think about this. ', done: false },
        { delta: 'More thought.', done: false },
        { delta: '</think>', done: false },
        { delta: 'The actual answer.', done: false },
        { delta: '', done: true },
      ],
    ]);

    await runStream();

    // The live bubble shows the CLEAN answer (no tag, no reasoning text).
    const last = messagesSig()[messagesSig().length - 1];
    expect(last.role).toBe('assistant');
    expect(last.content).toBe('The actual answer.');
    expect(last.content).not.toContain('</think>');
    expect(last.reasoning).toContain('Let me think about this.');

    // Persistence stores the clean content and the merged (pre-</think>) reasoning.
    const persisted = persistCalls.filter((c) => c.role === 'assistant').pop();
    expect(persisted?.content).toBe('The actual answer.');
    expect(persisted?.content).not.toContain('</think>');
    expect(persisted?.reasoning).toContain('Let me think about this.');
  });

  it('streams a tag-less answer unchanged (no reasoning split)', async () => {
    provider.setRounds([
      [
        { delta: 'Plain ', done: false },
        { delta: 'answer.', done: false },
        { delta: '', done: true },
      ],
    ]);

    await runStream();

    const last = messagesSig()[messagesSig().length - 1];
    expect(last.content).toBe('Plain answer.');
    const persisted = persistCalls.filter((c) => c.role === 'assistant').pop();
    expect(persisted).toEqual({ role: 'assistant', content: 'Plain answer.', reasoning: null });
  });
});

/**
 * TER-37 (reworked) — `/decompose-stories` is the COMBINED decompose-and-push
 * action. The AI authors a STRUCTURED story list, those stories are rendered into
 * the doc tagged with stable `sf:id` markers, and the push comes from those
 * ID-tagged stories — behind ONE combined review. Gated so it never touches the
 * model when there is no active file, no enabled Linear connection, or the
 * provider is unconfigured.
 */
describe('AiOrchestratorService.decomposeAndPushActiveFile (TER-37)', () => {
  const ENABLED_LINEAR = { provider: 'linear', enabled: true, connectionId: 'linear-1' };

  /** A chatComplete-capable provider returning a fixed structured JSON payload. */
  class FakeCompleteProvider {
    completeCalls = 0;
    /** The messages the last chatComplete() call was handed (for prompt assertions). */
    lastMessages: ChatMessage[] = [];
    constructor(private readonly json: string) {}
    chat(): AsyncIterable<ChatChunk> {
      return (async function* () {
        yield { delta: '', done: true } as ChatChunk;
      })();
    }
    async chatComplete(messages: ChatMessage[]): Promise<{ content: string; reasoning: null }> {
      this.completeCalls += 1;
      this.lastMessages = messages.map((m) => ({ ...m }));
      return { content: this.json, reasoning: null };
    }
  }

  const STORIES_JSON = JSON.stringify({
    stories: [
      {
        title: 'Log in with email',
        role: 'returning user',
        capability: 'log in with email and password',
        benefit: 'I can access my workspace',
        acceptanceCriteria: ['Valid credentials land on the dashboard.', 'Invalid credentials show an error.'],
      },
    ],
  });

  function setup(opts: {
    activeFilePath: string | null;
    isConfigured?: boolean;
    connections?: Array<{ provider: string; enabled: boolean; connectionId: string }>;
    completeJson?: string;
    existingContent?: string;
  }): {
    orchestrator: AiOrchestratorService;
    provider: FakeCompleteProvider;
    setErrors: Array<string | null>;
    combinedReviews: Array<Parameters<UiStateService['openCombinedPushReview']>[0]>;
    applyCalls: Array<{ relPath?: string; afterContent?: string | null }>;
    executeFromItemsCalls: Array<{ connectionId: string; items: CanonicalItem[] }>;
    executePushCalls: Array<{ connectionId: string; filePath?: string }>;
  } {
    const messagesSig = signal<UiChatMessage[]>([]);
    const setErrors: Array<string | null> = [];
    const combinedReviews: Array<Parameters<UiStateService['openCombinedPushReview']>[0]> = [];
    const applyCalls: Array<{ relPath?: string; afterContent?: string | null }> = [];
    const executeFromItemsCalls: Array<{ connectionId: string; items: CanonicalItem[] }> = [];
    const executePushCalls: Array<{ connectionId: string; filePath?: string }> = [];
    const provider = new FakeCompleteProvider(opts.completeJson ?? STORIES_JSON);

    const chatStub = {
      activeSession: () => ({ id: 7 }),
      createSession: async () => ({ id: 7 }),
      contextScope: () => ({ ...EMPTY_CONTEXT_SCOPE }),
      messages: messagesSig.asReadonly(),
      streaming: () => false,
      appendLocal: (m: UiChatMessage) => messagesSig.update((cur) => [...cur, m]),
      updateLastAssistant: (patch: Partial<UiChatMessage>) =>
        messagesSig.update((cur) => {
          if (cur.length === 0) return cur;
          const last = cur[cur.length - 1];
          if (last.role !== 'assistant') return cur;
          return [...cur.slice(0, -1), { ...last, ...patch }];
        }),
      setStreaming: () => undefined,
      setError: (e: string | null) => {
        setErrors.push(e);
      },
      setTurnError: () => undefined,
      persistMessage: async () => null,
      refreshSessions: async () => undefined,
    } as unknown as ChatService;

    const providerStub = {
      isConfigured: () => opts.isConfigured ?? true,
      chat: provider,
    } as unknown as AiProviderService;

    TestBed.configureTestingModule({
      providers: [
        AiOrchestratorService,
        ToolRegistryService,
        {
          provide: IpcService,
          useValue: { readFile: async () => opts.existingContent ?? '# Auth\n\nEpic.' },
        },
        {
          provide: SettingsService,
          useValue: {
            aiMaxContextChars: () => 8000,
            aiTopK: () => 5,
            aiToolsEnabled: () => false,
            disabledTools: () => [],
            connectionsForVault: () => opts.connections ?? [ENABLED_LINEAR],
          },
        },
        {
          provide: VaultService,
          useValue: {
            vaultPath: () => '/vault',
            activeFilePath: () => opts.activeFilePath,
          },
        },
        { provide: EditorBufferService, useValue: { flushIfDirty: async () => undefined } },
        { provide: EditorSelectionService, useValue: { selection: () => null } },
        { provide: AiProviderService, useValue: providerStub },
        { provide: RetrievalService, useValue: { retrieve: async () => [] } },
        { provide: ChatService, useValue: chatStub },
        {
          provide: FileChangeService,
          useValue: {
            resolveBeforeContent: async () => opts.existingContent ?? '# Auth\n\nEpic.',
            apply: async (input: { relPath?: string; afterContent?: string | null }) => {
              applyCalls.push(input);
              return { absPath: '/vault/prd/auth.md' };
            },
          },
        },
        {
          provide: SyncService,
          useValue: {
            // The combined approve must push the in-memory items, NOT a disk re-read,
            // so this is the method the fix calls (executePush would re-read disk).
            executePushFromItems: async (connectionId: string, items: CanonicalItem[]) => {
              executeFromItemsCalls.push({ connectionId, items });
              return { results: [], created: items.length, updated: 0, skipped: 0, failed: 0 };
            },
            executePush: async (connectionId: string, filePath?: string) => {
              executePushCalls.push({ connectionId, filePath });
              return { results: [], created: 1, updated: 0, skipped: 0, failed: 0 };
            },
          },
        },
        {
          provide: UiStateService,
          useValue: {
            openCombinedPushReview: (req: Parameters<UiStateService['openCombinedPushReview']>[0]) => {
              combinedReviews.push(req);
            },
          },
        },
        {
          provide: SkillRegistryService,
          useValue: { enabled: () => [], find: () => undefined } as unknown as SkillRegistryService,
        },
      ],
    });

    const orchestrator = TestBed.inject(AiOrchestratorService);
    return {
      orchestrator,
      provider,
      setErrors,
      combinedReviews,
      applyCalls,
      executeFromItemsCalls,
      executePushCalls,
    };
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('happy path: builds proposed content + opens the combined review (no immediate write/push)', async () => {
    const ctx = setup({ activeFilePath: '/vault/prd/auth.md' });

    await ctx.orchestrator.decomposeAndPushActiveFile('focus on roles');

    expect(ctx.provider.completeCalls).toBe(1);
    // The combined review opened with the proposed items + doc-save summary.
    expect(ctx.combinedReviews).toHaveLength(1);
    const review = ctx.combinedReviews[0];
    expect(review.filePath).toBe('prd/auth.md');
    expect(review.summary.storiesAdded).toBe(1);
    // The push set is FLAT + stories-only: EXACTLY the one tagged story, no epic /
    // theme / "User Stories" heading items, and no parent links.
    expect(review.items).toHaveLength(1);
    expect(review.items.every((i) => i.level === 'story' && i.parentLocalId === undefined)).toBe(true);
    // The item title is the SHORT title now; the "As a …" statement moved into the
    // composed description body.
    expect(review.items[0].title).toBe('Log in with email');
    expect(review.items[0].description).toContain(
      'As a returning user, I want log in with email and password, so that I can access my workspace',
    );
    // Nothing is written or pushed until approval.
    expect(ctx.applyCalls).toHaveLength(0);
    expect(ctx.executeFromItemsCalls).toHaveLength(0);
    expect(ctx.executePushCalls).toHaveLength(0);
  });

  it('feeds the model the FULL document as context plus the already-tagged story titles', async () => {
    const existingContent = [
      '# Auth feature',
      '',
      '## Background',
      '',
      'A unique sentinel paragraph that must reach the model verbatim.',
      '',
      '## User Stories',
      '',
      '### Existing story already covered <!-- sf:id existing1 -->',
    ].join('\n');
    const ctx = setup({ activeFilePath: '/vault/prd/auth.md', existingContent });

    await ctx.orchestrator.decomposeAndPushActiveFile('');

    // The full doc (including the background prose) is pinned into the system
    // message, NOT a truncated or heading-only slice.
    const system = ctx.provider.lastMessages.find((m) => m.role === 'system')!;
    expect(system.content).toContain('A unique sentinel paragraph that must reach the model verbatim.');
    // The full-doc decomposition prompt is present (told it's the FULL feature
    // context, and to derive stories from understanding it, not the headings).
    expect(system.content).toContain('the full context of the feature we want to build');
    expect(system.content).toContain('NOT from the');
    expect(system.content).toContain("document's headings");
    // The already-tagged story's title is listed so the model won't duplicate it.
    expect(system.content).toContain('Existing story already covered');
  });

  it('approve writes the doc THEN pushes the previewed IN-MEMORY items (not a disk re-read)', async () => {
    const ctx = setup({ activeFilePath: '/vault/prd/auth.md' });

    await ctx.orchestrator.decomposeAndPushActiveFile('');
    const review = ctx.combinedReviews[0];

    const result = await review.onApprove();

    // Doc written exactly once (edit) with the proposed content as the source of truth.
    expect(ctx.applyCalls).toHaveLength(1);
    expect(ctx.applyCalls[0].relPath).toBe('prd/auth.md');

    // The push runs from the EXACT items the review previewed — NOT a disk re-read
    // via executePush(connectionId, filePath), which would re-extract through the
    // file readers and could diverge from the preview.
    expect(ctx.executePushCalls).toHaveLength(0);
    expect(ctx.executeFromItemsCalls).toHaveLength(1);
    expect(ctx.executeFromItemsCalls[0].connectionId).toBe('linear-1');
    // The very items array the review carried is pushed verbatim — same reference.
    expect(ctx.executeFromItemsCalls[0].items).toBe(review.items);
    expect(result.created).toBe(1);
  });

  // REPRODUCTION (TER-37 bug): a fully-structured story (statement + description +
  // AC + open questions + risks) must reach the push with its FULL CanonicalItem
  // `description` and `criteria` — not the title+criteria-only shape the whole-vault
  // converter produces. The combined execute pushes the previewed in-memory items,
  // so the items that actually reach the push carry every structured field.
  it('pushes the FULL structured CanonicalItem (statement+description+open questions+risks) on approve', async () => {
    const structuredJson = JSON.stringify({
      stories: [
        {
          title: 'Reset password',
          role: 'locked-out user',
          capability: 'reset my password',
          benefit: 'I regain access',
          description: 'Covers the email reset link and its expiry window.',
          acceptanceCriteria: ['A reset link is emailed.'],
          openQuestions: ['Should the link be single-use?'],
          risks: ['Reset emails may land in spam.'],
        },
      ],
    });
    const ctx = setup({ activeFilePath: '/vault/prd/auth.md', completeJson: structuredJson });

    await ctx.orchestrator.decomposeAndPushActiveFile('');
    const review = ctx.combinedReviews[0];
    await review.onApprove();

    // The executed plan operates over the previewed items, not a disk re-read.
    expect(ctx.executePushCalls).toHaveLength(0);
    expect(ctx.executeFromItemsCalls).toHaveLength(1);
    const [pushed] = ctx.executeFromItemsCalls[0].items;

    // Title is the short heading title; the "As a …" statement lives in the body.
    expect(pushed.title).toBe('Reset password');
    // The FULL structured description reaches the push — every section, in order.
    expect(pushed.description).toContain(
      'As a locked-out user, I want reset my password, so that I regain access',
    );
    expect(pushed.description).toContain('Covers the email reset link and its expiry window.');
    expect(pushed.description).toContain('**Open questions**');
    expect(pushed.description).toContain('- Should the link be single-use?');
    expect(pushed.description).toContain('**Risks**');
    expect(pushed.description).toContain('- Reset emails may land in spam.');
    // AC stays on `criteria` (the adapter folds it into its checklist), NOT in the body.
    expect(pushed.criteria).toEqual(['A reset link is emailed.']);
    expect(pushed.description).not.toContain('A reset link is emailed.');
  });

  it('empty {stories:[]} → no doc changes, no review modal', async () => {
    const ctx = setup({
      activeFilePath: '/vault/prd/auth.md',
      completeJson: JSON.stringify({ stories: [] }),
    });

    await ctx.orchestrator.decomposeAndPushActiveFile('');

    expect(ctx.provider.completeCalls).toBe(1);
    expect(ctx.combinedReviews).toHaveLength(0);
    expect(ctx.applyCalls).toHaveLength(0);
    expect(ctx.executeFromItemsCalls).toHaveLength(0);
    expect(ctx.executePushCalls).toHaveLength(0);
  });

  it('errors and never calls the model when no file is active', async () => {
    const ctx = setup({ activeFilePath: null });

    await ctx.orchestrator.decomposeAndPushActiveFile('');

    expect(ctx.provider.completeCalls).toBe(0);
    expect(ctx.combinedReviews).toHaveLength(0);
    expect(ctx.setErrors).toContain('Open a markdown file to decompose into stories.');
  });

  it('errors and never calls the model when there is no enabled Linear connection', async () => {
    const ctx = setup({ activeFilePath: '/vault/prd/auth.md', connections: [] });

    await ctx.orchestrator.decomposeAndPushActiveFile('');

    expect(ctx.provider.completeCalls).toBe(0);
    expect(ctx.combinedReviews).toHaveLength(0);
    expect(
      ctx.setErrors.some((e) => (e ?? '').includes('No enabled Linear connection')),
    ).toBe(true);
  });

  it('errors (no model call) when the provider is unconfigured', async () => {
    const ctx = setup({ activeFilePath: '/vault/prd/auth.md', isConfigured: false });

    await ctx.orchestrator.decomposeAndPushActiveFile('');

    expect(ctx.provider.completeCalls).toBe(0);
    expect(ctx.combinedReviews).toHaveLength(0);
    expect(ctx.setErrors).toContain('No API key configured. Open Settings to add one.');
  });
});
