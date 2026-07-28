import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, resolve } from 'node:path';
import type {
  ExecuteOptions,
  ExecuteResult,
  EmbeddingOptions,
  EmbeddingResult,
  TtsOptions,
  TtsResult,
  ProviderEvent,
  TokenUsage,
  HealthStatus,
  ProviderConfigYaml,
  EndpointType,
  StreamParser,
} from '@agent-proxy/shared';
import { streamChunkToEvents } from '@agent-proxy/shared';
import { parse as parseToml } from 'smol-toml';
import { getParserForProvider } from '../utils/stream-transformer.js';
import { getProviderEnvironment } from '../utils/provider-env.js';
import {
  UnavailableExecutionBackend,
  type ProviderExecutionBackend,
} from '../herdr/launcher.js';


const activeProcesses = new Set<ChildProcess>();
const processGroupChildren = new WeakSet<ChildProcess>();

export function trackProcess(child: ChildProcess, terminateProcessGroup = false): void {
  activeProcesses.add(child);
  if (terminateProcessGroup) processGroupChildren.add(child);
  child.on('close', () => activeProcesses.delete(child));
  child.on('error', () => activeProcesses.delete(child));
}

export async function killAllChildProcesses(timeoutMs = 3_000): Promise<void> {
  const children = Array.from(activeProcesses);
  await Promise.allSettled(children.map((child) => terminateChildProcess(child, timeoutMs)));
}

export function getActiveProcessCount(): number {
  return activeProcesses.size;
}

export function resolveProxyPort(
  value = process.env.AGENT_PROXY_PORT,
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535
    ? parsed
    : 8300;
}

export abstract class BaseProvider {
  abstract readonly name: string;

  readonly requiresHerdr: boolean = true;

  readonly endpointTypes: readonly EndpointType[] = ['chat'];

  protected config: ProviderConfigYaml;
  protected parser: StreamParser;
  protected readonly executionBackend: ProviderExecutionBackend;
  private readonly proxyPort: number;

  constructor(
    config: ProviderConfigYaml,
    executionBackend: ProviderExecutionBackend = new UnavailableExecutionBackend(),
    proxyPort = resolveProxyPort(),
  ) {
    this.config = config;
    this.executionBackend = executionBackend;
    this.proxyPort = resolveProxyPort(String(proxyPort));
    this.parser = null!;
  }


  updateConfig(partial: Partial<ProviderConfigYaml>): void {
    Object.assign(this.config, partial);
  }

  getConfig(): ProviderConfigYaml {
    return { ...this.config };
  }

  async shutdown(): Promise<void> {
    // Most providers only own request-scoped processes, which are handled by
    // the global process registry after the bounded request drain.
  }

  protected initParser() {
    this.parser = getParserForProvider(this.name);
  }


  protected abstract buildArgs(options: ExecuteOptions): string[];




  protected getStdinData(_options: ExecuteOptions): string | undefined {
    return undefined;
  }


  private fullCommand(args: string[]): string[] {
    return [this.config.cli_path, ...args];
  }


  async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const args = this.buildArgs({ ...options, stream: false });
    const stdinData = this.getStdinData({ ...options, stream: false });
    const { stdout, stderr, exitCode } = await this.runProcess(args, options, stdinData);

    if (exitCode !== 0) {
      options.onDebug?.({ cliArgs: this.fullCommand(args), stdout, stderr });
      throw new Error(`${this.name} CLI exited with code ${exitCode}: ${stderr}`);
    }

