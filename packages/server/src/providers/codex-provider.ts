import type { ExecuteOptions, ExecuteResult, ProviderEvent, ProviderConfigYaml, HealthStatus } from '@agent-proxy/shared';
import { BaseProvider } from './base-provider.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';
import { prepareCodexPrompt } from '../utils/image-extractor.js';
import { CodexAppServerProcess, type CodexAppServerProcessConfig } from './codex-appserver-process.js';
import { CodexAppServerSessionManager } from './codex-appserver-session-manager.js';
import { executeAppServer, executeStreamAppServer, type AppServerExecutorConfig, type AppServerMeta } from './codex-appserver-executor.js';
import { CodexCliSessionManager } from './codex-cli-session-manager.js';
import { mergeProviderConfig } from './provider-override.js';
import { unlink } from 'node:fs/promises';

interface CodexExecuteContext {
  text: string;
  imageFiles: string[];
}

interface CodexExecuteOptions extends ExecuteOptions {
  __codexPrompt?: CodexExecuteContext;
}




const RESUME_UNSUPPORTED_FLAGS_WITH_VALUE = new Set([
  '-s', '--sandbox',
  '-C', '--cd',
  '--add-dir',
  '-p', '--profile',
  '--local-provider',
  '--output-schema',
  '--color',
]);
const RESUME_UNSUPPORTED_FLAGS_STANDALONE = new Set([
  '--oss',
]);



const THREAD_ID_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export function extractThreadIdFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const data = JSON.parse(trimmed);
    if (!data || data.type !== 'thread.started') return null;
    const candidate = typeof data.thread_id === 'string' ? data.thread_id
      : typeof data.threadId === 'string' ? data.threadId
      : (data.thread && typeof data.thread.id === 'string') ? data.thread.id
      : null;
    if (candidate && THREAD_ID_UUID_RE.test(candidate)) return candidate;
  } catch { }
  return null;
}

export function filterResumeUnsupportedArgs(args: string[]): string[] {
  const result: string[] = [];
  let skipNext = false;
  for (const arg of args) {
    if (skipNext) { skipNext = false; continue; }

    const eqIdx = arg.indexOf('=');
    const flagPart = eqIdx >= 0 ? arg.slice(0, eqIdx) : arg;
    if (RESUME_UNSUPPORTED_FLAGS_WITH_VALUE.has(flagPart)) {

      if (eqIdx < 0) skipNext = true;
      continue;
    }
    if (RESUME_UNSUPPORTED_FLAGS_STANDALONE.has(flagPart)) continue;
    result.push(arg);
  }
  return result;
}

export class CodexProvider extends BaseProvider {
  readonly name = 'codex' as const;


  private appServerProcess: CodexAppServerProcess | null = null;
  private appServerSessionManager: CodexAppServerSessionManager | null = null;

  private cliSessionManager: CodexCliSessionManager | null = null;

  private warnedEphemeralForceAlias = new Set<string>();

  constructor(config: ProviderConfigYaml) {
    super(config);
    this.initParser();


    if (this.isAppServerMode) {
      this.initAppServer();
    }
  }

  private get isAppServerMode(): boolean {
    return this.config.mode === 'app-server';
  }




  getEffectiveConfig(options: ExecuteOptions): ProviderConfigYaml {
    const merged = mergeProviderConfig(this.config, options.providerOverrides, 'codex');
    const cli = merged.cli_options;
    if (cli?.enable_session_reuse === true && cli?.ephemeral !== false) {
      const aliasKey = options.model || this.config.default_model || '<default>';
      if (!this.warnedEphemeralForceAlias.has(aliasKey)) {
        this.warnedEphemeralForceAlias.add(aliasKey);
        const reason = cli.ephemeral === true ? 'explicitly true' : 'defaulting to true';
        console.warn(`[codex] cli_options.ephemeral disabled because enable_session_reuse is true (was ${reason}, model: ${aliasKey})`);
      }
      merged.cli_options = { ...cli, ephemeral: false };
    }
    return merged;
  }



  private ensureCliSessionManager(ttlMs?: number): CodexCliSessionManager {
    if (!this.cliSessionManager) {
      this.cliSessionManager = new CodexCliSessionManager(ttlMs);
    }
    return this.cliSessionManager;
  }


  getCliSessionManager(): CodexCliSessionManager | null {
    return this.cliSessionManager;
  }



