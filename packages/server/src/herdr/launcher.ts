import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { KeyedMutex } from '../utils/keyed-mutex.js';
import { HERDR_WORKER_PROTOCOL, type HerdrWorkerEvent, type HerdrWorkerStart } from './protocol.js';

const execFileAsync = promisify(execFile);
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

export interface HerdrLauncherConfig {
  binary: string;
  runtimeDirectory: string;
  workspaceLabel: string;
  commandTimeoutMs: number;
  paneTtlMs: number;
  maxPanes: number;
  workerPath?: string;
}

export interface ProviderExecutionRequest {
  provider: string;
  model: string;
  executionIdentity: string;
  requestId?: string;
  clientKey: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdin?: string;
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface ProviderExecutionResult {
  exitCode: number;
  signal?: string;
  paneId: string;
  terminalState: 'completed' | 'failed';
}

export interface ProviderExecutionHandle {
  stdout: PassThrough;
  stderr: PassThrough;
  paneId: string;
  completion: Promise<ProviderExecutionResult>;
  cancel: () => void;
}

export interface ProviderExecutionBackend {
  start(request: ProviderExecutionRequest): Promise<ProviderExecutionHandle>;
  readiness(): Promise<HerdrReadiness>;
  shutdown(): Promise<void>;
}

export interface HerdrReadiness {
  ready: boolean;
  version?: string;
  protocol?: number;
  message?: string;
}

interface HerdrEnvelope<T> {
  result: T;
}

interface Workspace {
  workspace_id: string;
  label: string;
}

interface Tab {
  tab_id: string;
  workspace_id: string;
  label: string;
}

interface Pane {
  pane_id: string;
  tab_id: string;
}

interface PaneRecord {
  paneId: string;
  tabId: string;
  lastUsedAt: number;
}

interface SessionKeyRecord {
  key: string;
  lastUsedAt: number;
}

class HerdrUnavailableError extends Error {
  readonly code = 'herdr_unavailable';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export class HerdrLauncher implements ProviderExecutionBackend {
  private readonly config: HerdrLauncherConfig;
  private readonly mutex = new KeyedMutex();
  private readonly panes = new Map<string, PaneRecord>();
  private readonly active = new Set<ProviderExecutionHandle>();
  private readonly starting = new Set<Promise<ProviderExecutionHandle>>();
  private readonly startingSessionKeys = new Map<string, number>();
  private readonly reservedPaneIds = new Set<string>();
  private readonly sessionKeys = new Map<string, SessionKeyRecord>();
  private workspaceId: string | null = null;
  private staleTabsPruned = false;
  private shuttingDown = false;
  private readinessCache?: { value: HerdrReadiness; expiresAt: number };

  constructor(config: HerdrLauncherConfig) {
    this.config = config;
  }

  async readiness(): Promise<HerdrReadiness> {
    const cached = this.readinessCache;
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    try {
      const { stdout } = await execFileAsync(this.config.binary, ['status', '--json'], {
        timeout: this.config.commandTimeoutMs,
        maxBuffer: 1024 * 1024,
      });
      const status = JSON.parse(stdout) as {
        server?: { running?: boolean; compatible?: boolean; version?: string; protocol?: number };
      };
      const server = status.server;
      if (!server?.running) return { ready: false, message: 'Herdr server is not running.' };
      if (!server.compatible) {
        return {
          ready: false,
          version: server.version,
          protocol: server.protocol,
          message: 'Herdr client and server protocols are incompatible.',
        };
      }
      const ready = {
        ready: true,
        version: server.version,
        protocol: server.protocol,
      };
      this.readinessCache = { value: ready, expiresAt: Date.now() + 1_000 };
      return ready;
    } catch {
      return {
        ready: false,
        message: 'Unable to query Herdr readiness.',
      };
    }
  }

  start(request: ProviderExecutionRequest): Promise<ProviderExecutionHandle> {
    if (this.shuttingDown) {
      return Promise.reject(new HerdrUnavailableError('Herdr launcher is shutting down.'));
    }
    const operation = this.startTracked(request);
    this.starting.add(operation);
    void operation.then(
      () => this.starting.delete(operation),
      () => this.starting.delete(operation),
    );
    return operation;
  }

  private async startTracked(
    request: ProviderExecutionRequest,
  ): Promise<ProviderExecutionHandle> {
    const deadline = Date.now() + request.timeoutMs;
    const ready = await this.readiness();
    if (!ready.ready) {
      throw new HerdrUnavailableError(
        `Herdr is unavailable; provider execution was not started. ${ready.message ?? ''}`.trim(),
      );
    }

    const sessionKey = this.sessionKey(request);
    let startingKeyReserved = true;
    let release: (() => void) | undefined;
    let pane: PaneRecord | undefined;
    try {
      release = await this.mutex.acquire(sessionKey, {
        ...(request.signal ? { signal: request.signal } : {}),
        timeoutMs: Math.max(0, deadline - Date.now()),
      });
      this.assertRequestCanStart(request, deadline);
      if (this.shuttingDown) {
        throw new HerdrUnavailableError('Herdr launcher is shutting down.');
      }
      pane = await this.ensurePane(sessionKey, request);
      this.releaseStartingSessionKey(sessionKey);
      startingKeyReserved = false;
      this.assertRequestCanStart(request, deadline);
      if (this.shuttingDown) {
        throw new HerdrUnavailableError('Herdr launcher is shutting down.');
      }
      const handle = await this.startWorker(pane.paneId, sessionKey, {
        ...request,
        timeoutMs: Math.max(1, deadline - Date.now()),
      });
      this.active.add(handle);
      this.reservedPaneIds.delete(pane.paneId);
      if (this.shuttingDown) handle.cancel();
      void handle.completion.then(() => {
        this.active.delete(handle);
        pane!.lastUsedAt = Date.now();
        release!();
        void this.prunePanesWithLock().catch(() => undefined);
      }, () => {
        this.active.delete(handle);
        pane!.lastUsedAt = Date.now();
        release!();
        void this.prunePanesWithLock().catch(() => undefined);
      });
      return handle;
    } catch (error) {
      if (pane) this.reservedPaneIds.delete(pane.paneId);
      if (startingKeyReserved) this.releaseStartingSessionKey(sessionKey);
      release?.();
      throw error;
    }
  }

  private assertRequestCanStart(
    request: ProviderExecutionRequest,
    deadline: number,
  ): void {
    if (request.signal?.aborted) {
      throw new Error(`${request.provider} request cancelled before provider start.`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`${request.provider} CLI timed out before provider start.`);
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    while (this.starting.size > 0 || this.active.size > 0) {
      for (const handle of this.active) handle.cancel();
      await Promise.allSettled([
        ...this.starting,
        ...Array.from(this.active, (handle) => handle.completion),
      ]);
    }
  }

  private sessionKey(request: ProviderExecutionRequest): string {
    const identity = [
      request.clientKey,
      request.provider,
      request.model,
      request.cwd,
      request.executionIdentity,
    ].join('\0');
    const existing = this.sessionKeys.get(identity);
    if (existing) {
      existing.lastUsedAt = Date.now();
      this.reserveStartingSessionKey(existing.key);
      return existing.key;
    }
    const record = {
      key: randomUUID().replaceAll('-', '').slice(0, 16),
      lastUsedAt: Date.now(),
    };
    this.sessionKeys.set(identity, record);
    this.reserveStartingSessionKey(record.key);
    this.pruneSessionKeys();
    return record.key;
  }

  private reserveStartingSessionKey(key: string): void {
    this.startingSessionKeys.set(
      key,
      (this.startingSessionKeys.get(key) ?? 0) + 1,
    );
  }

  private releaseStartingSessionKey(key: string): void {
    const count = this.startingSessionKeys.get(key);
    if (count === undefined) return;
    if (count <= 1) this.startingSessionKeys.delete(key);
    else this.startingSessionKeys.set(key, count - 1);
  }

  private pruneSessionKeys(): void {
    const maximum = Math.max(this.config.maxPanes * 2, 2);
    if (this.sessionKeys.size <= maximum) return;
    const candidates = Array.from(this.sessionKeys.entries())
      .filter(([, record]) => (
        !this.panes.has(record.key)
        && !this.startingSessionKeys.has(record.key)
      ))
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (const [identity] of candidates) {
      if (this.sessionKeys.size <= maximum) break;
      this.sessionKeys.delete(identity);
    }
  }

  private async ensurePane(
    sessionKey: string,
    request: ProviderExecutionRequest,
  ): Promise<PaneRecord> {
    const release = await this.mutex.acquire('__pane_capacity__');
    try {
      const existing = this.panes.get(sessionKey);
      if (existing && Date.now() - existing.lastUsedAt <= this.config.paneTtlMs) {
        this.reservedPaneIds.add(existing.paneId);
        return existing;
      }
      if (existing) {
        await this.command(['tab', 'close', existing.tabId]);
        this.panes.delete(sessionKey);
      }

      const workspaceId = await this.ensureWorkspace(request.cwd);
      const label = `api-${request.provider}-${sessionKey}`;
      const tabs = await this.command<{ type: string; tabs: Tab[] }>([
        'tab', 'list', '--workspace', workspaceId,
      ]);
      const existingTab = tabs.tabs.find((tab) => tab.label === label);
      let paneId: string;
      let tabId: string;

      if (existingTab) {
        const panes = await this.command<{ type: string; panes: Pane[] }>([
          'pane', 'list', '--workspace', workspaceId,
        ]);
        const pane = panes.panes.find((candidate) => candidate.tab_id === existingTab.tab_id);
        if (!pane) throw new Error(`Herdr tab ${existingTab.tab_id} has no pane.`);
        paneId = pane.pane_id;
        tabId = existingTab.tab_id;
      } else {
        const created = await this.command<{
          type: string;
          tab: Tab;
          root_pane: Pane;
        }>([
          'tab', 'create',
          '--workspace', workspaceId,
          '--cwd', request.cwd,
          '--label', label,
          '--no-focus',
        ]);
        paneId = created.root_pane.pane_id;
        tabId = created.tab.tab_id;
      }

      const record = { paneId, tabId, lastUsedAt: Date.now() };
      this.panes.set(sessionKey, record);
      this.reservedPaneIds.add(paneId);
      await this.prunePanes(sessionKey);
      return record;
    } finally {
      release();
    }
  }

  private async ensureWorkspace(cwd: string): Promise<string> {
    if (this.workspaceId && this.staleTabsPruned) return this.workspaceId;
    const release = await this.mutex.acquire('__workspace__');
    try {
      if (!this.workspaceId) {
        const listed = await this.command<{ type: string; workspaces: Workspace[] }>([
          'workspace', 'list',
        ]);
        const existing = listed.workspaces.find(
          (workspace) => workspace.label === this.config.workspaceLabel,
        );
        if (existing) {
          this.workspaceId = existing.workspace_id;
        } else {
          const created = await this.command<{
            type: string;
            workspace: Workspace;
            tab: Tab;
            root_pane: Pane;
          }>([
            'workspace', 'create',
            '--cwd', cwd,
            '--label', this.config.workspaceLabel,
            '--no-focus',
          ]);
          this.workspaceId = created.workspace.workspace_id;
        }
      }
      if (!this.staleTabsPruned) {
        await this.pruneStaleTabs(this.workspaceId);
        this.staleTabsPruned = true;
      }
      return this.workspaceId;
    } finally {
      release();
    }
  }

  private async pruneStaleTabs(workspaceId: string): Promise<void> {
    const listed = await this.command<{ type: string; tabs: Tab[] }>([
      'tab', 'list', '--workspace', workspaceId,
    ]);
    const staleTabs = listed.tabs.filter(
      (tab) => /^api-.+-[a-f0-9]{16}$/i.test(tab.label),
    );
    for (const tab of staleTabs) {
      try {
        await this.command(['tab', 'close', tab.tab_id]);
      } catch {
        // One unreachable stale tab must not block workspace initialization.
      }
    }
  }

  private async prunePanes(currentKey: string): Promise<void> {
    const now = Date.now();
    const candidates = Array.from(this.panes.entries())
      .filter(([key, pane]) => key !== currentKey && !this.isPaneInUse(pane.paneId))
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (const [key, pane] of candidates) {
      const expired = now - pane.lastUsedAt > this.config.paneTtlMs;
      const overLimit = this.panes.size > this.config.maxPanes;
      if (!expired && !overLimit) continue;
      try {
        await this.command(['tab', 'close', pane.tabId]);
      } catch {
        continue;
      }
      this.panes.delete(key);
      for (const [identity, record] of this.sessionKeys) {
        if (record.key === key) this.sessionKeys.delete(identity);
      }
    }
  }

  private async prunePanesWithLock(): Promise<void> {
    const release = await this.mutex.acquire('__pane_capacity__');
    try {
      await this.prunePanes('');
    } finally {
      release();
    }
  }

  private isPaneInUse(paneId: string): boolean {
    return this.reservedPaneIds.has(paneId)
      || Array.from(this.active).some((handle) => handle.paneId === paneId);
  }

  private async startWorker(
    paneId: string,
    sessionKey: string,
    request: ProviderExecutionRequest,
  ): Promise<ProviderExecutionHandle> {
    const workerDeadline = Date.now() + request.timeoutMs;
    const timeoutError = new Error(
      `${request.provider} CLI timed out after ${request.timeoutMs}ms`,
    );
    const jobId = randomUUID();
    const jobDirectory = resolve(this.config.runtimeDirectory, 'jobs', jobId);
    const socketPath = resolve(jobDirectory, 'worker.sock');
    await mkdir(jobDirectory, { recursive: true, mode: 0o700 });
    await chmod(jobDirectory, 0o700);

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let workerSocket: Socket | null = null;
    let server: Server | null = null;
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let forceCancelTimeout: ReturnType<typeof setTimeout> | undefined;
    let startupTimeout: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    let cancellationError: Error | undefined;
    let startupInProgress = true;

    const cleanup = async (): Promise<void> => {
      if (timeout) clearTimeout(timeout);
      if (forceCancelTimeout) clearTimeout(forceCancelTimeout);
      if (startupTimeout) clearTimeout(startupTimeout);
      if (abortListener && request.signal) {
        request.signal.removeEventListener('abort', abortListener);
      }
      workerSocket?.destroy();
      if (server?.listening) {
        await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
      }
      await rm(jobDirectory, { recursive: true, force: true });
    };

    let resolveWorkerCompletion!: (result: ProviderExecutionResult) => void;
    let rejectWorkerCompletion!: (error: Error) => void;
    const workerCompletion = new Promise<ProviderExecutionResult>((resolveResult, rejectResult) => {
      resolveWorkerCompletion = resolveResult;
      rejectWorkerCompletion = rejectResult;
    });
    const completion = workerCompletion.then(
      async (result) => {
        await this.reportPane(paneId, sessionKey, request, 'idle', result.terminalState);
        return result;
      },
      async (error: Error) => {
        await this.reportPane(
          paneId,
          sessionKey,
          request,
          'idle',
          terminalStateForError(error),
        );
        throw error;
      },
    );
    void completion.catch(() => undefined);

    const finish = (
      result?: ProviderExecutionResult,
      error?: Error,
    ): void => {
      if (settled) return;
      settled = true;
      stdout.end();
      stderr.end();
      void cleanup().finally(() => {
        if (error) rejectWorkerCompletion(error);
        else resolveWorkerCompletion(result!);
      });
    };

    const cancel = (error = new Error('Request cancelled')): void => {
      if (settled || cancellationError) return;
      cancellationError = error;
      if (!workerSocket || workerSocket.destroyed) {
        if (startupInProgress) return;
        finish(undefined, cancellationError);
        return;
      }
      workerSocket.write(`${JSON.stringify({ type: 'cancel' })}\n`);
      forceCancelTimeout = setTimeout(() => {
        void this.closeTrackedPane(paneId).then((closed) => {
          if (closed) finish(undefined, cancellationError);
        }).catch(() => undefined);
      }, 4_000);
    };

    server = createServer((socket) => {
      if (workerSocket || settled || cancellationError) {
        socket.destroy();
        return;
      }
      workerSocket = socket;
      let buffered = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        buffered += chunk;
        while (true) {
          const newline = buffered.indexOf('\n');
          if (newline < 0) break;
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (!line) continue;
          let event: HerdrWorkerEvent;
          try {
            event = JSON.parse(line) as HerdrWorkerEvent;
          } catch {
            finish(undefined, new Error('Herdr worker sent malformed protocol data.'));
            return;
          }
          if (event.type === 'ready') {
            if (startupTimeout) clearTimeout(startupTimeout);
            if (event.protocol !== HERDR_WORKER_PROTOCOL) {
              finish(undefined, new Error('Herdr worker protocol mismatch.'));
              return;
            }
            const start: HerdrWorkerStart = {
              type: 'start',
              protocol: HERDR_WORKER_PROTOCOL,
              command: request.command,
              args: request.args,
              cwd: request.cwd,
              env: Object.fromEntries(
                Object.entries(request.env).filter(
                  (entry): entry is [string, string] => entry[1] !== undefined,
                ),
              ),
              ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
            };
            socket.write(`${JSON.stringify(start)}\n`);
          } else if (event.type === 'stdout') {
            stdout.write(Buffer.from(event.data, 'base64'));
          } else if (event.type === 'stderr') {
            stderr.write(Buffer.from(event.data, 'base64'));
          } else if (event.type === 'error') {
            finish(undefined, new Error(`Herdr worker failed: ${event.message}`));
            return;
          } else if (event.type === 'exit') {
            if (cancellationError) finish(undefined, cancellationError);
            else {
              finish({
                exitCode: event.code,
                ...(event.signal ? { signal: event.signal } : {}),
                paneId,
                terminalState: event.code === 0 ? 'completed' : 'failed',
              });
            }
            return;
          }
        }
      });
      socket.once('error', (error) => finish(undefined, error));
      socket.once('close', () => {
        if (!settled) finish(undefined, new Error('Herdr worker disconnected before exit.'));
      });
    });

    try {
      await new Promise<void>((resolveListen, rejectListen) => {
        server!.once('error', rejectListen);
        server!.listen(socketPath, () => resolveListen());
      });
      server.on('error', () => {
        finish(undefined, new HerdrUnavailableError('Herdr worker IPC server failed.'));
      });
      await chmod(socketPath, 0o600);
    } catch {
      await cleanup().catch(() => undefined);
      throw new HerdrUnavailableError('Herdr worker IPC could not be initialized.');
    }

    const workerPath = this.config.workerPath
      ?? resolve(moduleDirectory, 'worker.js');
    startupTimeout = setTimeout(() => {
      cancel(new HerdrUnavailableError('Herdr worker did not connect before the startup deadline.'));
    }, this.config.commandTimeoutMs);
    timeout = setTimeout(() => {
      cancel(timeoutError);
    }, Math.max(0, workerDeadline - Date.now()));
    if (request.signal) {
      abortListener = () => {
        cancel();
      };
      request.signal.addEventListener('abort', abortListener, { once: true });
      if (request.signal.aborted) abortListener();
    }
    const assertStartupCanContinue = (): void => {
      if (cancellationError) throw cancellationError;
      if (Date.now() >= workerDeadline) {
        cancel(timeoutError);
        throw timeoutError;
      }
    };
    try {
      assertStartupCanContinue();
      await this.reportPane(paneId, sessionKey, request, 'working');
      assertStartupCanContinue();
      await this.command([
        'pane', 'run', paneId, process.execPath, workerPath, socketPath,
      ]);
      assertStartupCanContinue();
    } catch (error) {
      finish(undefined, error instanceof Error ? error : new Error(String(error)));
      await completion.catch(() => undefined);
      throw error;
    }

    startupInProgress = false;
    const handle = { stdout, stderr, paneId, completion, cancel: () => cancel() };
    return handle;
  }