    options.onDebug?.({ cliArgs: this.fullCommand(args), stdout, stderr });
    return this.parseNonStreamOutput(stdout);
  }


  async *executeStream(options: ExecuteOptions): AsyncIterable<ProviderEvent> {
    const args = this.buildArgs({ ...options, stream: true });
    const stdinData = this.getStdinData({ ...options, stream: true });
    const handle = await this.startProcess(args, options, stdinData);
    const stderrChunks: Buffer[] = [];
    handle.stderr.on('data', (data: Buffer) => stderrChunks.push(data));

    const debugLines: string[] = [];
    const captureDebug = !!options.onDebug;
    let terminalEventSeen = false;
    let pendingDoneEvent: ProviderEvent | undefined;
    let completionObserved = false;

    try {
      const rl = createInterface({ input: handle.stdout });

      for await (const line of rl) {
        if (captureDebug) debugLines.push(line);
        if (terminalEventSeen) continue;
        if (this.parser.parseEvents) {
          const events = this.parser.parseEvents(line);
          for (const event of events) {
            if (event.type === 'done') {
              terminalEventSeen = true;
              pendingDoneEvent = event;
            } else if (!terminalEventSeen) {
              yield event;
            }
          }
        } else {
          const chunk = this.parser.parse(line);
          if (chunk) {
            const events = streamChunkToEvents(chunk);
            for (const event of events) {
              if (event.type === 'done') {
                terminalEventSeen = true;
                pendingDoneEvent = event;
              } else if (!terminalEventSeen) {
                yield event;
              }
            }
          }
        }
      }
      const result = await handle.completion.then(
        (completed) => {
          completionObserved = true;
          return completed;
        },
        (error: unknown) => {
          completionObserved = true;
          throw error;
        },
      );
      if (result.exitCode !== 0) {
        throw new Error(
          `${this.name} CLI exited with code ${result.exitCode}: ${
            Buffer.concat(stderrChunks).toString('utf8')
          }`,
        );
      }
      if (pendingDoneEvent) yield pendingDoneEvent;
    } finally {
      if (!completionObserved) {
        handle.cancel();
        await handle.completion.catch(() => undefined);
      }
      if (captureDebug) {
        options.onDebug!({ cliArgs: this.fullCommand(args), streamLines: debugLines });
      }
    }
  }


  async executeEmbedding(_options: EmbeddingOptions): Promise<EmbeddingResult> {
    throw new Error(`${this.name} does not support embeddings`);
  }


  async executeTts(_options: TtsOptions): Promise<TtsResult> {
    throw new Error(`${this.name} does not support text-to-speech`);
  }


  async checkHealth(): Promise<HealthStatus> {
    return await executableAvailable(this.config.cli_path, this.workingDir)
      ? 'healthy'
      : 'unhealthy';
  }



  protected getCleanEnv(): Record<string, string | undefined> {
    return getProviderEnvironment(this.name);
  }

  protected get workingDir(): string {
    return this.config.working_dir ?? tmpdir();
  }

  protected async runProcess(
    args: string[],
    options: ExecuteOptions,
    stdinData?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const handle = await this.startProcess(args, options, stdinData);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    handle.stdout.on('data', (data: Buffer) => stdoutChunks.push(data));
    handle.stderr.on('data', (data: Buffer) => stderrChunks.push(data));
    const result = await handle.completion;
    return {
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      exitCode: result.exitCode,
    };
  }

  private startProcess(
    args: string[],
    options: ExecuteOptions,
    stdinData?: string,
  ) {
    const config = this.getExecutionConfig(options);
    const environment = this.getCleanEnv();
    const recursionCheck = assertNoProxyRecursion(
      this.name,
      environment,
      this.proxyPort,
      this.getRecursionCheckArgs(options, args),
    );
    return recursionCheck.then(() => this.executionBackend.start({
      provider: this.name,
      model: options.model || config.default_model,
      ...(options.requestId ? { requestId: options.requestId } : {}),
      clientKey: options.clientKey && (
        options.clientKey.includes('|session:')
        || options.clientKey.includes('|request:')
      )
        ? options.clientKey
        : `request:${randomUUID()}`,
      command: config.cli_path,
      args,
      cwd: config.working_dir ?? tmpdir(),
      env: environment,
      ...(stdinData !== undefined ? { stdin: stdinData } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      timeoutMs: config.timeout_ms,
    }));
  }

  protected getExecutionConfig(_options: ExecuteOptions): ProviderConfigYaml {
    return this.config;
  }

  protected getRecursionCheckArgs(_options: ExecuteOptions, args: string[]): string[] {
    return args;
  }


  protected parseNonStreamOutput(stdout: string): ExecuteResult {

    const lines = stdout.trim().split('\n');
    const contentParts: string[] = [];
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    if (this.parser.parseEvents) {
      for (const line of lines) {
        const events = this.parser.parseEvents(line);
        for (const event of events) {
          if (event.type === 'text_delta') contentParts.push(event.text);
          if (event.type === 'usage') usage = event.usage;
        }
      }
    } else {
      for (const line of lines) {
        const chunk = this.parser.parse(line);
        if (chunk?.type === 'delta' && chunk.content) {
          contentParts.push(chunk.content);
        }
        if (chunk?.type === 'done' && chunk.usage) {
          usage = chunk.usage;
        }
      }
    }

    const content = contentParts.join('');


    if (usage.totalTokens === 0) {
      usage = estimateTokens(content);
    }

    return {
      content,
      usage,
      finishReason: 'stop',
    };
  }
}