  private initAppServer(): void {
    const options = this.config.app_server_options ?? {};
    const ttl = options.session_ttl_ms;

    const processConfig: CodexAppServerProcessConfig = {
      cliPath: this.config.cli_path,
      options,
      env: this.getCleanEnv(),
      workingDir: this.workingDir,
    };

    this.appServerProcess = new CodexAppServerProcess(processConfig);
    this.appServerProcess.start().catch((err) => {
      console.error('[codex] app-server initial start failed:', err.message);
    });

    if (options.enable_session_reuse !== false) {
      this.appServerSessionManager = new CodexAppServerSessionManager(ttl);
    }
  }

  private destroyAppServer(): void {
    this.appServerProcess?.stop().catch(() => { });
    this.appServerProcess = null;
    this.appServerSessionManager?.destroy();
    this.appServerSessionManager = null;
  }


  destroyCliSessionManager(): void {
    this.cliSessionManager?.destroy();
    this.cliSessionManager = null;
    this.warnedEphemeralForceAlias.clear();
  }

  private buildAppServerConfig(options: ExecuteOptions): AppServerExecutorConfig {
    return {
      model: options.model || this.config.default_model,
      options: this.config.app_server_options ?? {},
      process: this.appServerProcess!,
      sessionManager: this.appServerSessionManager ?? undefined,
      clientKey: options.clientKey,
      timeoutMs: this.config.timeout_ms,
    };
  }

  private appServerDebugArgs(model: string, meta?: AppServerMeta): string[] {
    const args = ['[app-server]', `model=${model}`];
    if (meta) {
      args.push(`thread=${meta.threadId ?? 'none'}`);
      args.push(`reused=${meta.threadReused}`);
      if (meta.retried) args.push('retried=true');
    }
    return args;
  }




  protected override getStdinData(options: ExecuteOptions): string {
    const ctx = (options as CodexExecuteOptions).__codexPrompt;
    if (ctx) return ctx.text;
    return convertMessagesToSinglePrompt(options.messages);
  }

  protected buildArgs(options: ExecuteOptions): string[] {
    const effective = this.getEffectiveConfig(options);
    const model = options.model || effective.default_model;
    const ctx = (options as CodexExecuteOptions).__codexPrompt;


    let resumeThreadId: string | null = null;
    if (effective.cli_options?.enable_session_reuse === true && options.clientKey && !ctx?.imageFiles?.length) {
      const sm = this.ensureCliSessionManager(effective.cli_options.session_ttl_ms);
      const existing = sm.get(options.clientKey, model);
      if (existing) {
        resumeThreadId = existing.threadId;
      }
    }



    const ephemeralEnabled = effective.cli_options?.ephemeral !== false;
    const userHasEphemeral = effective.extra_args.includes('--ephemeral');
    const injectEphemeral = ephemeralEnabled && !userHasEphemeral;


    const userHasReasoning = effective.extra_args.some(
      (arg) => arg === 'model_reasoning_effort' || arg.startsWith('model_reasoning_effort='),
    );
    const reasoningArgs: string[] = [];
    if (options.reasoningEffort && !userHasReasoning) {
      const effort = options.reasoningEffort === 'xhigh' || options.reasoningEffort === 'max'
        ? 'high'
        : options.reasoningEffort;
      reasoningArgs.push('-c', `model_reasoning_effort=${effort}`);
    }

    if (resumeThreadId) {


      const filteredExtra = filterResumeUnsupportedArgs(effective.extra_args);
      return [
        'exec',
        'resume',
        resumeThreadId,
        '--json',
        ...(injectEphemeral ? ['--ephemeral'] : []),
        ...reasoningArgs,
        ...filteredExtra,
        ...(model ? ['-m', model] : []),
        '-',
      ];
    }

    const args: string[] = [
      'exec',

      '--json',
      ...(injectEphemeral ? ['--ephemeral'] : []),
      ...reasoningArgs,
      ...effective.extra_args,
      ...((ctx?.imageFiles ?? []).flatMap((file) => ['--image', file])),

      ...(model ? ['-m', model] : []),
      '-',
    ];

    return args;
  }


  protected override parseNonStreamOutput(stdout: string): ExecuteResult {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { content: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'error' };
    }


