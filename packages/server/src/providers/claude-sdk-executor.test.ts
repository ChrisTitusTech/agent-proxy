import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ExecuteOptions, ClaudeSdkOptions } from '@agent-proxy/shared';
import { ClaudeSdkSessionManager } from './claude-sdk-session-manager.js';


const mockMessages: Record<string, unknown>[] = [];
let waitForAbort = false;
let lastSdkAbortSignal: AbortSignal | undefined;
let queryCount = 0;

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: async function* (params: { options?: { abortController?: AbortController } }) {
    queryCount += 1;
    lastSdkAbortSignal = params.options?.abortController?.signal;
    if (waitForAbort && lastSdkAbortSignal) {
      if (lastSdkAbortSignal.aborted) {
        throw new Error('aborted');
      }
      await new Promise<void>((resolve) => {
        lastSdkAbortSignal!.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('aborted');
    }
    for (const msg of mockMessages) {
      yield msg;
    }
  },
}));


const { executeSdk, executeStreamSdk } = await import('./claude-sdk-executor.js');

function createOptions(overrides?: Partial<ExecuteOptions>): ExecuteOptions {
  return {
    messages: [{ role: 'user', content: 'Hello' }],
    model: 'claude-sonnet-4-6',
    stream: false,
    ...overrides,
  };
}

function createConfig(sdkOptions?: Partial<ClaudeSdkOptions>) {
  return {
    model: 'claude-sonnet-4-6',
    sdkOptions: {
      max_turns: 5,
      permission_mode: 'bypassPermissions',
      ...sdkOptions,
    },
    workingDir: '/tmp',
    timeoutMs: 30000,
    cleanEnv: {},
    cliPath: 'claude',
  };
}

