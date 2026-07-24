




import type {
  ExecuteOptions,
  ExecuteResult,
  ProviderEvent,
  TokenUsage,
  CodexAppServerOptions,
} from '@agent-proxy/shared';
import type { CodexAppServerProcess } from './codex-appserver-process.js';
import type { CodexAppServerSessionManager } from './codex-appserver-session-manager.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';
import { KeyedMutex } from '../utils/keyed-mutex.js';





const turnMutexes = new WeakMap<CodexAppServerProcess, KeyedMutex>();

function getTurnMutex(proc: CodexAppServerProcess): KeyedMutex {
  let mutex = turnMutexes.get(proc);
  if (!mutex) {
    mutex = new KeyedMutex();
    turnMutexes.set(proc, mutex);
  }
  return mutex;
}



export interface AppServerExecutorConfig {
  model: string;
  options: CodexAppServerOptions;
  process: CodexAppServerProcess;
  sessionManager?: CodexAppServerSessionManager;
  clientKey?: string;
  timeoutMs: number;

  onAppServerMeta?: (meta: AppServerMeta) => void;
}

export interface AppServerMeta {
  threadId: string | null;
  threadReused: boolean;
  retried: boolean;
}


export interface AppServerExecuteResult extends ExecuteResult {
  appServerMeta: AppServerMeta;
}



interface ThreadStartResponse {
  thread?: { id?: string; [key: string]: unknown };
  threadId?: string;
  thread_id?: string;
  [key: string]: unknown;
}

interface ThreadResumeResponse {
  thread?: { id?: string; [key: string]: unknown };
  threadId?: string;
  thread_id?: string;
  [key: string]: unknown;
}

interface TurnStartResponse {
  turn: {
    id: string;
    [key: string]: unknown;
  };
}

interface ThreadStartedParams {
  thread?: { id?: string; [key: string]: unknown };
  threadId?: string;
  thread_id?: string;
  [key: string]: unknown;
}


interface AgentMessageDeltaParams {
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}


interface ItemCompletedParams {
  item: {
    type: string;
    id: string;
    text?: string;
    [key: string]: unknown;
  };
  threadId: string;
  turnId: string;
}


interface TurnCompletedParams {
  threadId: string;
  turn: {
    id: string;
    status: string;
    error: { message: string } | null;
  };
}


interface TokenUsageUpdatedParams {
  threadId: string;
  turnId: string;
  tokenUsage: {
    total: TokenUsageBreakdown;
    last: TokenUsageBreakdown;
  };
}

interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}



interface ChannelItem<T> {
  value?: T;
  done?: boolean;
  error?: Error;
}

class AsyncChannel<T> {
  private queue: ChannelItem<T>[] = [];
  private waiting: ((item: ChannelItem<T>) => void) | null = null;

  push(value: T): void {
    const item: ChannelItem<T> = { value };
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(item);
    } else {
      this.queue.push(item);
    }
  }

  end(): void {
    const item: ChannelItem<T> = { done: true };
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(item);
    } else {
      this.queue.push(item);
    }
  }

  fail(error: Error): void {
    const item: ChannelItem<T> = { error };
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve(item);
    } else {
      this.queue.push(item);
    }
  }

  async next(): Promise<ChannelItem<T>> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    return new Promise<ChannelItem<T>>((resolve) => {
      this.waiting = resolve;
    });
  }
}



function extractThreadId(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as {
    thread?: { id?: unknown };
    threadId?: unknown;
    thread_id?: unknown;
  };

  if (typeof candidate.thread?.id === 'string' && candidate.thread.id.trim()) {
    return candidate.thread.id;
  }

  if (typeof candidate.threadId === 'string' && candidate.threadId.trim()) {
    return candidate.threadId;
  }

  if (typeof candidate.thread_id === 'string' && candidate.thread_id.trim()) {
    return candidate.thread_id;
  }

  return null;
}