async function executableAvailable(command: string, workingDirectory: string): Promise<boolean> {
  const pathValue = process.env.PATH ?? '';
  const candidates = command.includes('/')
    ? [isAbsolute(command) ? command : resolve(workingDirectory, command)]
    : pathValue.split(delimiter).filter(Boolean).map((entry) => resolve(entry, command));
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      await access(candidate, fsConstants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }
  return false;
}

class ProviderRecursionError extends Error {
  readonly code = 'provider_recursion';
}

async function assertNoProxyRecursion(
  provider: string,
  environment: Record<string, string | undefined>,
  proxyPort: number,
  args: string[],
): Promise<void> {
  for (const argument of args) {
    for (const candidate of argument.match(/https?:\/\/[^\s"'<>]+/gi) ?? []) {
      if (isProxyLoopbackUrl(candidate, proxyPort)) {
        throw new ProviderRecursionError(
          `${provider} arguments route provider traffic back to agent-proxy on loopback port ${proxyPort}.`,
        );
      }
    }
  }

  const home = environment.HOME;
  if (!home) return;
  const configPath = provider === 'codex'
    ? resolve(environment.CODEX_HOME ?? resolve(home, '.codex'), 'config.toml')
    : provider === 'grok'
      ? resolve(home, '.grok', 'config.toml')
      : undefined;
  if (!configPath) return;
  let config: string;
  try {
    config = await readFile(configPath, 'utf8');
  } catch {
    return;
  }
  const port = String(proxyPort);
  const baseUrls = provider === 'codex'
    ? activeCodexBaseUrls(config, args)
    : activeGrokBaseUrls(config, args);
  for (const baseUrl of baseUrls) {
    if (isProxyLoopbackUrl(baseUrl, proxyPort)) {
      throw new ProviderRecursionError(
        `${provider} configuration routes provider traffic back to agent-proxy on loopback port ${port}.`,
      );
    }
  }
}

function isProxyLoopbackUrl(value: string, proxyPort: number): boolean {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const isLoopback = hostname === 'localhost'
      || hostname === 'localhost.localdomain'
      || hostname === 'ip6-localhost'
      || hostname === '::1'
      || hostname === '0.0.0.0'
      || hostname === '::'
      || /^127(?:\.\d{1,3}){3}$/.test(hostname);
    const effectivePort = url.port || (url.protocol === 'https:' ? '443' : '80');
    return isLoopback && effectivePort === String(proxyPort);
  } catch {
    return false;
  }
}

function activeCodexBaseUrls(config: string, args: string[]): string[] {
  const parsed = parseTomlConfig(config);
  if (args.includes('--oss') || optionValue(args, '', '--local-provider')) {
    return [];
  }
  const profile = optionValue(args, '-p', '--profile');
  const activeProvider = configOverride(args, 'model_provider')
    ?? (profile ? nestedString(parsed, ['profiles', profile, 'model_provider']) : undefined)
    ?? nestedString(parsed, ['model_provider']);
  if (!activeProvider) return [];
  const baseUrl = nestedString(parsed, ['model_providers', activeProvider, 'base_url']);
  return baseUrl ? [baseUrl] : [];
}

function activeGrokBaseUrls(config: string, args: string[]): string[] {
  const parsed = parseTomlConfig(config);
  const selectedModel = optionValue(args, '-m', '--model')
    ?? nestedString(parsed, ['models', 'default']);
  if (!selectedModel) return [];
  const baseUrl = nestedString(parsed, ['model', selectedModel, 'base_url']);
  return baseUrl ? [baseUrl] : [];
}

function parseTomlConfig(config: string): Record<string, unknown> {
  try {
    return parseToml(config) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function nestedString(
  root: Record<string, unknown>,
  path: string[],
): string | undefined {
  let value: unknown = root;
  for (const segment of path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return typeof value === 'string' ? value : undefined;
}

function configOverride(args: string[], key: string): string | undefined {
  for (let index = args.length - 1; index >= 0; index--) {
    const argument = args[index];
    const candidate = (argument === '-c' || argument === '--config')
      ? args[index + 1]
      : argument.startsWith('-c=')
        ? argument.slice(3)
        : argument.startsWith('--config=')
          ? argument.slice('--config='.length)
          : undefined;
    if (!candidate) continue;
    const match = new RegExp(`^${key}\\s*=\\s*["']?([^"']+)["']?$`).exec(candidate);
    if (match) return match[1].trim();
  }
  return undefined;
}

function optionValue(args: string[], shortName: string, longName: string): string | undefined {
  for (let index = args.length - 1; index >= 0; index--) {
    const argument = args[index];
    if (argument === shortName || argument === longName) return args[index + 1];
    if (argument.startsWith(`${longName}=`)) return argument.slice(longName.length + 1);
  }
  return undefined;
}

export function gracefulKill(child: ChildProcess, timeoutMs = 3000): void {
  void terminateChildProcess(child, timeoutMs);
}

export async function terminateChildProcess(
  child: ChildProcess,
  timeoutMs = 3_000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    activeProcesses.delete(child);
    return;
  }

  if (
    process.platform !== 'win32'
    && processGroupChildren.has(child)
    && child.pid
  ) {
    await terminateProcessGroup(child.pid, timeoutMs);
    activeProcesses.delete(child);
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      if (exitTimer) clearTimeout(exitTimer);
      activeProcesses.delete(child);
      resolve();
    };
    const killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          signalChild(child, 'SIGKILL');
        } catch {
          finish();
          return;
        }
      }
      exitTimer = setTimeout(finish, 1_000);
    }, timeoutMs);

    child.once('exit', finish);
    child.once('error', finish);
    try {
      signalChild(child, 'SIGTERM');
    } catch {
      finish();
    }
  });
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && processGroupChildren.has(child) && child.pid) {
    process.kill(-child.pid, signal);
    return;
  }
  child.kill(signal);
}

async function terminateProcessGroup(
  processGroupId: number,
  timeoutMs: number,
): Promise<void> {
  try {
    process.kill(-processGroupId, 'SIGTERM');
  } catch {
    return;
  }

  if (await waitForProcessGroupExit(processGroupId, timeoutMs)) {
    return;
  }

  try {
    process.kill(-processGroupId, 'SIGKILL');
  } catch {
    return;
  }
  await waitForProcessGroupExit(processGroupId, 1_000);
}

function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      try {
        process.kill(-processGroupId, 0);
      } catch {
        resolve(true);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}


function estimateTokens(text: string): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} {
  const completionTokens = Math.ceil(text.length / 4);
  return {
    promptTokens: 0,
    completionTokens,
    totalTokens: completionTokens,
  };
}
