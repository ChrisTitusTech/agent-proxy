import type { ExecuteOptions, ExecuteResult, ProviderEvent, ProviderConfigYaml, HealthStatus } from '@agent-proxy/shared';
import { BaseProvider } from './base-provider.js';
import { convertMessages } from '../utils/message-converter.js';
import { executeSdk, executeStreamSdk, type SdkExecutorConfig, type SdkMeta } from './claude-sdk-executor.js';
import { ClaudeSdkSessionManager } from './claude-sdk-session-manager.js';
import { executeChannel, executeStreamChannel, type ChannelExecutorConfig } from './claude-channel-executor.js';
import { mergeProviderConfig } from './provider-override.js';
import { channelBridgeManager } from '../channel-bridge/manager.js';


async function pingBridgeHealth(baseUrl: string, apiKey?: string): Promise<boolean> {
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/health`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal,
    });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

export class ClaudeProvider extends BaseProvider {
  readonly name = 'claude' as const;


  private sessionManager: ClaudeSdkSessionManager | null = null;

  constructor(config: ProviderConfigYaml) {
    super(config);
    this.initParser();


    if (this.isSDKMode) {
      const ttl = config.sdk_options?.session_ttl_ms;
      this.sessionManager = new ClaudeSdkSessionManager(ttl);
    }
  }

  private get isSDKMode(): boolean {
    return this.config.mode === 'sdk';
  }

  private getEffectiveConfig(options: ExecuteOptions): ProviderConfigYaml {
    return mergeProviderConfig(this.config, options.providerOverrides, 'claude');
  }

  private ensureSdkSessionManager(ttlMs?: number): ClaudeSdkSessionManager {
    if (!this.sessionManager) {
      this.sessionManager = new ClaudeSdkSessionManager(ttlMs);
    }
    return this.sessionManager;
  }

  private buildSdkConfig(
    options: ExecuteOptions,
    effective: ProviderConfigYaml,
    clientKey?: string,
  ): SdkExecutorConfig {
    return {
      model: options.model || effective.default_model,
      sdkOptions: effective.sdk_options ?? {},
      workingDir: effective.working_dir ?? this.workingDir,
      timeoutMs: effective.timeout_ms,
      cleanEnv: this.getCleanEnv(),
      cliPath: effective.cli_path,
      sessionManager: this.ensureSdkSessionManager(effective.sdk_options?.session_ttl_ms),
      clientKey,
    };
  }

  private buildChannelConfig(options: ExecuteOptions, effective: ProviderConfigYaml): ChannelExecutorConfig {
    const channelOptions = { ...(effective.channel_options ?? {}) };

    if (!channelOptions.endpoint_url && channelOptions.managed) {
      channelOptions.endpoint_url = `http://127.0.0.1:${channelOptions.bridge_port ?? 8788}`;
    }
    return {
      model: options.model || effective.default_model,
      channelOptions,
      timeoutMs: effective.timeout_ms,
    };
  }



  protected override getStdinData(options: ExecuteOptions): string {
    const { userPrompt } = convertMessages(options.messages);
    return userPrompt;
  }

  protected buildArgs(options: ExecuteOptions): string[] {
    const effective = this.getEffectiveConfig(options);
    const { systemPrompt } = convertMessages(options.messages);
    const model = options.model || effective.default_model;

    // non-streaming: json, streaming: stream-json --verbose

    const format = options.stream ? 'stream-json' : 'json';
    const args: string[] = [
      '-p', '-',
      '--output-format', format,
      '--model', model,
      '--max-turns', '50',
    ];

    if (options.stream) {
      args.push('--verbose');
    }

    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }




    if (options.reasoningEffort && !effective.extra_args.includes('--effort')) {
      args.push('--effort', options.reasoningEffort);
    }

    args.push(...effective.extra_args);

    return args;
  }


  protected override parseNonStreamOutput(stdout: string): ExecuteResult {
    const trimmed = stdout.trim();
    if (!trimmed) {
      return { content: '', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: 'error' };
    }

    try {
      const data = JSON.parse(trimmed);

      const content = data.result ?? '';
      const inputTokens = data.usage?.input_tokens ?? 0;
      const outputTokens = data.usage?.output_tokens ?? 0;
      const cacheRead = data.usage?.cache_read_input_tokens ?? 0;
      const cacheCreate = data.usage?.cache_creation_input_tokens ?? 0;

      return {
        content,
        usage: {
          promptTokens: inputTokens + cacheRead + cacheCreate,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens + cacheRead + cacheCreate,
        },
        finishReason: data.stop_reason === 'max_tokens' ? 'length' : 'stop',
      };
    } catch {

      return {
        content: trimmed,
        usage: { promptTokens: 0, completionTokens: Math.ceil(trimmed.length / 4), totalTokens: Math.ceil(trimmed.length / 4) },
        finishReason: 'stop',
      };
    }
  }



  private sdkDebugArgs(model: string, meta?: SdkMeta): string[] {
    const args = ['[sdk-mode]', `model=${model}`];
    if (meta) {
      args.push(`session=${meta.sessionId ?? 'none'}`);
      args.push(`reused=${meta.sessionReused}`);
      if (meta.retried) args.push('retried=true');
    }
    return args;
  }

  override async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const effective = this.getEffectiveConfig(options);
    if (effective.mode === 'sdk') {
      const result = await executeSdk(options, this.buildSdkConfig(options, effective, options.clientKey));
      const model = options.model || effective.default_model;

      options.onDebug?.({
        cliArgs: this.sdkDebugArgs(model, result.sdkMeta),
        stdout: result.content,
      });
      return result;
    }
    if (effective.mode === 'channel-worker') {
      return executeChannel(options, this.buildChannelConfig(options, effective));
    }
    return super.execute(options);
  }

  override async *executeStream(options: ExecuteOptions): AsyncIterable<ProviderEvent> {
    const effective = this.getEffectiveConfig(options);
    if (effective.mode === 'sdk') {
      const sdkLines: string[] = [];
      let streamMeta: SdkMeta | undefined;
      const sdkConfig = this.buildSdkConfig(options, effective, options.clientKey);
      sdkConfig.onSdkMeta = (meta) => { streamMeta = meta; };

      for await (const event of executeStreamSdk(options, sdkConfig)) {
        if (event.type === 'text_delta') {
          sdkLines.push(event.text);
        }
        yield event;
      }
      const model = options.model || effective.default_model;

      options.onDebug?.({
        cliArgs: this.sdkDebugArgs(model, streamMeta),
        streamLines: sdkLines,
      });
      return;
    }
    if (effective.mode === 'channel-worker') {
      yield* executeStreamChannel(options, this.buildChannelConfig(options, effective));
      return;
    }
    yield* super.executeStream(options);
  }

  override async checkHealth(): Promise<HealthStatus> {

    if (this.config.mode === 'channel-worker') {
      const ch = this.config.channel_options ?? {};
      if (ch.managed) {

        const status = await channelBridgeManager.status();
        return status.running && status.healthy ? 'healthy' : 'unhealthy';
      }

      const baseUrl = ch.endpoint_url ?? `http://127.0.0.1:${ch.bridge_port ?? 8788}`;
      return (await pingBridgeHealth(baseUrl, ch.api_key)) ? 'healthy' : 'unhealthy';
    }

    return super.checkHealth();
  }


  override updateConfig(partial: Partial<ProviderConfigYaml>): void {
    const wasSDKMode = this.isSDKMode;
    super.updateConfig(partial);


    if (!wasSDKMode && this.isSDKMode && !this.sessionManager) {
      const ttl = this.config.sdk_options?.session_ttl_ms;
      this.sessionManager = new ClaudeSdkSessionManager(ttl);
    }


    if (wasSDKMode && !this.isSDKMode && this.sessionManager) {
      this.sessionManager.destroy();
      this.sessionManager = null;
    }
  }
}
