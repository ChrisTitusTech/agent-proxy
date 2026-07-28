import type { ExecuteOptions, ExecuteResult, ProviderEvent, ProviderConfigYaml } from '@agent-proxy/shared';
import { BaseProvider, providerExecutionIdentity } from './base-provider.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';
import { prepareCodexPrompt } from '../utils/image-extractor.js';
import { CodexCliSessionManager } from './codex-cli-session-manager.js';
import { mergeProviderConfig } from './provider-override.js';
import { unlink } from 'node:fs/promises';
import {
  adaptExternalToolResult,
  externalToolEvents,
  prepareExternalToolRequest,
} from './external-tool-adapter.js';
import type { ProviderExecutionBackend } from '../herdr/launcher.js';
import { KeyedMutex } from '../utils/keyed-mutex.js';

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
const EXTERNAL_TOOL_DISABLED_FEATURES = [
  'apply_patch_freeform',
  'apply_patch_streaming_events',
  'apps',
  'browser_use',
  'code_mode',
  'code_mode_host',
  'computer_use',
  'image_generation',
  'multi_agent',
  'shell_tool',
  'unified_exec',
] as const;



const THREAD_ID_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function extractThreadIdFromLine(line: string): string | null {
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

function configuredProfileArgs(args: string[]): string[] {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if ((argument === '-p' || argument === '--profile') && args[index + 1]) {
      return [argument, args[index + 1]];
    }
    if (
      argument.startsWith('--profile=')
      || argument.startsWith('-p=')
    ) return [argument];
  }
  return [];
}

export class CodexProvider extends BaseProvider {
  readonly name = 'codex' as const;

  private cliSessionManager: CodexCliSessionManager | null = null;
  private readonly cliSessionMutex = new KeyedMutex();

  private warnedEphemeralForceAlias = new Set<string>();

  constructor(
    config: ProviderConfigYaml,
    executionBackend?: ProviderExecutionBackend,
    proxyPort?: number,
  ) {
    super(config, executionBackend, proxyPort);
    this.initParser();
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

  protected override getExecutionConfig(options: ExecuteOptions): ProviderConfigYaml {
    return this.getEffectiveConfig(options);
  }



  private ensureCliSessionManager(ttlMs?: number): CodexCliSessionManager {
    if (!this.cliSessionManager) {
      this.cliSessionManager = new CodexCliSessionManager(ttlMs);
    }
    return this.cliSessionManager;
  }

  private sessionLockKey(options: ExecuteOptions): string | undefined {
    if (!options.clientKey) return undefined;
    const effective = this.getEffectiveConfig(options);
    return effective.cli_options?.enable_session_reuse === true
      ? options.clientKey
      : undefined;
  }

  getCliSessionManager(): CodexCliSessionManager | null {
    return this.cliSessionManager;
  }

  destroyCliSessionManager(): void {
    this.cliSessionManager?.destroy();
    this.cliSessionManager = null;
    this.warnedEphemeralForceAlias.clear();
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
      const existing = sm.get(
        options.clientKey,
        model,
        providerExecutionIdentity(effective),
      );
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
    const configuredDisables = new Set(effective.extra_args.flatMap(
      (arg, index, args) => {
        if (arg === '--disable') return args[index + 1] ? [args[index + 1]] : [];
        if (arg.startsWith('--disable=')) return [arg.slice('--disable='.length)];
        return [];
      },
    ));
    const externalToolArgs = options.extraBody?.__agentProxyExternalToolSelection === true
      ? EXTERNAL_TOOL_DISABLED_FEATURES.flatMap(
        (feature) => configuredDisables.has(feature) ? [] : ['--disable', feature],
      )
      : [];

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
      ...externalToolArgs,
      ...((ctx?.imageFiles ?? []).flatMap((file) => ['--image', file])),

      ...(model ? ['-m', model] : []),
      '-',
    ];

    return args;
  }

  protected override getRecursionCheckArgs(
    options: ExecuteOptions,
    args: string[],
  ): string[] {
    if (args[0] !== 'exec' || args[1] !== 'resume') return args;
    return [
      ...args,
      ...configuredProfileArgs(this.getEffectiveConfig(options).extra_args),
    ];
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



  private async executeWithoutExternalTools(options: ExecuteOptions): Promise<ExecuteResult> {
    const { prompt, imageFiles, tempFiles } = await prepareCodexPrompt(options.messages);
    const ext: CodexExecuteOptions = {
      ...options,
      __codexPrompt: { text: prompt, imageFiles },
    };


    const effective = this.getEffectiveConfig(options);
    const sessionReuseEnabled = effective.cli_options?.enable_session_reuse === true && !!options.clientKey;
    const model = options.model || effective.default_model;
    const executionIdentity = providerExecutionIdentity(effective);
    const wasResume = sessionReuseEnabled
      ? !!this.cliSessionManager?.get(
        options.clientKey!,
        model,
        executionIdentity,
      )
      : false;

    try {
      const result = await super.execute(ext);

      if (sessionReuseEnabled && result.meta?.threadId) {
        const sm = this.ensureCliSessionManager(effective.cli_options?.session_ttl_ms);
        sm.set(
          options.clientKey!,
          result.meta.threadId,
          model,
          executionIdentity,
        );
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

  override async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const lockKey = this.sessionLockKey(options);
    const release = lockKey
      ? await this.cliSessionMutex.acquire(lockKey, {
        ...(options.signal ? { signal: options.signal } : {}),
      })
      : undefined;
    try {
      const prepared = prepareExternalToolRequest(options);
      const result = await this.executeWithoutExternalTools(prepared?.options ?? options);
      return prepared ? adaptExternalToolResult(result, prepared) : result;
    } finally {
      release?.();
    }
  }

  override async *executeStream(options: ExecuteOptions): AsyncIterable<ProviderEvent> {
    const lockKey = this.sessionLockKey(options);
    const release = lockKey
      ? await this.cliSessionMutex.acquire(lockKey, {
        ...(options.signal ? { signal: options.signal } : {}),
      })
      : undefined;
    try {
      yield* this.executeStreamUnlocked(options);
    } finally {
      release?.();
    }
  }

  private async *executeStreamUnlocked(
    options: ExecuteOptions,
  ): AsyncIterable<ProviderEvent> {
    const prepared = prepareExternalToolRequest(options);
    if (prepared) {
      const result = adaptExternalToolResult(
        await this.executeWithoutExternalTools(prepared.options),
        prepared,
      );
      yield* externalToolEvents(result);
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
    const executionIdentity = providerExecutionIdentity(effective);

    try {
      for await (const event of super.executeStream(ext)) {
        if (event.type === 'thread_started') {
          if (sessionReuseEnabled) {
            const sm = this.ensureCliSessionManager(effective.cli_options?.session_ttl_ms);
            sm.set(
              options.clientKey!,
              event.threadId,
              model,
              executionIdentity,
            );
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

  override async shutdown(): Promise<void> {
    this.destroyCliSessionManager();
  }
}
