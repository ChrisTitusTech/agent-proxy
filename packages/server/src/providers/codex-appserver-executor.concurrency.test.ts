



import { describe, it, expect, afterEach } from 'vitest';
import type { ExecuteOptions, ProviderEvent } from '@agent-proxy/shared';
import type { CodexAppServerProcess } from './codex-appserver-process.js';
import { CodexAppServerSessionManager } from './codex-appserver-session-manager.js';
import {
  executeAppServer,
  executeStreamAppServer,
  type AppServerExecutorConfig,
} from './codex-appserver-executor.js';

const TICK_MS = 5;
const MODEL = 'gpt-5.3-codex';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function usageBlock() {
  return {
    totalTokens: 30,
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 20,
    reasoningOutputTokens: 0,
  };
}





class MockAppServer {
  private handlers = new Map<string, Set<(params: unknown) => void>>();
  private threadCounter = 0;
  private turnCounter = 0;
  private activeTurnsByThread = new Map<string, number>();
  private activeTurnIds = new Set<string>();
  private interruptPendingTurns = new Set<string>();
  private interruptGate: Promise<void> | null = null;
  private activeTurnsTotal = 0;


  maxConcurrentTurnsPerThread = 0;
  maxConcurrentTurnsTotal = 0;
  interruptRequests: Array<{ threadId: string; turnId: string }> = [];
  turnStartPrompts: string[] = [];

  deferInterruptCompletion(): () => void {
    let release: (() => void) | undefined;
    this.interruptGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => release?.();
  }

  isAlive(): boolean {
    return true;
  }

  resetRestartCount(): void {}

  sendNotification(): void {}

