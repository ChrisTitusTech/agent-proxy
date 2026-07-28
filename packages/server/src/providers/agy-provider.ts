import type { ExecuteOptions, ExecuteResult, ProviderConfigYaml, ProviderEvent, TokenUsage } from '@agent-proxy/shared';
import { BaseProvider } from './base-provider.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';
import type { ProviderExecutionBackend } from '../herdr/launcher.js';



const MAX_PROMPT_ARG_BYTES = 800_000;




const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function estimateTokens(text: string): TokenUsage {
  const completionTokens = Math.ceil(text.length / 4);
  return { promptTokens: 0, completionTokens, totalTokens: completionTokens };
}



const MODEL_PLACEHOLDER = 'antigravity';

export class AgyProvider extends BaseProvider {
  readonly name = 'agy' as const;

  constructor(
    config: ProviderConfigYaml,
    executionBackend?: ProviderExecutionBackend,
    proxyPort?: number,
  ) {
    super(config, executionBackend, proxyPort);
    this.initParser();
  }


  protected buildArgs(options: ExecuteOptions): string[] {
    const prompt = convertMessagesToSinglePrompt(options.messages);

    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_ARG_BYTES) {
      throw new Error(
        `agy: prompt exceeds ${MAX_PROMPT_ARG_BYTES} bytes ` +
        `(actual ${Buffer.byteLength(prompt, 'utf8')}). Antigravity does not accept prompts on stdin, so ` +
        `the -p argument is constrained by the macOS 1 MB ARG_MAX limit. Shorten or summarize the request.`
      );
    }

    // agy parses print-mode flags before the print prompt. Keep all flags
    // (extra_args + --model) before -p so options such as --print-timeout and
    // --model apply to this run instead of being interpreted as prompt text or
    // ignored after the prompt.
    const args = [...this.config.extra_args];



    const model = options.model?.trim();
    const userSetModel = this.config.extra_args.includes('--model');
    if (model && model !== MODEL_PLACEHOLDER && !userSetModel) {
      args.push('--model', model);
    }

    args.push('-p', prompt);
    return args;
  }



  override async execute(options: ExecuteOptions): Promise<ExecuteResult> {
    const args = this.buildArgs({ ...options, stream: false });
    const { stdout, stderr, exitCode } = await this.runProcess(args, options);

    if (exitCode !== 0) {
      options.onDebug?.({ cliArgs: [this.config.cli_path, ...args], stdout, stderr });
      throw new Error(`agy CLI exited with code ${exitCode}: ${stderr.trim() || stdout.trim()}`);
    }

    options.onDebug?.({ cliArgs: [this.config.cli_path, ...args], stdout, stderr });

    const content = stripAnsi(stdout).trim();
    return {
      content,
      usage: estimateTokens(content),
      finishReason: 'stop',
    };
  }



  override async *executeStream(options: ExecuteOptions): AsyncIterable<ProviderEvent> {
    const result = await this.execute({ ...options, stream: false });

    if (result.content) {
      yield { type: 'text_delta', text: result.content };
    }
    yield {
      type: 'usage',
      usage: result.usage,
    };
    yield {
      type: 'done',

      finishReason: result.finishReason === 'tool_calls' ? 'tool_use' : (result.finishReason ?? 'stop'),
    };
  }

}
