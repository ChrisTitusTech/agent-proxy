


import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SERVER_PORT,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RATE_LIMIT_RPM,
} from '@agent-proxy/shared';
import { loadConfig } from './loader.js';

let tempDir: string;

function writeConfig(yaml: string): string {
  const path = join(tempDir, 'config.yaml');
  writeFileSync(path, yaml, 'utf-8');
  return path;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'agent-proxy-config-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('loads and validates configuration', () => {
  it('loads and validates configuration', () => {
    const config = loadConfig(join(tempDir, 'nonexistent.yaml'));

    expect(config.server.port).toBe(DEFAULT_SERVER_PORT);
    expect(config.dashboard.port).toBe(DEFAULT_DASHBOARD_PORT);
    expect(config.providers.claude.cli_path).toBe('claude');
    expect(config.providers.claude.max_concurrent).toBe(DEFAULT_MAX_CONCURRENT);
    expect(config.providers.grok.default_model).toBe('grok-4.5');
    expect(config.providers.grok.max_concurrent).toBe(1);
    expect(config.rateLimits.global.rpm).toBe(DEFAULT_RATE_LIMIT_RPM);
    expect(config.modelMappings.length).toBeGreaterThan(0);
    expect(config.modelMappings).toContainEqual(expect.objectContaining({
      alias: 'grok-build',
      provider: 'grok',
      actual_model: 'grok-4.5',
    }));
  });

  it('applies validated server and database environment overrides', () => {
    process.env.AGENT_PROXY_HOST = '0.0.0.0';
    process.env.AGENT_PROXY_PORT = '18300';
    process.env.AGENT_PROXY_DATABASE_PATH = '/tmp/agent-proxy-test.db';
    try {
      const config = loadConfig(join(tempDir, 'nonexistent.yaml'));

      expect(config.server.host).toBe('0.0.0.0');
      expect(config.server.port).toBe(18300);
      expect(config.database.path).toBe('/tmp/agent-proxy-test.db');
    } finally {
      delete process.env.AGENT_PROXY_HOST;
      delete process.env.AGENT_PROXY_PORT;
      delete process.env.AGENT_PROXY_DATABASE_PATH;
    }
  });

  it('rejects invalid AGENT_PROXY_PORT values', () => {
    process.env.AGENT_PROXY_PORT = 'invalid';
    try {
      expect(() => loadConfig(join(tempDir, 'nonexistent.yaml')))
        .toThrow('AGENT_PROXY_PORT must be an integer between 1 and 65535.');
    } finally {
      delete process.env.AGENT_PROXY_PORT;
    }
  });

  it('loads and validates configuration', () => {
    const path = writeConfig(`
server:
  port: 9999
  host: "0.0.0.0"
providers:
  claude:
    enabled: false
    cli_path: "/usr/local/bin/claude"
    timeout_ms: 60000
model_mappings:
  - alias: "my-model"
    provider: "claude"
    actual_model: "claude-sonnet-4-6"
`);
    const config = loadConfig(path);

    expect(config.server.port).toBe(9999);
    expect(config.server.host).toBe('0.0.0.0');
    expect(config.providers.claude.enabled).toBe(false);
    expect(config.providers.claude.cli_path).toBe('/usr/local/bin/claude');
    expect(config.providers.claude.timeout_ms).toBe(60000);

    expect(config.providers.claude.max_concurrent).toBe(DEFAULT_MAX_CONCURRENT);
    expect(config.providers.codex.timeout_ms).toBe(DEFAULT_TIMEOUT_MS);
    expect(config.modelMappings).toEqual([
      {
        alias: 'my-model',
        provider: 'claude',
        actual_model: 'claude-sonnet-4-6',
        reasoning_effort: undefined,
        provider_overrides: undefined,
      },
    ]);
  });

  it('loads and validates configuration', () => {

    const path = writeConfig(`
server:
  port:
  host:
cache:
  enabled:
`);
    const config = loadConfig(path);

    expect(config.server.port).toBe(DEFAULT_SERVER_PORT);
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.cache.enabled).toBe(true);
  });

  it('loads and validates configuration', () => {
    process.env.TEST_CLIPROXY_TOKEN = 'secret-token-123';
    try {
      const path = writeConfig(`
auth:
  admin_token: "\${TEST_CLIPROXY_TOKEN}"
`);
      const config = loadConfig(path);
      expect(config.auth.adminToken).toBe('secret-token-123');
    } finally {
      delete process.env.TEST_CLIPROXY_TOKEN;
    }
  });

  it('loads and validates configuration', () => {
    const path = writeConfig(`
server:
  port: 9999
  future_option: true
totally_new_section:
  foo: bar
`);
    const config = loadConfig(path);
    expect(config.server.port).toBe(9999);
  });

  it('loads and validates configuration', () => {
    const path = writeConfig(`
providers:
  my-ollama:
    enabled: true
    cli_path: "ollama"
    default_model: "llama3"
`);
    const config = loadConfig(path);

    expect(config.providers['my-ollama'].cli_path).toBe('ollama');
    expect(config.providers['my-ollama'].default_model).toBe('llama3');
    expect(config.providers.claude).toBeDefined();
    expect(config.rateLimits.perProvider['my-ollama']).toEqual({ rpm: 20 });
  });

  it('loads and validates configuration', () => {
    const path = writeConfig(`
model_mappings:
  - alias: "m1"
    provider: "claude"
    actual_model: "x"
    reasoning_effort: "ultra-mega"
`);
    const config = loadConfig(path);
    expect(config.modelMappings[0].reasoning_effort).toBeUndefined();
  });

  it('loads and validates configuration', () => {
    const path = writeConfig(`
model_mappings:
  - alias: "m1"
    provider: "codex"
    actual_model: "x"
    provider_overrides:
      timeout_ms: 5000
      cli_path: "/evil/path"
      mode: "sdk"
`);
    const config = loadConfig(path);
    expect(config.modelMappings[0].provider_overrides).toEqual({ timeout_ms: 5000 });
  });
});