  private async reportPane(
    paneId: string,
    sessionKey: string,
    request: ProviderExecutionRequest,
    state: 'working' | 'idle',
    terminalState?: 'completed' | 'failed' | 'timed_out' | 'cancelled',
  ): Promise<void> {
    if (
      state === 'idle'
      && !Array.from(this.panes.values()).some((pane) => pane.paneId === paneId)
    ) {
      return;
    }
    const message = state === 'working'
      ? `${request.model}`
      : `${request.model} complete`;
    let stateReported = false;
    let reportError: unknown;
    for (let attempt = 0; attempt < 3 && !stateReported; attempt++) {
      try {
        await this.command([
          'pane', 'report-agent', paneId,
          '--source', 'agent-proxy',
          '--agent', request.provider,
          '--state', state,
          '--message', message,
        ]);
        stateReported = true;
      } catch (error) {
        reportError = error;
        if (attempt < 2) {
          await new Promise((resolveDelay) => {
            setTimeout(resolveDelay, 100 * (attempt + 1));
          });
        }
      }
    }
    if (!stateReported) {
      if (state === 'idle' && await this.closeTrackedPane(paneId)) return;
      throw reportError instanceof Error
        ? reportError
        : new HerdrUnavailableError('Herdr pane state could not be reported.');
    }
    await this.command([
      'pane', 'report-metadata', paneId,
      '--source', 'agent-proxy',
      '--agent', request.provider,
      '--title', `${request.provider}: ${request.model}`,
      '--token', `provider=${request.provider}`,
      '--token', `model=${request.model}`,
      '--token', `session=${sessionKey}`,
      ...(request.requestId ? ['--token', `request=${request.requestId}`] : []),
      ...(terminalState ? ['--token', `terminal=${terminalState}`] : []),
    ]).catch(() => undefined);
  }