describe('claude-sdk-executor', () => {
  beforeEach(() => {
    mockMessages.length = 0;
    waitForAbort = false;
    lastSdkAbortSignal = undefined;
    queryCount = 0;
  });

  describe('executeSdk', () => {
    it('aborts an active SDK query during provider shutdown', async () => {
      waitForAbort = true;
      const shutdownController = new AbortController();
      const execution = executeSdk(createOptions(), {
        ...createConfig(),
        shutdownSignal: shutdownController.signal,
      });
      await vi.waitFor(() => expect(lastSdkAbortSignal).toBeDefined());

      shutdownController.abort();

      await expect(execution).rejects.toThrow('aborted');
      expect(lastSdkAbortSignal?.aborted).toBe(true);
    });

    it('does not retry an existing session after shutdown cancellation', async () => {
      waitForAbort = true;
      const shutdownController = new AbortController();
      const sessionManager = new ClaudeSdkSessionManager();
      sessionManager.set('client', 'existing-session', 'claude-sonnet-4-6');
      const execution = executeSdk(createOptions(), {
        ...createConfig(),
        shutdownSignal: shutdownController.signal,
        sessionManager,
        clientKey: 'client',
      });
      await vi.waitFor(() => expect(lastSdkAbortSignal).toBeDefined());

      shutdownController.abort();

      await expect(execution).rejects.toThrow('aborted');
      expect(queryCount).toBe(1);
      sessionManager.destroy();
    });

    it('passes an already-aborted shutdown signal to the SDK query', async () => {
      waitForAbort = true;
      const shutdownController = new AbortController();
      shutdownController.abort();

      await expect(executeSdk(createOptions(), {
        ...createConfig(),
        shutdownSignal: shutdownController.signal,
      })).rejects.toThrow('aborted');
      expect(lastSdkAbortSignal?.aborted).toBe(true);
    });

    it('executes Claude SDK requests', async () => {
      mockMessages.push(
        {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-1',
          model: 'claude-sonnet-4-6',
          tools: [],
          mcp_servers: [],
        },
        {
          type: 'assistant',
          session_id: 'sess-1',
          message: {
            content: [
              { type: 'text', text: 'Hello! How can I help you?' },
            ],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-1',
          is_error: false,
          result: 'Hello! How can I help you?',
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 10,
          },
        },
      );

      const result = await executeSdk(createOptions(), createConfig());

      expect(result.content).toBe('Hello! How can I help you?');
      expect(result.usage.promptTokens).toBe(160); // 100 + 50 + 10
      expect(result.usage.completionTokens).toBe(20);
      expect(result.usage.totalTokens).toBe(180); // 160 + 20
      expect(result.finishReason).toBe('stop');
    });

    it('executes Claude SDK requests', async () => {
      mockMessages.push(
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-2',
          is_error: false,
          result: 'Fallback text',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      );

      const result = await executeSdk(createOptions(), createConfig());

      expect(result.content).toBe('Fallback text');
      expect(result.finishReason).toBe('stop');
    });

    it('executes Claude SDK requests', async () => {
      mockMessages.push(
        {
          type: 'result',
          subtype: 'error_max_turns',
          session_id: 'sess-3',
          is_error: true,
          errors: ['Max turns exceeded'],
          usage: {
            input_tokens: 50,
            output_tokens: 10,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      );

      const result = await executeSdk(createOptions(), createConfig());

      expect(result.finishReason).toBe('length');
    });
  });

  describe('executeStreamSdk', () => {
    it('does not retry an existing session after request cancellation', async () => {
      waitForAbort = true;
      const requestController = new AbortController();
      const sessionManager = new ClaudeSdkSessionManager();
      sessionManager.set('client', 'existing-session', 'claude-sonnet-4-6');
      const stream = executeStreamSdk(createOptions({
        stream: true,
        signal: requestController.signal,
      }), {
        ...createConfig(),
        sessionManager,
        clientKey: 'client',
      });
      const consumption = (async () => {
        for await (const event of stream) void event;
      })();
      await vi.waitFor(() => expect(lastSdkAbortSignal).toBeDefined());

      requestController.abort();

      await expect(consumption).rejects.toThrow('aborted');
      expect(queryCount).toBe(1);
      sessionManager.destroy();
    });

    it('executes Claude SDK requests', async () => {
      mockMessages.push(
        {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-4',
        },
        {
          type: 'stream_event',
          session_id: 'sess-4',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Hello' },
          },
        },
        {
          type: 'stream_event',
          session_id: 'sess-4',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: ' World' },
          },
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-4',
          is_error: false,
          usage: {
            input_tokens: 30,
            output_tokens: 10,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      );

      const chunks: unknown[] = [];
      for await (const chunk of executeStreamSdk(
        createOptions({ stream: true }),
        createConfig(),
      )) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(4);
      expect(chunks[0]).toEqual({ type: 'text_delta', text: 'Hello' });
      expect(chunks[1]).toEqual({ type: 'text_delta', text: ' World' });
      expect(chunks[2]).toEqual({
        type: 'usage',
        usage: { promptTokens: 30, completionTokens: 10, totalTokens: 40 },
      });
      expect(chunks[3]).toEqual({ type: 'done', finishReason: 'stop' });
    });

    it('executes Claude SDK requests', async () => {
      mockMessages.push(
        {
          type: 'result',
          subtype: 'error_during_execution',
          session_id: 'sess-5',
          is_error: true,
          errors: ['Something went wrong'],
          usage: {
            input_tokens: 10,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      );

      const chunks: unknown[] = [];
      for await (const chunk of executeStreamSdk(
        createOptions({ stream: true }),
        createConfig(),
      )) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(3);
      expect(chunks[0]).toEqual({ type: 'error', error: 'Something went wrong' });
      expect(chunks[1]).toEqual({
        type: 'usage',
        usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
      });
      expect(chunks[2]).toEqual({ type: 'done', finishReason: 'error' });
    });
  });

  describe('executes Claude SDK requests', () => {
    it('executes Claude SDK requests', async () => {
      mockMessages.push(
        {
          type: 'system',
          subtype: 'init',
          session_id: 'new-session-123',
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'new-session-123',
          is_error: false,
          result: 'Done',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
      );

      const sessionManager = new ClaudeSdkSessionManager();
      const config = {
        ...createConfig(),
        sessionManager,
        clientKey: 'test-client',
      };

      await executeSdk(createOptions(), config);

      const session = sessionManager.get('test-client', 'claude-sonnet-4-6');
      expect(session).not.toBeNull();
      expect(session!.sessionId).toBe('new-session-123');

      sessionManager.destroy();
    });
  });
});

describe('ClaudeSdkSessionManager', () => {
  let manager: ClaudeSdkSessionManager;

  beforeEach(() => {
    manager = new ClaudeSdkSessionManager(5000);
  });

  afterEach(() => {
    manager.destroy();
  });

  it('executes Claude SDK requests', () => {
    manager.set('client-1', 'sess-a', 'claude-sonnet-4-6');
    const session = manager.get('client-1', 'claude-sonnet-4-6');
    expect(session).not.toBeNull();
    expect(session!.sessionId).toBe('sess-a');
  });

  it('executes Claude SDK requests', () => {
    manager.set('client-1', 'sess-a', 'claude-sonnet-4-6');
    const session = manager.get('client-1', 'claude-opus-4-6');
    expect(session).toBeNull();
  });

  it('executes Claude SDK requests', () => {
    manager.set('client-1', 'sess-a', 'claude-sonnet-4-6');
    manager.invalidate('client-1');
    const session = manager.get('client-1', 'claude-sonnet-4-6');
    expect(session).toBeNull();
  });

  it('executes Claude SDK requests', async () => {
    manager.destroy();
    manager = new ClaudeSdkSessionManager(50); // 50ms TTL
    manager.set('client-1', 'sess-a', 'claude-sonnet-4-6');


    await new Promise((resolve) => setTimeout(resolve, 100));

    const session = manager.get('client-1', 'claude-sonnet-4-6');
    expect(session).toBeNull();
  });

  it('executes Claude SDK requests', () => {
    expect(manager.size).toBe(0);
    manager.set('client-1', 'sess-a', 'model-a');
    manager.set('client-2', 'sess-b', 'model-b');
    expect(manager.size).toBe(2);
    manager.invalidate('client-1');
    expect(manager.size).toBe(1);
  });
});
