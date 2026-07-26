import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProviderConfigYaml } from '@agent-proxy/shared';
import {
  gracefulKill,
  terminateChildProcess,
  trackProcess,
} from '../providers/base-provider.js';
import { getProviderEnvironment } from '../utils/provider-env.js';

export const LOGIN_PROVIDERS = ['claude', 'codex', 'grok'] as const;
export type LoginProvider = typeof LOGIN_PROVIDERS[number];
export type ProviderLoginState =
  | 'checking'
  | 'authenticated'
  | 'unauthenticated'
  | 'waiting'
  | 'failed'
  | 'unavailable';

export interface ProviderLoginStatus {
  provider: LoginProvider;
  state: ProviderLoginState;
  authenticated: boolean;
  verificationUri?: string;
  userCode?: string;
  requiresCodeInput?: boolean;
  expiresAt?: string;
  message: string;
  lastCheckedAt: string;
}

interface LoginTask {
  child: ChildProcess;
  output: string;
  timeout: NodeJS.Timeout;
  codeSubmitted: boolean;
}

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

interface ProviderLoginManagerOptions {
  spawnProcess?: SpawnProcess;
  terminateProcess?: typeof terminateChildProcess;
}

const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const PROBE_TIMEOUT_MS = 20_000;
const STATUS_CACHE_MS = 10_000;
const MAX_LOGIN_OUTPUT = 64 * 1024;
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const OSC_PATTERN = /\x1B\][^\x07]*(?:\x07|\x1B\\)/g;

function nowIso(): string {
  return new Date().toISOString();
}

function status(
  provider: LoginProvider,
  state: ProviderLoginState,
  message: string,
  extra: Partial<ProviderLoginStatus> = {},
): ProviderLoginStatus {
  return {
    provider,
    state,
    authenticated: state === 'authenticated',
    message,
    lastCheckedAt: nowIso(),
    ...extra,
  };
}

function stripAnsi(value: string): string {
  return value.replace(OSC_PATTERN, '').replace(ANSI_PATTERN, '');
}

export function parseDeviceLoginOutput(
  provider: LoginProvider,
  output: string,
): { verificationUri?: string; userCode?: string } {
  const clean = stripAnsi(output);
  const urls = clean.match(/https:\/\/[^\s]+/g) ?? [];
  const verificationUri = provider === 'claude'
    ? urls.find((url) => url.startsWith('https://claude.com/cai/oauth/authorize'))
    : provider === 'codex'
      ? urls.find((url) => url.startsWith('https://auth.openai.com/codex/device'))
      : urls.find((url) => url.startsWith('https://accounts.x.ai/oauth2/device'));
  const code = provider === 'claude'
    ? undefined
    : provider === 'codex'
    ? clean.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/)?.[0]
    : clean.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
  return {
    ...(verificationUri ? { verificationUri } : {}),
    ...(code ? { userCode: code } : {}),
  };
}

export function classifyProviderLoginFailure(
  provider: LoginProvider,
  output: string,
): string {
  const clean = stripAnsi(output).toLowerCase();
  const label = provider === 'claude'
    ? 'Claude'
    : provider === 'codex'
      ? 'Codex'
      : 'Grok';
  if (/not logged in|sign in|required.*auth|unauthenticated|no cached/.test(clean)) {
    return `${label} is not logged in. Start a new login.`;
  }
  if (/expired|invalid.*token|refresh.*fail|unauthorized|401/.test(clean)) {
    return `${label} login expired. Start a new login.`;
  }
  if (/enotfound|connection refused|timed out|network|dns|unreachable/.test(clean)) {
    return `${label} could not reach its authentication service. Check network access and retry.`;
  }
  return `${label} login could not be verified. Start a new login.`;
}

function reportsUnauthenticated(output: string): boolean {
  const clean = stripAnsi(output).toLowerCase();
  return /not logged in|\bsign in\b|required.*auth|unauthenticated|no cached|expired|invalid.*token|unauthorized|\b401\b/.test(
    clean,
  );
}