function waitForThreadStartedNotification(
  proc: CodexAppServerProcess,
  timeoutMs: number,
): { promise: Promise<string | null>; cleanup: () => void } {
  let settled = false;
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    unsubscribe();
  };

  const promise = new Promise<string | null>((resolve) => {
    const finish = (threadId: string | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(threadId);
    };

    unsubscribe = proc.onNotification('thread/started', (params) => {
      finish(extractThreadId(params as ThreadStartedParams));
    });

    // Some app-server builds emit the authoritative thread id on thread/started.
    // If we miss it and keep `undefined`, JSON.stringify drops `threadId` from turn/start,
    // which surfaces as the misleading server error: "missing field threadId".
    timer = setTimeout(() => {
      finish(null);
    }, Math.min(timeoutMs, 1000));
  });

  return { promise, cleanup };
}

function requireThreadIdForTurn(threadId: string | null | undefined, source: string): string {
  if (typeof threadId === 'string' && threadId.trim()) {
    return threadId;
  }

  throw new Error(
    `${source} did not return a usable threadId. Refusing to send turn/start because JSON.stringify would omit an undefined threadId and the app-server would reject the request as "missing field threadId".`,
  );
}

async function getOrCreateThread(
  proc: CodexAppServerProcess,
  existingThreadId: string | null,
  timeoutMs: number,
): Promise<{ threadId: string; reused: boolean }> {
  if (existingThreadId) {

    const result = await proc.request<ThreadResumeResponse>(
      'thread/resume',
      {
        threadId: existingThreadId,
        persistExtendedHistory: false,
      },
      timeoutMs,
    );
    return {
      threadId: requireThreadIdForTurn(extractThreadId(result) ?? existingThreadId, 'thread/resume'),
      reused: true,
    };
  }


  const threadStarted = waitForThreadStartedNotification(proc, timeoutMs);
  try {
    const result = await proc.request<ThreadStartResponse>(
      'thread/start',
      {
        experimentalRawEvents: false,
        persistExtendedHistory: false,
      },
      timeoutMs,
    );

    return {
      threadId: requireThreadIdForTurn(
        extractThreadId(result) ?? await threadStarted.promise,
        'thread/start',
      ),
      reused: false,
    };
  } finally {
    threadStarted.cleanup();
  }
}



function buildUserInput(prompt: string): Array<{ type: 'text'; text: string; text_elements: never[] }> {
  return [{ type: 'text', text: prompt, text_elements: [] }];
}



function buildDebugArgs(
  model: string,
  threadId: string | null,
  threadReused: boolean,
): string[] {
  return [
    'app-server',
    '--model', model,
    threadReused ? '(thread-reused)' : '(new-thread)',
    `thread:${threadId ?? 'none'}`,
  ];
}



