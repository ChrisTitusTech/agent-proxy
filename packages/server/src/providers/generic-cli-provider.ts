import type { ExecuteOptions, ExecuteResult, GenericCliProviderConfig } from '@agent-proxy/shared';
import { BaseProvider } from './base-provider.js';
import { convertMessagesToSinglePrompt } from '../utils/message-converter.js';
import { registerParser, PlainTextParser } from '../utils/stream-transformer.js';


class NdjsonFieldParser extends PlainTextParser {
  constructor(
    private readonly contentField: string,
    private readonly doneIndicator?: string,
  ) {
    super();
  }

  override parse(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return null;


    if (this.doneIndicator && trimmed === this.doneIndicator) {
      return { type: 'done' as const };
    }

    try {
      const data = JSON.parse(trimmed);
      const content = data[this.contentField];
      if (typeof content === 'string' && content) {
        return { type: 'delta' as const, content };
      }
      return null;
    } catch {

      return { type: 'delta' as const, content: trimmed };
    }
  }
}

export class GenericCliProvider extends BaseProvider {

  readonly name: string;

  private readonly genericConfig: GenericCliProviderConfig;

  constructor(name: string, config: GenericCliProviderConfig) {
    super(config);
    this.name = name;
    this.genericConfig = config;
    this.initParser();
  }


  protected override initParser() {
    if (
      this.genericConfig.streaming_enabled &&
      this.genericConfig.stream_content_field
    ) {
      registerParser(this.name, () =>
        new NdjsonFieldParser(
          this.genericConfig.stream_content_field!,
          this.genericConfig.stream_done_indicator,
        ),
      );
    }

    super.initParser();
  }

  protected buildArgs(options: ExecuteOptions): string[] {
    const model = options.model || this.config.default_model;


    const template =
      options.stream && this.genericConfig.stream_args_template
        ? this.genericConfig.stream_args_template
        : this.genericConfig.args_template;


    const args = template.map((arg) => arg.replace(/\{model\}/g, model));


    if (this.genericConfig.prompt_mode === 'arg') {
      const prompt = convertMessagesToSinglePrompt(options.messages);
      for (let i = 0; i < args.length; i++) {
        args[i] = args[i].replace(/\{prompt\}/g, prompt);
      }
    }


    args.push(...this.config.extra_args);

    return args;
  }



  protected override getStdinData(options: ExecuteOptions): string | undefined {
    if (this.genericConfig.prompt_mode === 'stdin') {
      return convertMessagesToSinglePrompt(options.messages);
    }
    return undefined;
  }


  protected override parseNonStreamOutput(stdout: string): ExecuteResult {
    const trimmed = stdout.trim();

    if (!trimmed) {
      return {
        content: '',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: 'error',
      };
    }

    if (this.genericConfig.output_mode === 'json_field') {
      const field = this.genericConfig.output_json_content_field;
      if (field) {
        try {
          const data = JSON.parse(trimmed);
          const content = typeof data[field] === 'string' ? data[field] : '';
          const tokens = Math.ceil(content.length / 4);
          return {
            content,
            usage: { promptTokens: 0, completionTokens: tokens, totalTokens: tokens },
            finishReason: 'stop',
          };
        } catch {

        }
      }
    }


    const tokens = Math.ceil(trimmed.length / 4);
    return {
      content: trimmed,
      usage: { promptTokens: 0, completionTokens: tokens, totalTokens: tokens },
      finishReason: 'stop',
    };
  }



  override async checkHealth() {
    const args = this.genericConfig.health_check_args ?? ['--version'];
    try {
      const child = this.spawnProcess(args);
      child.stdin?.end();
      const exitCode = await new Promise<number>((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          resolve(1);
        }, 10_000);
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve(code ?? 1);
        });
        child.on('error', () => {
          clearTimeout(timer);
          resolve(1);
        });
      });
      return exitCode === 0 ? ('healthy' as const) : ('unhealthy' as const);
    } catch {
      return 'unhealthy' as const;
    }
  }


  getConfig(): GenericCliProviderConfig {
    return { ...this.genericConfig };
  }


  updateConfig(partial: Partial<GenericCliProviderConfig>): void {
    Object.assign(this.config, partial);
    Object.assign(this.genericConfig, partial);
  }
}
