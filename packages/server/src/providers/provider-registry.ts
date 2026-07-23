import type { ProviderConfigYaml } from '@agent-proxy/shared';
import type { BaseProvider } from './base-provider.js';
import { AgyProvider } from './agy-provider.js';
import { ClaudeProvider } from './claude-provider.js';
import { CodexProvider } from './codex-provider.js';
import { GrokProvider } from './grok-provider.js';

export class ProviderRegistry {
  private providers = new Map<string, BaseProvider>();

  register(provider: BaseProvider): void {
    this.providers.set(provider.name, provider);
  }

  get(name: string): BaseProvider | undefined {
    return this.providers.get(name);
  }

  getAll(): BaseProvider[] {
    return Array.from(this.providers.values());
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  unregister(name: string): boolean {
    return this.providers.delete(name);
  }

  async shutdownAll(): Promise<void> {
    const providers = Array.from(this.providers.values());
    const results = await Promise.allSettled(
      providers.map((provider) => provider.shutdown()),
    );

    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.error(`[${providers[index].name}] provider shutdown failed:`, result.reason);
      }
    });
  }


  getProviderConfig(name: string): ProviderConfigYaml | undefined {
    const provider = this.providers.get(name);
    if (!provider) return undefined;
    const configurable = provider as unknown as { getConfig?(): ProviderConfigYaml };
    return typeof configurable.getConfig === 'function' ? configurable.getConfig() : undefined;
  }


  updateProviderConfig(name: string, partial: Partial<ProviderConfigYaml>): boolean {
    const provider = this.providers.get(name);
    if (!provider) return false;


    if (partial.cli_path !== undefined) {
      validateCliPath(name, partial.cli_path);
    }

    if (partial.extra_args !== undefined) {
      if (!Array.isArray(partial.extra_args) || !partial.extra_args.every(a => typeof a === 'string')) {
        throw new Error(`Invalid extra_args for ${name}: must be string array`);
      }
    }

    const updatable = provider as unknown as { updateConfig?(p: Partial<ProviderConfigYaml>): void };
    if (typeof updatable.updateConfig === 'function') {
      updatable.updateConfig(partial);
      return true;
    }
    return false;
  }
}


const SAFE_CLI_PATH = /^[a-zA-Z0-9_\-./\\:]+$/;

function validateCliPath(provider: string, cliPath: string): void {
  if (!SAFE_CLI_PATH.test(cliPath)) {
    throw new Error(`Unsafe cli_path for ${provider}: "${cliPath}". Only alphanumeric, -, _, ., /, \\, : allowed.`);
  }
}


type ProviderFactory = (config: ProviderConfigYaml) => BaseProvider;

const builtinFactories: Record<string, ProviderFactory> = {
  claude: (config) => new ClaudeProvider(config),
  codex: (config) => new CodexProvider(config),
  agy: (config) => new AgyProvider(config),
  grok: (config) => new GrokProvider(config),
};


export function createProviderRegistry(
  configs: Record<string, ProviderConfigYaml>,
): ProviderRegistry {
  const registry = new ProviderRegistry();

  for (const [name, config] of Object.entries(configs)) {
    if (!config.enabled) continue;

    validateCliPath(name, config.cli_path);

    const factory = builtinFactories[name];
    if (factory) {
      registry.register(factory(config));
    }

  }

  return registry;
}
