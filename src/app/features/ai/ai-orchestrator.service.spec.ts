import { vi, type MockInstance } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { EMPTY_CONTEXT_SCOPE } from '../../shared/types';
import { IpcService } from '../../core/ipc.service';
import { SettingsService } from '../../core/settings.service';
import { VaultService } from '../../core/vault.service';
import { AiProviderService } from './providers/ai-provider.service';
import { RetrievalService } from './providers/retrieval.service';
import { ChatService, type UiChatMessage } from './chat.service';
import { FileChangeService } from './file-change.service';
import { ToolRegistryService } from './tools/tool-registry.service';
import type {
  ChatChunk,
  ChatMessage,
  ChatOptions,
  ChatProvider,
} from './providers/chat.provider';
import { AiOrchestratorService, type ProposalOutcome } from './ai-orchestrator.service';

/**
 * A scripted chat provider: each call to `chat()` yields the next pre-programmed
 * round of chunks, and records the `messages` it was invoked with so tests can
 * assert the in-memory conversation ordering across rounds.
 */
class FakeChatProvider implements ChatProvider {
  readonly calls: Array<{ messages: ChatMessage[]; opts?: ChatOptions }> = [];
  private rounds: ChatChunk[][] = [];

  setRounds(rounds: ChatChunk[][]): void {
    this.rounds = rounds;
  }

  chat(messages: ChatMessage[], opts?: ChatOptions): AsyncIterable<ChatChunk> {
    // Snapshot the messages array — the orchestrator mutates `convo` in place
    // between rounds, so we must capture a copy at call time.
    const index = this.calls.length;
    this.calls.push({ messages: messages.map((m) => ({ ...m })), opts });
    const chunks = this.rounds[index] ?? [{ delta: '', done: true }];
    return (async function* () {
      for (const chunk of chunks) {
        yield chunk;
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
  let persistCalls: Array<{ role: string; content: string }>;

  function setup(): void {
    provider = new FakeChatProvider();
    messagesSig = signal<UiChatMessage[]>([]);
    persistCalls = [];

    // Typed as a structural stand-in; signal-typed members make a strict
    // Partial<ChatService> awkward, so we assert through unknown at injection.
    const chatStub = {
      activeSession: () => ({ id: 7 }),
      contextScope: () => EMPTY_CONTEXT_SCOPE,
      messages: messagesSig.asReadonly(),
      appendLocal: (m: UiChatMessage) => messagesSig.update((cur) => [...cur, m]),
      updateLastAssistant: () => undefined,
      setStreaming: () => undefined,
      setError: () => undefined,
      persistMessage: async (_id: number, role: string, content: string) => {
        persistCalls.push({ role, content });
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
      ],
    });

    orchestrator = TestBed.inject(AiOrchestratorService);
  }

  /** Invokes the private tool loop with the public-equivalent signature. */
  function runTools(): Promise<void> {
    return (
      orchestrator as unknown as {
        runWithTools(opts: { userContent: string; scope: typeof EMPTY_CONTEXT_SCOPE }): Promise<void>;
      }
    ).runWithTools({ userContent: 'Create a PRD', scope: EMPTY_CONTEXT_SCOPE });
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
});