function actionArgs(provider: LoginProvider, action: 'probe' | 'login'): string[] {
  if (provider === 'claude') {
    return action === 'probe'
      ? ['auth', 'status', '--json']
      : ['auth', 'login', '--claudeai'];
  }
  if (provider === 'codex') {
    return action === 'probe' ? ['login', 'status'] : ['login', '--device-auth'];
  }
  return action === 'probe' ? ['models'] : ['login', '--device-auth'];
}

export function hasGrokCredential(
  environment: NodeJS.ProcessEnv,
  fileExists: (path: string) => boolean = existsSync,
): boolean {
  if (environment.XAI_API_KEY || environment.GROK_API_KEY) return true;
  const home = environment.HOME;
  return Boolean(home && fileExists(resolve(home, '.grok', 'auth.json')));
}

export class ProviderLoginManager {
  private readonly statuses = new Map<LoginProvider, ProviderLoginStatus>();
  private readonly tasks = new Map<LoginProvider, LoginTask>();
  private readonly probes = new Map<LoginProvider, Promise<ProviderLoginStatus>>();
  private readonly operationGenerations = new Map<LoginProvider, number>();
  private readonly spawnProcess: SpawnProcess;
  private readonly terminateProcess: typeof terminateChildProcess;

  constructor(
    private readonly configs: Record<string, ProviderConfigYaml>,
    options: ProviderLoginManagerOptions = {},
  ) {
    this.spawnProcess = options.spawnProcess ?? spawn as SpawnProcess;
    this.terminateProcess = options.terminateProcess ?? terminateChildProcess;
    for (const provider of LOGIN_PROVIDERS) {
      this.operationGenerations.set(provider, 0);
      this.statuses.set(
        provider,
        status(provider, 'checking', 'Checking login status.'),
      );
    }
  }

  private advanceOperation(provider: LoginProvider): number {
    const generation = (this.operationGenerations.get(provider) ?? 0) + 1;
    this.operationGenerations.set(provider, generation);
    return generation;
  }

  private config(provider: LoginProvider): ProviderConfigYaml | undefined {
    return this.configs[provider];
  }