export async function executeAppServer(
  options: ExecuteOptions,
  config: AppServerExecutorConfig,
): Promise<AppServerExecuteResult> {
  const { process: proc, model, sessionManager, clientKey, timeoutMs } = config;

  if (!proc.isAlive()) {
    throw new Error('The Codex app-server process is not running');
  }


  const prompt = convertMessagesToSinglePrompt(options.messages);


  const existingThread = sessionManager && clientKey
    ? sessionManager.get(clientKey, model)
    : null;

  let threadId: string | null = null;
  let threadReused = false;
  let retried = false;
  let content = '';
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const finishReason: ExecuteResult['finishReason'] = 'stop';

  try {
    const result = await executeTurn(proc, prompt, existingThread?.threadId ?? null, timeoutMs, options.signal);
    threadId = result.threadId;
    threadReused = result.threadReused;
    content = result.content;
    usage = result.usage;


    if (threadId && sessionManager && clientKey) {
      sessionManager.set(clientKey, threadId, model);
    }


    proc.resetRestartCount();
  } catch (err) {

    if (existingThread && sessionManager && clientKey) {
      sessionManager.invalidate(clientKey);
      retried = true;

      try {
        const retryResult = await executeTurn(proc, prompt, null, timeoutMs, options.signal);
        threadId = retryResult.threadId;
        threadReused = false;
        content = retryResult.content;
        usage = retryResult.usage;


        if (threadId && sessionManager && clientKey) {
          sessionManager.set(clientKey, threadId, model);
        }
        proc.resetRestartCount();
      } catch (retryErr) {
        throw new Error(
          `Codex app-server execution failed after retry: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
        );
      }
    } else {
      throw new Error(
        `Codex app-server execution failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }


  options.onDebug?.({
    cliArgs: buildDebugArgs(model, threadId, threadReused && !retried),
  });

  return {
    content,
    usage,
    finishReason,
    appServerMeta: {
      threadId,
      threadReused: threadReused && !retried,
      retried,
    },
  };
}


async function executeTurn(
  proc: CodexAppServerProcess,
  prompt: string,
  existingThreadId: string | null,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{
  threadId: string;
  threadReused: boolean;
  content: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}> {

  const { threadId: rawThreadId, reused } = await getOrCreateThread(proc, existingThreadId, timeoutMs);
  const threadId = requireThreadIdForTurn(rawThreadId, 'getOrCreateThread');


  return getTurnMutex(proc).runExclusive(threadId, async () => {

    let content = '';
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const deltaChunks: string[] = [];
    const cleanups: (() => void)[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {

      const turnCompleted = new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for turn/completed (${timeoutMs}ms)`));
        }, timeoutMs);


        if (signal) {
          signal.addEventListener('abort', () => {
            reject(new Error('Request was cancelled'));
          }, { once: true });
        }




        cleanups.push(proc.onNotification('item/agentMessage/delta', (params) => {
          const p = params as AgentMessageDeltaParams;
          if (p.threadId === threadId) {
            deltaChunks.push(p.delta);
          }
        }));


        cleanups.push(proc.onNotification('item/completed', (params) => {
          const p = params as ItemCompletedParams;
          if (p.threadId === threadId && p.item.type === 'agentMessage' && p.item.text) {
            content = p.item.text;
          }
        }));


        cleanups.push(proc.onNotification('thread/tokenUsage/updated', (params) => {
          const p = params as TokenUsageUpdatedParams;
          if (p.threadId === threadId) {
            const last = p.tokenUsage.last;
            usage = {
              promptTokens: last.inputTokens,
              completionTokens: last.outputTokens,
              totalTokens: last.totalTokens,
            };
          }
        }));


        cleanups.push(proc.onNotification('turn/completed', (params) => {
          const p = params as TurnCompletedParams;
          if (p.threadId === threadId) {
            resolve();
          }
        }));
      });


      await proc.request('turn/start', {
        threadId,
        input: buildUserInput(prompt),
      }, timeoutMs);


      await turnCompleted;


      if (!content && deltaChunks.length > 0) {
        content = deltaChunks.join('');
      }

      return { threadId, threadReused: reused, content, usage };
    } finally {

      if (timer) clearTimeout(timer);
      for (const cleanup of cleanups) cleanup();
    }
  });
}



export async function* executeStreamAppServer(
  options: ExecuteOptions,
  config: AppServerExecutorConfig,
): AsyncGenerator<ProviderEvent, void> {
  const { process: proc, model, sessionManager, clientKey, timeoutMs } = config;

  if (!proc.isAlive()) {
    yield { type: 'error', error: 'The Codex app-server process is not running' };
    yield { type: 'done' };
    return;
  }


  const prompt = convertMessagesToSinglePrompt(options.messages);


  const existingThread = sessionManager && clientKey
    ? sessionManager.get(clientKey, model)
    : null;

  try {
    yield* executeStreamTurn(
      proc, prompt, existingThread?.threadId ?? null, timeoutMs, model, options, config,
    );
  } catch (err) {
    if (options.signal?.aborted) {
      throw err;
    }

    if (existingThread && sessionManager && clientKey) {
      sessionManager.invalidate(clientKey);

      try {
        yield* executeStreamTurn(
          proc, prompt, null, timeoutMs, model, options, config,
        );

        config.onAppServerMeta?.({
          threadId: null,
          threadReused: false,
          retried: true,
        });
      } catch (retryErr) {
        yield {
          type: 'error',
          error: `Codex app-server execution failed after retry: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
        };
        yield { type: 'done' };
      }
    } else {
      yield {
        type: 'error',
        error: `Codex app-server execution failed: ${err instanceof Error ? err.message : String(err)}`,
      };
      yield { type: 'done' };
    }
  }
}


async function* executeStreamTurn(
  proc: CodexAppServerProcess,
  prompt: string,
  existingThreadId: string | null,
  timeoutMs: number,
  model: string,
  options: ExecuteOptions,
  config: AppServerExecutorConfig,
): AsyncGenerator<ProviderEvent, void> {

  const { threadId: rawThreadId, reused } = await getOrCreateThread(proc, existingThreadId, timeoutMs);
  const threadId = requireThreadIdForTurn(rawThreadId, 'getOrCreateThread');


  const releaseTurnLock = await getTurnMutex(proc).acquire(threadId);


  const channel = new AsyncChannel<ProviderEvent>();
  const cleanups: (() => void)[] = [];
  let activeTurnId: string | null = null;
  let turnCompleted = false;
  let resolveTurnCompletion: (() => void) | undefined;
  const turnCompletion = new Promise<void>((resolve) => {
    resolveTurnCompletion = resolve;
  });


  const timer = setTimeout(() => {
    channel.fail(new Error(`Timed out waiting for turn/completed (${timeoutMs}ms)`));
  }, timeoutMs);


  const onAbort = () => {
    clearTimeout(timer);
    channel.fail(new Error('Request was cancelled'));
  };
  if (options.signal) {
    options.signal.addEventListener('abort', onAbort, { once: true });
  }




  cleanups.push(proc.onNotification('item/agentMessage/delta', (params) => {
    const p = params as AgentMessageDeltaParams;
    if (p.threadId === threadId) {
      channel.push({ type: 'text_delta', text: p.delta });
    }
  }));


  let finalUsage: TokenUsage | undefined;
  cleanups.push(proc.onNotification('thread/tokenUsage/updated', (params) => {
    const p = params as TokenUsageUpdatedParams;
    if (p.threadId === threadId) {
      const last = p.tokenUsage.last;
      finalUsage = {
        promptTokens: last.inputTokens,
        completionTokens: last.outputTokens,
        totalTokens: last.totalTokens,
      };
    }
  }));


  cleanups.push(proc.onNotification('turn/completed', (params) => {
    const p = params as TurnCompletedParams;
    if (
      p.threadId === threadId
      && (!activeTurnId || p.turn.id === activeTurnId)
    ) {
      turnCompleted = true;
      resolveTurnCompletion?.();
      clearTimeout(timer);
      if (finalUsage) channel.push({ type: 'usage', usage: finalUsage });
      channel.push({ type: 'done' });
      channel.end();
    }
  }));


  try {
    const started = await proc.request<TurnStartResponse>('turn/start', {
      threadId,
      input: buildUserInput(prompt),
    }, timeoutMs);
    activeTurnId = started.turn?.id ?? null;
    if (!activeTurnId) {
      throw new Error('turn/start did not return a usable turn ID.');
    }
  } catch (err) {
    clearTimeout(timer);
    for (const cleanup of cleanups) cleanup();
    options.signal?.removeEventListener('abort', onAbort);
    releaseTurnLock();
    throw err;
  }


  try {
    while (true) {
      const item = await channel.next();

      if (item.error) {
        throw item.error;
      }

      if (item.done) {
        break;
      }

      if (item.value) {
        yield item.value;


        if (item.value.type === 'done') {
          break;
        }
      }
    }


    if (threadId && config.sessionManager && config.clientKey) {
      config.sessionManager.set(config.clientKey, threadId, model);
    }


    proc.resetRestartCount();


    options.onDebug?.({
      cliArgs: buildDebugArgs(model, threadId, reused),
    });


    config.onAppServerMeta?.({
      threadId,
      threadReused: reused,
      retried: false,
    });
  } finally {
    try {
      if (activeTurnId && !turnCompleted) {
        await proc.request(
          'turn/interrupt',
          { threadId, turnId: activeTurnId },
          timeoutMs,
        );
        if (!turnCompleted) {
          await new Promise<void>((resolve, reject) => {
            const completionTimer = setTimeout(() => {
              reject(new Error(
                `Timed out waiting for interrupted turn/completed (${timeoutMs}ms)`,
              ));
            }, timeoutMs);
            completionTimer.unref();
            void turnCompletion.then(() => {
              clearTimeout(completionTimer);
              resolve();
            });
          });
        }
      }
    } finally {
      clearTimeout(timer);
      for (const cleanup of cleanups) cleanup();
      options.signal?.removeEventListener('abort', onAbort);
      releaseTurnLock();
    }
  }
}
