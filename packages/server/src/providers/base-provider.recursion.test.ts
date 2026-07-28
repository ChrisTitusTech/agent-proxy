import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderConfigYaml } from '@agent-proxy/shared';
import type {
  HerdrReadiness,
  ProviderExecutionBackend,
  ProviderExecutionHandle,
  ProviderExecutionRequest,
} from '../herdr/launcher.js';
import { resolveProxyPort } from './base-provider.js';
import { CodexProvider } from './codex-provider.js';
import { GrokProvider } from './grok-provider.js';
import { GenericCliProvider } from './generic-cli-provider.js';

const temporaryDirectories: string[] = [];
const originalCodexHome = process.env.CODEX_HOME;
const originalProxyPort = process.env.AGENT_PROXY_PORT;

afterEach(async () => {
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  if (originalProxyPort === undefined) delete process.env.AGENT_PROXY_PORT;
  else process.env.AGENT_PROXY_PORT = originalProxyPort;
  await Promise.all(
    temporaryDirectories.splice(0).map(
      (directory) => rm(directory, { recursive: true, force: true }),
    ),
  );
});

class RecordingBackend implements ProviderExecutionBackend {
  starts: ProviderExecutionRequest[] = [];

  async start(request: ProviderExecutionRequest): Promise<ProviderExecutionHandle> {
    this.starts.push(request);
    throw new Error('backend should not start');
  }

  async readiness(): Promise<HerdrReadiness> {
    return { ready: true };
  }

  async shutdown(): Promise<void> {}
}

function config(overrides: Partial<ProviderConfigYaml> = {}): ProviderConfigYaml {
  return {
    enabled: true,
    cli_path: 'codex',
    default_model: 'gpt-5.6-sol',
    max_concurrent: 1,
    timeout_ms: 30_000,
    extra_args: [],
    ...overrides,
  };
}

