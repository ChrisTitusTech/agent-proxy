

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { CodexAppServerOptions } from '@agent-proxy/shared';

const DEFAULT_RESTART_DELAY_MS = 1000;
const MAX_RESTART_DELAY_MS = 30000;
const INITIALIZE_TIMEOUT_MS = 10000;
const GRACEFUL_SHUTDOWN_MS = 3000;

export interface CodexAppServerProcessConfig {
  cliPath: string;
  options: CodexAppServerOptions;
  env: Record<string, string | undefined>;
  workingDir?: string;
}


interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export class CodexAppServerProcess {
  private child: ChildProcess | null = null;
  private pendingRequests = new Map<number, PendingRequest>();
  private notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private nextRequestId = 1;
  private restartCount = 0;
  private maxRestartCount: number;
  private autoRestart: boolean;
  private starting = false;
  private stopping = false;
  private initialized = false;

  constructor(private config: CodexAppServerProcessConfig) {
    this.autoRestart = config.options.auto_restart ?? true;
    this.maxRestartCount = config.options.max_restart_count ?? 5;
  }


  async start(): Promise<void> {
    if (this.child || this.starting) return;
    this.starting = true;
    try {
      this.child = spawn(this.config.cliPath, ['app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...this.config.env } as NodeJS.ProcessEnv,
        cwd: this.config.workingDir,
      });


      const rl = createInterface({ input: this.child.stdout! });
      rl.on('line', (line) => this.handleLine(line));


      this.child.stderr?.on('data', (data: Buffer) => {
        console.error(`[codex-appserver] stderr: ${data.toString().trim()}`);
      });


      this.child.on('exit', (code, signal) => {
        this.handleExit(code, signal);
      });
      this.child.on('error', (err) => {
        console.error('[codex-appserver] process error:', err.message);
        this.handleExit(1, null);
      });


      await this.initialize();
      this.restartCount = 0;
    } finally {
      this.starting = false;
    }
  }


  private async initialize(): Promise<void> {
    await this.request(
      'initialize',
      {
        clientInfo: { name: 'agent-proxy', title: null, version: '1.0.0' },
        capabilities: { experimentalApi: false },
      },
      INITIALIZE_TIMEOUT_MS,
    );


    this.sendNotification('initialized');
    this.initialized = true;
  }


  async stop(): Promise<void> {
    this.stopping = true;
    this.autoRestart = false;

    if (!this.child) {
      this.stopping = false;
      return;
    }


    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('App server shutting down'));
      this.pendingRequests.delete(id);
    }

    const child = this.child;
    this.child = null;
    this.initialized = false;

    return new Promise<void>((resolve) => {

      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
        }
        resolve();
      }, GRACEFUL_SHUTDOWN_MS);

      child.once('exit', () => {
        clearTimeout(killTimer);
        this.stopping = false;
        resolve();
      });

      try {
        child.kill('SIGTERM');
      } catch {
      }
    });
  }

  isAlive(): boolean {
    return this.child !== null && this.initialized && !this.stopping;
  }


  async request<T = unknown>(method: string, params?: unknown, timeoutMs = 30000): Promise<T> {
    if (!this.child?.stdin?.writable && method !== 'initialize') {
      throw new Error('App server process is not running');
    }

    const id = this.nextRequestId++;
    const message = JSON.stringify({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
      id,
    });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`JSON-RPC request timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.child!.stdin!.write(message + '\n');
    });
  }


  sendNotification(method: string, params?: unknown): void {
    if (!this.child?.stdin?.writable) return;
    const message = JSON.stringify({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    });
    this.child.stdin.write(message + '\n');
  }



  onNotification(method: string, handler: (params: unknown) => void): () => void {
    let handlers = this.notificationHandlers.get(method);
    if (!handlers) {
      handlers = new Set();
      this.notificationHandlers.set(method, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers!.delete(handler);
    };
  }


  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed);
    } catch {

      return;
    }


    if ('id' in msg && typeof msg.id === 'number') {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        if ('error' in msg && msg.error) {
          const err = msg.error as { code?: number; message?: string };
          pending.reject(new Error(`JSON-RPC error ${err.code ?? -1}: ${err.message ?? 'unknown'}`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }


    if ('method' in msg && typeof msg.method === 'string') {
      const handlers = this.notificationHandlers.get(msg.method);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(msg.params);
          } catch (err) {
            console.error(`[codex-appserver] notification handler error (${msg.method}):`, err);
          }
        }
      }
    }
  }


  private handleExit(code: number | null, signal: string | null): void {
    const wasAlive = this.initialized;
    this.child = null;
    this.initialized = false;


    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`App server exited (code=${code}, signal=${signal})`));
    }
    this.pendingRequests.clear();

    if (this.stopping) return;

    if (wasAlive) {
      console.warn(`[codex-appserver] process exited unexpectedly (code=${code}, signal=${signal})`);
    }


    if (this.autoRestart && this.restartCount < this.maxRestartCount) {
      const delay = Math.min(
        DEFAULT_RESTART_DELAY_MS * Math.pow(2, this.restartCount),
        MAX_RESTART_DELAY_MS,
      );
      this.restartCount++;
      console.log(
        `[codex-appserver] restarting in ${delay}ms (attempt ${this.restartCount}/${this.maxRestartCount})`,
      );
      setTimeout(() => {
        if (!this.stopping) {
          this.start().catch((err) => {
            console.error('[codex-appserver] restart failed:', err.message);
          });
        }
      }, delay);
    } else if (this.restartCount >= this.maxRestartCount) {
      console.error(
        `[codex-appserver] max restart count (${this.maxRestartCount}) reached, giving up`,
      );
    }
  }


  resetRestartCount(): void {
    this.restartCount = 0;
  }
}