  onNotification(method: string, handler: (params: unknown) => void): () => void {
    let set = this.handlers.get(method);
    if (!set) {
      set = new Set();
      this.handlers.set(method, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;

    if (method === 'thread/start') {
      return { thread: { id: `thread-${++this.threadCounter}` } };
    }
    if (method === 'thread/resume') {
      return { thread: { id: p.threadId } };
    }
    if (method === 'turn/start') {
      const threadId = p.threadId as string;
      const input = p.input as Array<{ text: string }>;
      const promptText = input[0]?.text ?? '';
      const turnId = `turn-${++this.turnCounter}`;

      this.turnStartPrompts.push(promptText);
      void this.runTurn(threadId, turnId, promptText);
      return { turn: { id: turnId } };
    }
    if (method === 'turn/interrupt') {
      const threadId = p.threadId as string;
      const turnId = p.turnId as string;
      this.interruptRequests.push({ threadId, turnId });
      this.interruptPendingTurns.add(turnId);
      await this.interruptGate;
      this.completeTurn(threadId, turnId, 'interrupted');
      return {};
    }
    throw new Error(`Unexpected JSON-RPC method: ${method}`);
  }

  private emit(method: string, params: unknown): void {
    for (const handler of [...(this.handlers.get(method) ?? [])]) {
      handler(params);
    }
  }


  private async runTurn(threadId: string, turnId: string, promptText: string): Promise<void> {
    const active = (this.activeTurnsByThread.get(threadId) ?? 0) + 1;
    this.activeTurnsByThread.set(threadId, active);
    this.activeTurnsTotal++;
    this.activeTurnIds.add(turnId);
    this.maxConcurrentTurnsPerThread = Math.max(this.maxConcurrentTurnsPerThread, active);
    this.maxConcurrentTurnsTotal = Math.max(this.maxConcurrentTurnsTotal, this.activeTurnsTotal);

    const chunks = ['echo(', promptText, ')'];
    for (const chunk of chunks) {
      await delay(TICK_MS);
      if (
        !this.activeTurnIds.has(turnId)
        || this.interruptPendingTurns.has(turnId)
      ) return;
      this.emit('item/agentMessage/delta', {
        threadId,
        turnId,
        itemId: `item-${turnId}`,
        delta: chunk,
      });
    }

    this.emit('item/completed', {
      threadId,
      turnId,
      item: { type: 'agentMessage', id: `item-${turnId}`, text: chunks.join('') },
    });
    this.emit('thread/tokenUsage/updated', {
      threadId,
      turnId,
      tokenUsage: { total: usageBlock(), last: usageBlock() },
    });

    await delay(TICK_MS);
    this.completeTurn(threadId, turnId, 'completed');
  }

  private completeTurn(
    threadId: string,
    turnId: string,
    status: 'completed' | 'interrupted',
  ): void {
    if (!this.activeTurnIds.delete(turnId)) return;
    this.interruptPendingTurns.delete(turnId);
    this.activeTurnsByThread.set(threadId, this.activeTurnsByThread.get(threadId)! - 1);
    this.activeTurnsTotal--;
    this.emit('turn/completed', {
      threadId,
      turn: { id: turnId, status, error: null },
    });
  }
}

function createOptions(prompt: string, stream = false): ExecuteOptions {
  return {
    messages: [{ role: 'user', content: prompt }],
    model: MODEL,
    stream,
  };
}

function createConfig(
  proc: MockAppServer,
  sessionManager: CodexAppServerSessionManager,
  clientKey: string,
): AppServerExecutorConfig {
  return {
    model: MODEL,
    options: {},
    process: proc as unknown as CodexAppServerProcess,
    sessionManager,
    clientKey,
    timeoutMs: 5000,
  };
}

async function collectStreamText(gen: AsyncGenerator<ProviderEvent, void>): Promise<string> {
  const texts: string[] = [];
  for await (const event of gen) {
    if (event.type === 'text_delta') {
      texts.push(event.text);
    }
    if (event.type === 'error') {
      throw new Error(event.error);
    }
  }
  return texts.join('');
}

describe('serializes Codex app-server turns', () => {
  let sessionManager: CodexAppServerSessionManager;

  afterEach(() => {
    sessionManager?.destroy();
  });

  it('serializes Codex app-server turns', async () => {
    const proc = new MockAppServer();
    sessionManager = new CodexAppServerSessionManager();

    sessionManager.set('client-1', 'thread-shared', MODEL);

    const [resultA, resultB] = await Promise.all([
      executeAppServer(createOptions('prompt-A'), createConfig(proc, sessionManager, 'client-1')),
      executeAppServer(createOptions('prompt-B'), createConfig(proc, sessionManager, 'client-1')),
    ]);

    expect(resultA.content).toContain('prompt-A');
    expect(resultA.content).not.toContain('prompt-B');
    expect(resultB.content).toContain('prompt-B');
    expect(resultB.content).not.toContain('prompt-A');
  });

  it('serializes Codex app-server turns', async () => {
    const proc = new MockAppServer();
    sessionManager = new CodexAppServerSessionManager();
    sessionManager.set('client-1', 'thread-shared', MODEL);

    const [textA, textB] = await Promise.all([
      collectStreamText(
        executeStreamAppServer(
          createOptions('prompt-A', true),
          createConfig(proc, sessionManager, 'client-1'),
        ),
      ),
      collectStreamText(
        executeStreamAppServer(
          createOptions('prompt-B', true),
          createConfig(proc, sessionManager, 'client-1'),
        ),
      ),
    ]);

    expect(textA).toContain('prompt-A');
    expect(textA).not.toContain('prompt-B');
    expect(textB).toContain('prompt-B');
    expect(textB).not.toContain('prompt-A');
  });

  it('serializes Codex app-server turns', async () => {
    const proc = new MockAppServer();
    sessionManager = new CodexAppServerSessionManager();
    sessionManager.set('client-1', 'thread-shared', MODEL);

    await Promise.all([
      executeAppServer(createOptions('prompt-A'), createConfig(proc, sessionManager, 'client-1')),
      executeAppServer(createOptions('prompt-B'), createConfig(proc, sessionManager, 'client-1')),
      executeAppServer(createOptions('prompt-C'), createConfig(proc, sessionManager, 'client-1')),
    ]);

    expect(proc.maxConcurrentTurnsPerThread).toBe(1);
  });

  it('interrupts an aborted stream before releasing the thread lock', async () => {
    const proc = new MockAppServer();
    sessionManager = new CodexAppServerSessionManager();
    sessionManager.set('client-1', 'thread-shared', MODEL);
    const controller = new AbortController();
    const options = {
      ...createOptions('prompt-A', true),
      signal: controller.signal,
    };
    const stream = executeStreamAppServer(
      options,
      createConfig(proc, sessionManager, 'client-1'),
    );
    const releaseInterrupt = proc.deferInterruptCompletion();

    const first = await stream.next();
    expect(first.value).toMatchObject({ type: 'text_delta' });
    controller.abort();
    const returning = stream.return();
    while (proc.interruptRequests.length === 0) await delay(TICK_MS);

    expect(proc.interruptRequests).toEqual([{
      threadId: 'thread-shared',
      turnId: 'turn-1',
    }]);

    const nextTurn = executeAppServer(
      createOptions('prompt-B'),
      createConfig(proc, sessionManager, 'client-1'),
    );
    await delay(TICK_MS * 2);
    expect(proc.turnStartPrompts).toEqual(['prompt-A']);

    releaseInterrupt();
    await returning;
    await nextTurn;
    expect(proc.turnStartPrompts).toEqual(['prompt-A', 'prompt-B']);
    expect(proc.maxConcurrentTurnsPerThread).toBe(1);
  });

  it('serializes Codex app-server turns', async () => {
    const proc = new MockAppServer();
    sessionManager = new CodexAppServerSessionManager();

    const [resultA, resultB] = await Promise.all([
      executeAppServer(createOptions('prompt-A'), createConfig(proc, sessionManager, 'client-1')),
      executeAppServer(createOptions('prompt-B'), createConfig(proc, sessionManager, 'client-2')),
    ]);

    expect(resultA.content).toContain('prompt-A');
    expect(resultB.content).toContain('prompt-B');
    expect(proc.maxConcurrentTurnsPerThread).toBe(1);
    expect(proc.maxConcurrentTurnsTotal).toBeGreaterThanOrEqual(2);
  });

  it('serializes Codex app-server turns', async () => {
    const proc = new MockAppServer();
    sessionManager = new CodexAppServerSessionManager();
    sessionManager.set('client-1', 'thread-shared', MODEL);

    const [resultA, textB] = await Promise.all([
      executeAppServer(createOptions('prompt-A'), createConfig(proc, sessionManager, 'client-1')),
      collectStreamText(
        executeStreamAppServer(
          createOptions('prompt-B', true),
          createConfig(proc, sessionManager, 'client-1'),
        ),
      ),
    ]);

    expect(resultA.content).toContain('prompt-A');
    expect(resultA.content).not.toContain('prompt-B');
    expect(textB).toContain('prompt-B');
    expect(textB).not.toContain('prompt-A');
    expect(proc.maxConcurrentTurnsPerThread).toBe(1);
  });
});
