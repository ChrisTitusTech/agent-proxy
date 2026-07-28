import type { ExecuteOptions, ExecuteResult, ProviderEvent, ProviderConfigYaml } from '@agent-proxy/shared';
import { BaseProvider } from './base-provider.js';
import { convertMessages } from '../utils/message-converter.js';
import { mergeProviderConfig } from './provider-override.js';
import {
  adaptExternalToolResult,
  externalToolEvents,
  prepareExternalToolRequest,
} from './external-tool-adapter.js';
import type { ProviderExecutionBackend } from '../herdr/launcher.js';


export class ClaudeProvider extends BaseProvider {
  readonly name = 'claude' as const;

  constructor(
    config: ProviderConfigYaml,
    executionBackend?: ProviderExecutionBackend,
    proxyPort?: number,
  ) {
    super(config, executionBackend, proxyPort);
    this.initParser();
  }

  private getEffectiveConfig(options: ExecuteOptions): ProviderConfigYaml {
    return mergeProviderConfig(this.config, options.providerOverrides, 'claude');
  }

  protected override getExecutionConfig(options: ExecuteOptions): ProviderConfigYaml {
    return this.getEffectiveConfig(options);
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
    const configuredTools = effective.extra_args.flatMap(
      (arg, index, args): Array<string | null> => {
        if (arg === '--tools') {
          return [typeof args[index + 1] === 'string' ? args[index + 1] : null];
        }
        if (arg.startsWith('--tools=')) return [arg.slice('--tools='.length)];
        return [];
      },
    );
    if (options.extraBody?.__agentProxyExternalToolSelection === true) {
      if (configuredTools.some((value) => value === null || value.length > 0)) {
        throw new Error('External tool selection requires Claude native tools to be disabled.');
      }
      if (configuredTools.length === 0) args.push('--tools', '');
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



  private async executeWithoutExternalTools(options: ExecuteOptions): Promise<ExecuteResult> {
    return super.execute(options);
  }

  override async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const prepared = prepareExternalToolRequest(options);
    const result = await this.executeWithoutExternalTools(prepared?.options ?? options);
    return prepared ? adaptExternalToolResult(result, prepared) : result;
  }

  override async *executeStream(options: ExecuteOptions): AsyncIterable<ProviderEvent> {
    const prepared = prepareExternalToolRequest(options);
    if (prepared) {
      const result = adaptExternalToolResult(
        await this.executeWithoutExternalTools(prepared.options),
        prepared,
      );
      yield* externalToolEvents(result);
      return;
    }
    yield* super.executeStream(options);
  }
}