    try {
      const data = JSON.parse(trimmed);

      if (typeof data === 'object' && !Array.isArray(data) && data.type === undefined) {
        const content = data.result ?? data.content ?? data.message ?? '';
        return {
          content,
          usage: {
            promptTokens: data.usage?.input_tokens ?? 0,
            completionTokens: data.usage?.output_tokens ?? Math.ceil(content.length / 4),
            totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? Math.ceil(content.length / 4)),
          },
          finishReason: 'stop',
        };
      }
    } catch { }


    const result = super.parseNonStreamOutput(stdout);


    const firstLine = stdout.split('\n').find((l) => l.trim().length > 0);
    if (firstLine) {
      const threadId = extractThreadIdFromLine(firstLine);
      if (threadId) {
        return { ...result, meta: { threadId, threadReused: false } };
      }
    }
    return result;
  }



  override async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    if (this.isAppServerMode) {
      if (!this.appServerProcess?.isAlive()) {
        throw new Error('Codex app-server process is not running');
      }
      const config = this.buildAppServerConfig(options);
      const result = await executeAppServer(options, config);
      const model = options.model || this.config.default_model;

      options.onDebug?.({
        cliArgs: this.appServerDebugArgs(model, result.appServerMeta),
        stdout: result.content,
      });
      return result;
    }
    const { prompt, imageFiles, tempFiles } = await prepareCodexPrompt(options.messages);
    const ext: CodexExecuteOptions = {
      ...options,
      __codexPrompt: { text: prompt, imageFiles },
    };


    const effective = this.getEffectiveConfig(options);
    const sessionReuseEnabled = effective.cli_options?.enable_session_reuse === true && !!options.clientKey;
    const model = options.model || effective.default_model;
    const wasResume = sessionReuseEnabled
      ? !!this.cliSessionManager?.get(options.clientKey!, model)
      : false;

    try {
      const result = await super.execute(ext);

      if (sessionReuseEnabled && result.meta?.threadId) {
        const sm = this.ensureCliSessionManager(effective.cli_options?.session_ttl_ms);
        sm.set(options.clientKey!, result.meta.threadId, model);
        return { ...result, meta: { ...result.meta, threadReused: wasResume } };
      }
      return result;
    } catch (err) {

      if (sessionReuseEnabled && this.cliSessionManager) {
        this.cliSessionManager.invalidate(options.clientKey!);
      }
      throw err;
    } finally {
      await Promise.allSettled(tempFiles.map((file) => unlink(file)));
    }
  }

  override async *executeStream(options: ExecuteOptions): AsyncIterable<ProviderEvent> {
    if (this.isAppServerMode) {
      if (!this.appServerProcess?.isAlive()) {
        throw new Error('Codex app-server process is not running');
      }
      const streamLines: string[] = [];
      let streamMeta: AppServerMeta | undefined;
      const config = this.buildAppServerConfig(options);
      config.onAppServerMeta = (meta) => { streamMeta = meta; };

      for await (const event of executeStreamAppServer(options, config)) {
        if (event.type === 'text_delta') {
          streamLines.push(event.text);
        }
        yield event;
      }
      const model = options.model || this.config.default_model;

      options.onDebug?.({
        cliArgs: this.appServerDebugArgs(model, streamMeta),
        streamLines,
      });
      return;
    }
    const { prompt, imageFiles, tempFiles } = await prepareCodexPrompt(options.messages);
    const ext: CodexExecuteOptions = {
      ...options,
      __codexPrompt: { text: prompt, imageFiles },
    };



    const effective = this.getEffectiveConfig(options);
    const sessionReuseEnabled = effective.cli_options?.enable_session_reuse === true && !!options.clientKey;
    const model = options.model || effective.default_model;

    try {
      for await (const event of super.executeStream(ext)) {
        if (event.type === 'thread_started') {
          if (sessionReuseEnabled) {
            const sm = this.ensureCliSessionManager(effective.cli_options?.session_ttl_ms);
            sm.set(options.clientKey!, event.threadId, model);
          }

          continue;
        }
        yield event;
      }
    } catch (err) {
      if (sessionReuseEnabled && this.cliSessionManager) {
        this.cliSessionManager.invalidate(options.clientKey!);
      }
      throw err;
    } finally {
      await Promise.allSettled(tempFiles.map((file) => unlink(file)));
    }
  }

  override async checkHealth(): Promise<HealthStatus> {
    if (this.isAppServerMode) {
      return this.appServerProcess?.isAlive() ? 'healthy' : 'unhealthy';
    }
    return super.checkHealth();
  }


  override updateConfig(partial: Partial<ProviderConfigYaml>): void {
    const wasAppServer = this.isAppServerMode;
    super.updateConfig(partial);


    if (!wasAppServer && this.isAppServerMode) {
      this.initAppServer();
    }


    if (wasAppServer && !this.isAppServerMode) {
      this.destroyAppServer();
    }
  }
}