describe('built-in provider recursion prevention', () => {
  it('rejects generic CLI loopback arguments before creating a pane', async () => {
    const backend = new RecordingBackend();
    const provider = new GenericCliProvider('curl-provider', {
      ...config({
        cli_path: 'curl',
        extra_args: [],
      }),
      args_template: ['--url=http://127.0.0.1:18300/v1/chat/completions'],
      prompt_mode: 'stdin',
      output_mode: 'plain_text',
      streaming_enabled: false,
      display_name: 'Curl provider',
    }, backend, 18300);

    await expect(provider.execute({
      messages: [{ role: 'user', content: 'test' }],
      model: 'generic',
      stream: false,
    })).rejects.toThrow(/arguments route provider traffic back/);
    expect(backend.starts).toHaveLength(0);
  });

  it('does not treat a loopback URL inside the user prompt as CLI recursion', async () => {
    const backend = new RecordingBackend();
    const provider = new GenericCliProvider('prompt-provider', {
      ...config({
        cli_path: 'fixture',
        extra_args: [],
      }),
      args_template: ['--prompt', '{prompt}'],
      prompt_mode: 'arg',
      output_mode: 'plain_text',
      streaming_enabled: false,
      display_name: 'Prompt provider',
    }, backend, 18300);

    await expect(provider.execute({
      messages: [{
        role: 'user',
        content: 'Explain http://127.0.0.1:18300 without calling it.',
      }],
      model: 'generic',
      stream: false,
    })).rejects.toThrow('backend should not start');
    expect(backend.starts).toHaveLength(1);
  });

  it.each([
    'http://localhost:18300/v1',
    'http://localhost.localdomain:18300',
    'http://127.0.0.1:18300/v1',
    'http://127.42.0.9:18300',
    'http://[::1]:18300/v1',
    'http://0.0.0.0:18300/v1',
    'http://[::]:18300/v1',
  ])('rejects loopback provider URL %s before creating a pane', async (baseUrl) => {
    const codexHome = await mkdtemp(resolve(tmpdir(), 'agent-proxy-recursion-'));
    temporaryDirectories.push(codexHome);
    await writeFile(
      resolve(codexHome, 'config.toml'),
      `model_provider = "agent_proxy"
[model_providers.agent_proxy]
base_url = "${baseUrl}"
`,
      'utf8',
    );
    process.env.CODEX_HOME = codexHome;
    process.env.AGENT_PROXY_PORT = '18300';
    const backend = new RecordingBackend();
    const provider = new CodexProvider(config(), backend, 18300);

    await expect(provider.execute({
      messages: [{ role: 'user', content: 'test' }],
      model: 'gpt-5.6-sol',
      stream: false,
    })).rejects.toThrow(/routes provider traffic back to agent-proxy/);
    expect(backend.starts).toHaveLength(0);
  });

  it('reports a present but non-executable CLI as unhealthy', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'agent-proxy-health-'));
    temporaryDirectories.push(directory);
    const cliPath = resolve(directory, 'codex');
    await writeFile(cliPath, '#!/bin/sh\nexit 0\n', 'utf8');
    await chmod(cliPath, 0o600);
    const provider = new CodexProvider(config({ cli_path: cliPath }));

    await expect(provider.checkHealth()).resolves.toBe('unhealthy');
  });

  it('ignores commented-out Codex base URLs', async () => {
    const codexHome = await mkdtemp(resolve(tmpdir(), 'agent-proxy-recursion-'));
    temporaryDirectories.push(codexHome);
    await writeFile(
      resolve(codexHome, 'config.toml'),
      'model_provider = "openai"\n'
        + '# base_url = "http://127.0.0.1:18300/v1"\n'
        + '[model_providers.openai]\n'
        + 'name = "safe # value" # base_url = "http://localhost:18300"\n',
      'utf8',
    );
    process.env.CODEX_HOME = codexHome;
    const backend = new RecordingBackend();
    const provider = new CodexProvider(config(), backend, 18300);

    await expect(provider.execute({
      messages: [{ role: 'user', content: 'test' }],
      model: 'gpt-5.6-sol',
      stream: false,
    })).rejects.toThrow('backend should not start');
    expect(backend.starts).toHaveLength(1);
  });

  it('ignores a dormant Codex provider that points back to the proxy', async () => {
    const codexHome = await mkdtemp(resolve(tmpdir(), 'agent-proxy-recursion-'));
    temporaryDirectories.push(codexHome);
    await writeFile(
      resolve(codexHome, 'config.toml'),
      `model_provider = "openai"
[model_providers.openai]
base_url = "https://api.openai.com/v1"
[model_providers.agent_proxy]
base_url = "http://127.0.0.1:18300/v1"
`,
      'utf8',
    );
    process.env.CODEX_HOME = codexHome;
    const backend = new RecordingBackend();
    const provider = new CodexProvider(config(), backend, 18300);

    await expect(provider.execute({
      messages: [{ role: 'user', content: 'test' }],
      model: 'gpt-5.6-sol',
      stream: false,
    })).rejects.toThrow('backend should not start');
    expect(backend.starts).toHaveLength(1);
  });

  it('rejects an active Codex provider configured with dotted TOML keys', async () => {
    const codexHome = await mkdtemp(resolve(tmpdir(), 'agent-proxy-recursion-'));
    temporaryDirectories.push(codexHome);
    await writeFile(
      resolve(codexHome, 'config.toml'),
      `model_provider = "agent_proxy"
model_providers.agent_proxy.base_url = "http://127.0.0.1:18300/v1"
`,
      'utf8',
    );
    process.env.CODEX_HOME = codexHome;
    const backend = new RecordingBackend();
    const provider = new CodexProvider(config(), backend, 18300);

    await expect(provider.execute({
      messages: [{ role: 'user', content: 'test' }],
      model: 'gpt-5.6-sol',
      stream: false,
    })).rejects.toThrow(/routes provider traffic back/);
    expect(backend.starts).toHaveLength(0);
  });

  it('honors a Codex CLI provider override before creating a pane', async () => {
    const codexHome = await mkdtemp(resolve(tmpdir(), 'agent-proxy-recursion-'));
    temporaryDirectories.push(codexHome);
    await writeFile(
      resolve(codexHome, 'config.toml'),
      `model_provider = "openai"
[model_providers.openai]
base_url = "https://api.openai.com/v1"
[model_providers.agent_proxy]
base_url = "http://127.0.0.1:18300/v1"
`,
      'utf8',
    );
    process.env.CODEX_HOME = codexHome;
    const backend = new RecordingBackend();
    const provider = new CodexProvider(
      config({ extra_args: ['-c', 'model_provider="agent_proxy"'] }),
      backend,
      18300,
    );

    await expect(provider.execute({
      messages: [{ role: 'user', content: 'test' }],
      model: 'gpt-5.6-sol',
      stream: false,
    })).rejects.toThrow(/routes provider traffic back/);
    expect(backend.starts).toHaveLength(0);
  });

  it('uses the selected Codex profile instead of the dormant root provider', async () => {
    const codexHome = await mkdtemp(resolve(tmpdir(), 'agent-proxy-recursion-'));
    temporaryDirectories.push(codexHome);
    await writeFile(
      resolve(codexHome, 'config.toml'),
      `model_provider = "agent_proxy"
[model_providers.agent_proxy]
base_url = "http://127.0.0.1:18300/v1"
[model_providers.openai]
base_url = "https://api.openai.com/v1"
[profiles.safe]
model_provider = "openai"
`,
      'utf8',
    );
    process.env.CODEX_HOME = codexHome;
    const backend = new RecordingBackend();
    const provider = new CodexProvider(
      config({ extra_args: ['--profile', 'safe'] }),
      backend,
      18300,
    );

    await expect(provider.execute({
      messages: [{ role: 'user', content: 'test' }],
      model: 'gpt-5.6-sol',
      stream: false,
    })).rejects.toThrow('backend should not start');
    expect(backend.starts).toHaveLength(1);
  });

  it('rejects an active Grok custom model before creating a pane', async () => {
    const home = await mkdtemp(resolve(tmpdir(), 'agent-proxy-grok-recursion-'));
    temporaryDirectories.push(home);
    const grokDirectory = resolve(home, '.grok');
    await mkdir(grokDirectory);
    await writeFile(
      resolve(grokDirectory, 'config.toml'),
      `[model.agent-proxy]
base_url = "http://localhost:18300/v1"
[model.safe]
base_url = "https://api.x.ai/v1"
[models]
default = "safe"
`,
      'utf8',
    );
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const backend = new RecordingBackend();
      const provider = new GrokProvider(
        config({ default_model: 'agent-proxy' }),
        backend,
        18300,
      );
      await expect(provider.execute({
        messages: [{ role: 'user', content: 'test' }],
        model: 'agent-proxy',
        stream: false,
      })).rejects.toThrow(/routes provider traffic back/);
      expect(backend.starts).toHaveLength(0);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it('uses the default proxy port when the environment value is invalid', () => {
    expect(resolveProxyPort('not-a-port')).toBe(8300);
    expect(resolveProxyPort('70000')).toBe(8300);
    expect(resolveProxyPort('18300')).toBe(18300);
  });
});