  private async closeTrackedPane(paneId: string): Promise<boolean> {
    const release = await this.mutex.acquire('__pane_capacity__');
    try {
      const entry = Array.from(this.panes.entries())
        .find(([, pane]) => pane.paneId === paneId);
      if (!entry) return false;
      const [sessionKey, pane] = entry;
      try {
        await this.command(['tab', 'close', pane.tabId]);
      } catch {
        return false;
      }
      this.panes.delete(sessionKey);
      this.reservedPaneIds.delete(paneId);
      for (const [identity, record] of this.sessionKeys) {
        if (record.key === sessionKey) this.sessionKeys.delete(identity);
      }
      return true;
    } finally {
      release();
    }
  }

  private async command<T = { type: string }>(args: string[]): Promise<T> {
    try {
      const { stdout } = await execFileAsync(this.config.binary, args, {
        timeout: this.config.commandTimeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      });
      if (!stdout.trim()) return {} as T;
      const envelope = JSON.parse(stdout) as HerdrEnvelope<T>;
      return envelope.result;
    } catch (error) {
      this.readinessCache = undefined;
      throw new HerdrUnavailableError(
        `Herdr command failed (${args.slice(0, 2).join(' ')}).`,
        { cause: error },
      );
    }
  }
}

export class UnavailableExecutionBackend implements ProviderExecutionBackend {
  async readiness(): Promise<HerdrReadiness> {
    return { ready: false, message: 'No Herdr execution backend was configured.' };
  }

  async start(): Promise<ProviderExecutionHandle> {
    throw new HerdrUnavailableError('No Herdr execution backend was configured.');
  }

  async shutdown(): Promise<void> {
    // Nothing to stop.
  }
}

function terminalStateForError(
  error: unknown,
): 'failed' | 'timed_out' | 'cancelled' {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes('timed out') || message.includes('timeout')) return 'timed_out';
  if (message.includes('cancel')) return 'cancelled';
  return 'failed';
}
