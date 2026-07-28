import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

describe('Codex provider recursion prevention', () => {
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
      `base_url = "${baseUrl}"\n`,
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
      '# base_url = "http://127.0.0.1:18300/v1"\n'
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

  it('uses the default proxy port when the environment value is invalid', () => {
    expect(resolveProxyPort('not-a-port')).toBe(8300);
    expect(resolveProxyPort('70000')).toBe(8300);
    expect(resolveProxyPort('18300')).toBe(18300);
  });
});