  private spawn(
    provider: LoginProvider,
    args: string[],
    requiresInput = false,
  ): ChildProcess {
    const config = this.config(provider);
    if (!config?.cli_path) {
      throw new Error(`${provider} executable is not configured.`);
    }
    const env = {
      ...getProviderEnvironment(provider),
      NO_COLOR: '1',
      TERM: 'dumb',
    };
    const child = this.spawnProcess(config.cli_path, args, {
      cwd: config.working_dir ?? process.env.HOME ?? process.cwd(),
      env,
      stdio: [requiresInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    child.stdin?.on('error', () => {
      // A login CLI can close stdin before an authorization code is submitted.
      // Keep the stream error from becoming an uncaught process-level event.
    });
    trackProcess(child, process.platform !== 'win32');
    return child;
  }

  private cached(provider: LoginProvider): ProviderLoginStatus | undefined {
    const current = this.statuses.get(provider);
    if (!current) return undefined;
    if (current.state === 'checking') return undefined;
    if (current.state === 'waiting') return current;
    const checkedAt = Date.parse(current.lastCheckedAt);
    if (Number.isFinite(checkedAt) && Date.now() - checkedAt < STATUS_CACHE_MS) {
      return current;
    }
    return undefined;
  }

  async getStatus(provider: LoginProvider, force = false): Promise<ProviderLoginStatus> {
    if (!force) {
      const cached = this.cached(provider);
      if (cached) return cached;
    }
    const task = this.tasks.get(provider);
    if (task) return this.statuses.get(provider)!;
    const activeProbe = this.probes.get(provider);
    if (activeProbe) return activeProbe;

    const generation = this.advanceOperation(provider);
    const probe = this.runProbe(provider, generation).finally(() => {
      this.probes.delete(provider);
    });
    this.probes.set(provider, probe);
    return probe;
  }

  async getAll(force = false): Promise<ProviderLoginStatus[]> {
    return Promise.all(LOGIN_PROVIDERS.map((provider) => this.getStatus(provider, force)));
  }

  private async runProbe(
    provider: LoginProvider,
    generation: number,
  ): Promise<ProviderLoginStatus> {
    const config = this.config(provider);
    if (!config?.cli_path) {
      const next = status(provider, 'unavailable', `${provider} executable is not configured.`);
      this.statuses.set(provider, next);
      return next;
    }

    const checking = status(provider, 'checking', 'Checking login status.');
    this.statuses.set(provider, checking);
    if (
      provider === 'grok'
      && !hasGrokCredential(getProviderEnvironment(provider))
    ) {
      const next = status(
        provider,
        'unauthenticated',
        'Grok is not logged in. Start a new login.',
      );
      this.statuses.set(provider, next);
      return next;
    }

    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = this.spawn(provider, actionArgs(provider, 'probe'));
      } catch {
        const next = status(provider, 'unavailable', `${provider} executable is unavailable.`);
        this.statuses.set(provider, next);
        resolve(next);
        return;
      }

      let output = '';
      let settled = false;
      const append = (chunk: Buffer) => {
        if (output.length < MAX_LOGIN_OUTPUT) {
          output += chunk.toString('utf8').slice(0, MAX_LOGIN_OUTPUT - output.length);
        }
      };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);
      const finish = (next: ProviderLoginStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (this.operationGenerations.get(provider) !== generation) {
          resolve(this.statuses.get(provider) ?? next);
          return;
        }
        const activeLogin = this.tasks.get(provider)
          ? this.statuses.get(provider)
          : undefined;
        if (activeLogin?.state === 'waiting') {
          resolve(activeLogin);
          return;
        }
        this.statuses.set(provider, next);
        resolve(next);
      };
      const timeout = setTimeout(() => {
        gracefulKill(child);
        finish(status(
          provider,
          'failed',
          `${provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : 'Grok'} login check timed out.`,
        ));
      }, PROBE_TIMEOUT_MS);
      timeout.unref();

      child.on('error', () => {
        finish(status(provider, 'unavailable', `${provider} executable is unavailable.`));
      });
      child.on('close', (code) => {
        if (code === 0) {
          if (reportsUnauthenticated(output)) {
            finish(status(
              provider,
              'unauthenticated',
              classifyProviderLoginFailure(provider, output),
            ));
            return;
          }
          finish(status(
            provider,
            'authenticated',
            `${provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : 'Grok'} subscription login is ready.`,
          ));
          return;
        }
        const message = classifyProviderLoginFailure(provider, output);
        const loginFailure = /not logged in|login expired/.test(message.toLowerCase());
        finish(status(provider, loginFailure ? 'unauthenticated' : 'failed', message));
      });
    });
  }

  start(provider: LoginProvider): ProviderLoginStatus {
    const existing = this.tasks.get(provider);
    if (existing) return this.statuses.get(provider)!;
    this.advanceOperation(provider);

    let child: ChildProcess;
    try {
      child = this.spawn(
        provider,
        actionArgs(provider, 'login'),
        provider === 'claude',
      );
    } catch {
      const next = status(provider, 'unavailable', `${provider} executable is unavailable.`);
      this.statuses.set(provider, next);
      return next;
    }

    const waiting = status(
      provider,
      'waiting',
      'Waiting for login instructions.',
      { expiresAt: new Date(Date.now() + LOGIN_TIMEOUT_MS).toISOString() },
    );
    this.statuses.set(provider, waiting);

    const task: LoginTask = {
      child,
      output: '',
      timeout: setTimeout(() => {
        gracefulKill(child);
        this.tasks.delete(provider);
        this.statuses.set(provider, status(
          provider,
          'failed',
          'Device login expired. Start a new login.',
        ));
      }, LOGIN_TIMEOUT_MS),
      codeSubmitted: false,
    };
    task.timeout.unref();
    this.tasks.set(provider, task);

    const append = (chunk: Buffer) => {
      if (this.tasks.get(provider) !== task) return;
      if (task.output.length < MAX_LOGIN_OUTPUT) {
        task.output += chunk.toString('utf8').slice(0, MAX_LOGIN_OUTPUT - task.output.length);
      }
      const parsed = parseDeviceLoginOutput(provider, task.output);
      if (!parsed.verificationUri && !parsed.userCode) return;
      const current = this.statuses.get(provider) ?? waiting;
      this.statuses.set(provider, {
        ...current,
        ...parsed,
        ...(provider === 'claude' && parsed.verificationUri && !task.codeSubmitted
          ? { requiresCodeInput: true }
          : {}),
        message: provider === 'claude' && parsed.verificationUri && !task.codeSubmitted
          ? 'Open the authorization URL, then paste the returned code here.'
          : parsed.verificationUri && parsed.userCode
            ? 'Open the verification URL and enter the displayed code.'
            : current.message,
        lastCheckedAt: nowIso(),
      });
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', () => {
      if (this.tasks.get(provider) !== task) return;
      clearTimeout(task.timeout);
      this.tasks.delete(provider);
      this.statuses.set(provider, status(
        provider,
        'unavailable',
        `${provider} executable is unavailable.`,
      ));
    });
    child.on('close', (code) => {
      if (this.tasks.get(provider) !== task) return;
      clearTimeout(task.timeout);
      this.tasks.delete(provider);
      if (code === 0) {
        this.statuses.set(provider, status(
          provider,
          'authenticated',
          `${provider === 'claude' ? 'Claude' : provider === 'codex' ? 'Codex' : 'Grok'} subscription login is ready.`,
        ));
        return;
      }
      this.statuses.set(provider, status(
        provider,
        'failed',
        classifyProviderLoginFailure(provider, task.output),
      ));
    });

    return waiting;
  }

  submitCode(provider: LoginProvider, code: string): ProviderLoginStatus {
    if (provider !== 'claude') {
      throw new Error('This provider does not accept an authorization code.');
    }
    const task = this.tasks.get(provider);
    if (!task || !task.child.stdin?.writable) {
      throw new Error('No Claude login is waiting for an authorization code.');
    }
    const normalized = code.trim();
    if (!normalized || normalized.length > 4096 || /[\r\n\0]/.test(normalized)) {
      throw new Error('Enter the one-time authorization code returned by Claude.');
    }
    task.codeSubmitted = true;
    try {
      task.child.stdin.write(`${normalized}\n`);
    } catch {
      task.codeSubmitted = false;
      throw new Error('Claude login stopped accepting the authorization code. Start a new login.');
    }
    const current = this.statuses.get(provider)!;
    const next = {
      ...current,
      requiresCodeInput: false,
      message: 'Completing Claude login.',
      lastCheckedAt: nowIso(),
    };
    this.statuses.set(provider, next);
    return next;
  }

  cancel(provider: LoginProvider): ProviderLoginStatus {
    this.advanceOperation(provider);
    const task = this.tasks.get(provider);
    if (!task) {
      return this.statuses.get(provider)
        ?? status(provider, 'unauthenticated', 'No login in progress.');
    }
    clearTimeout(task.timeout);
    this.tasks.delete(provider);
    gracefulKill(task.child);
    const next = status(provider, 'unauthenticated', 'Device login was cancelled.');
    this.statuses.set(provider, next);
    return next;
  }

  async stopAll(): Promise<void> {
    for (const provider of LOGIN_PROVIDERS) {
      this.advanceOperation(provider);
    }
    const tasks = [...this.tasks.values()];
    this.tasks.clear();
    for (const task of tasks) {
      clearTimeout(task.timeout);
    }
    await Promise.allSettled(
      tasks.map((task) => this.terminateProcess(task.child)),
    );
  }
}