describe('loads and validates configuration', () => {
  it('loads and validates configuration', () => {
    const path = writeConfig(`
server:
  port: "abc"
`);
    expect(() => loadConfig(path)).toThrow(/server\.port/);
  });

  it('loads and validates configuration', () => {
    const path = writeConfig(`
server:
  port: 70000
`);
    expect(() => loadConfig(path)).toThrow(/server\.port/);
  });

  it('loads and validates configuration', () => {
    const path = writeConfig(`
providers:
  claude:
    timeout_ms: -1
`);
    expect(() => loadConfig(path)).toThrow(/providers\.claude\.timeout_ms/);
  });

  it('loads and validates configuration', () => {
    const path = writeConfig(`
cache:
  enabled: "yes please"
`);
    expect(() => loadConfig(path)).toThrow(/cache\.enabled/);
  });

  it('loads and validates configuration', () => {
    const path = writeConfig(`
model_mappings:
  - provider: "claude"
    actual_model: "claude-sonnet-4-6"
`);
    expect(() => loadConfig(path)).toThrow(/model_mappings/);
  });

  it('loads and validates configuration', () => {
    const path = writeConfig(`
model_mappings:
  - alias: "my-model"
    actual_model: "claude-sonnet-4-6"
`);
    expect(() => loadConfig(path)).toThrow(/model_mappings/);
  });

  it('loads and validates configuration', () => {
    const path = writeConfig(`
providers:
  claude:
    extra_args:
      - "--flag"
      - 123
`);
    expect(() => loadConfig(path)).toThrow(/extra_args/);
  });

  it('loads and validates configuration', () => {
    const path = writeConfig(`
providers:
  codex:
    mode: "turbo"
`);
    expect(() => loadConfig(path)).toThrow(/mode/);
  });

  it('loads and validates configuration', () => {
    const path = writeConfig(`
server:
  port: "abc"
`);
    expect(() => loadConfig(path)).toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

describe('loads and validates configuration', () => {
  it('loads and validates configuration', () => {

    const examplePath = join(import.meta.dirname, '../../../../config.example.yaml');
    expect(() => loadConfig(examplePath)).not.toThrow();
  });
});
