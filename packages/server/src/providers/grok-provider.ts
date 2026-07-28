import type { ExecuteOptions, ExecuteResult, ProviderConfigYaml, ProviderEvent, TokenUsage } from '@agent-proxy/shared';
import { BaseProvider } from './base-provider.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';
import type { ProviderExecutionBackend } from '../herdr/launcher.js';
import {
  adaptExternalToolResult,
  externalToolEvents,
  prepareExternalToolRequest,
} from './external-tool-adapter.js';



const MAX_PROMPT_ARG_BYTES = 800_000;



const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function estimateTokens(text: string): TokenUsage {
  const completionTokens = Math.ceil(text.length / 4);
  return { promptTokens: 0, completionTokens, totalTokens: completionTokens };
}

export class GrokProvider extends BaseProvider {
  readonly name = 'grok' as const;

  constructor(
    config: ProviderConfigYaml,
    executionBackend?: ProviderExecutionBackend,
    proxyPort?: number,
  ) {
    super(config, executionBackend, proxyPort);
    this.initParser();
  }


  protected buildArgs(options: ExecuteOptions): string[] {
    const model = options.model || this.config.default_model;
    const prompt = convertMessagesToSinglePrompt(options.messages);

    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_ARG_BYTES) {
      throw new Error(
        `grok: prompt exceeds ${MAX_PROMPT_ARG_BYTES} bytes ` +
        `(actual ${Buffer.byteLength(prompt, 'utf8')}). Grok batch mode passes the prompt through ` +
        `the -p argument and is constrained by the macOS 1 MB ARG_MAX limit. Shorten or summarize the request.`
      );
    }




    const userHasEffort = this.config.extra_args.some(
      (arg) => arg === '--effort' || arg === '--reasoning-effort',
    );
    const effortArgs = options.reasoningEffort && !userHasEffort
      ? ['--effort', options.reasoningEffort]
      : [];



    const modelArgs = model ? ['-m', model] : [];
    const userHasTools = this.config.extra_args.some(
      (arg) => arg === '--tools' || arg.startsWith('--tools='),
    );
    const externalSelection = options.extraBody?.__agentProxyExternalToolSelection === true;
    const configuredTools = this.config.extra_args.flatMap((arg, index, args) => {
      if (arg === '--tools') return [args[index + 1] ?? ''];
      if (arg.startsWith('--tools=')) return [arg.slice('--tools='.length)];
      return [];
    });
    if (externalSelection && configuredTools.some((value) => value.trim() !== '')) {
      throw new Error('External tool selection requires Grok native tools to be disabled.');
    }
    const externalToolArgs = externalSelection
      && !userHasTools
      ? ['--tools', '']
      : [];
    return [
      ...this.config.extra_args,
      ...effortArgs,
      ...modelArgs,
      ...externalToolArgs,
      '-p',
      prompt,
    ];
  }



  override async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const prepared = prepareExternalToolRequest(options);
    const effectiveOptions = prepared?.options ?? options;
    const args = this.buildArgs({ ...effectiveOptions, stream: false });
    const { stdout, stderr, exitCode } = await this.runProcess(args, effectiveOptions);

    if (exitCode !== 0) {
      options.onDebug?.({ cliArgs: [this.config.cli_path, ...args], stdout, stderr });
      throw new Error(`grok CLI exited with code ${exitCode}: ${stderr.trim() || stdout.trim()}`);
    }

    options.onDebug?.({ cliArgs: [this.config.cli_path, ...args], stdout, stderr });

    const content = stripAnsi(stdout).trim();
    const result: ExecuteResult = {
      content,
      usage: estimateTokens(content),
      finishReason: 'stop',
    };
    return prepared ? adaptExternalToolResult(result, prepared) : result;
  }



  override async *executeStream(options: ExecuteOptions): AsyncIterable<ProviderEvent> {
    const result = await this.execute({ ...options, stream: false });
    yield* externalToolEvents(result);
  }
}
