import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
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
import { getParserForProvider } from '../utils/stream-transformer.js';
import { getProviderEnvironment } from '../utils/provider-env.js';


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

export abstract class BaseProvider {
  abstract readonly name: string;


  readonly endpointTypes: readonly EndpointType[] = ['chat'];

  protected config: ProviderConfigYaml;
  protected parser: StreamParser;

  constructor(config: ProviderConfigYaml) {
    this.config = config;

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
    const { stdout, stderr, exitCode } = await this.runProcess(args, options.signal, undefined, stdinData);

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
    const child = this.spawnProcess(args);

    if (stdinData) {
      child.stdin?.write(stdinData);
    }
    child.stdin?.end();

    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        gracefulKill(child);
      }, { once: true });
    }

    const timeout = setTimeout(() => {
      gracefulKill(child);
    }, this.config.timeout_ms);

    const debugLines: string[] = [];
    const captureDebug = !!options.onDebug;

    try {
      const rl = createInterface({ input: child.stdout! });

      for await (const line of rl) {
        if (captureDebug) debugLines.push(line);


        if (this.parser.parseEvents) {
          const events = this.parser.parseEvents(line);
          for (const event of events) {
            yield event;
            if (event.type === 'done') return;
          }
        } else {
          const chunk = this.parser.parse(line);
          if (chunk) {
            const events = streamChunkToEvents(chunk);
            for (const event of events) {
              yield event;
            }
            if (chunk.type === 'done') return;
          }
        }
      }
    } finally {
      clearTimeout(timeout);
      gracefulKill(child);
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
    try {
      const { exitCode } = await this.runProcess(['--version'], undefined, 10_000);
      return exitCode === 0 ? 'healthy' : 'unhealthy';
    } catch {
      return 'unhealthy';
    }
  }



  protected getCleanEnv(): Record<string, string | undefined> {
    return getProviderEnvironment(this.name);
  }

  protected get workingDir(): string {
    return this.config.working_dir ?? tmpdir();
  }

  protected spawnProcess(args: string[]): ChildProcess {

    const isWin = process.platform === 'win32';
    const child = spawn(this.config.cli_path, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.getCleanEnv(),
      cwd: this.workingDir,
      shell: isWin,
      detached: !isWin,
    });
    trackProcess(child, !isWin);
    return child;
  }

  private async runProcess(
    args: string[],
    signal?: AbortSignal,
    timeoutMs?: number,
    stdinData?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(args);

      if (stdinData) {
        child.stdin?.write(stdinData);
      }
      child.stdin?.end();
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const timeout = setTimeout(() => {
        gracefulKill(child);
        reject(new Error(`${this.name} CLI timed out after ${timeoutMs ?? this.config.timeout_ms}ms`));
      }, timeoutMs ?? this.config.timeout_ms);

      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timeout);
          gracefulKill(child);
          reject(new Error('Request cancelled'));
        }, { once: true });
      }

      child.stdout?.on('data', (data: Buffer) => stdoutChunks.push(data));
      child.stderr?.on('data', (data: Buffer) => stderrChunks.push(data));

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to spawn ${this.name} CLI: ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
          stderr: Buffer.concat(stderrChunks).toString('utf-8'),
          exitCode: code ?? 1,
        });
      });
    });
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
