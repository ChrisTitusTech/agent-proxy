import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '@agent-proxy/shared';
import { runPreflightChecks } from './preflight.js';

let tempDir: string;

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  const configPath = join(tempDir, 'config.yaml');
  writeFileSync(configPath, '---\n', 'utf8');
  const executable = join(tempDir, 'codex');
  writeFileSync(executable, '#!/bin/sh\nexit 0\n', 'utf8');
  chmodSync(executable, 0o700);

  return {
    server: { host: '127.0.0.1', port: 8300, cors: { origins: [] } },
    dashboard: { host: '127.0.0.1', port: 5300 },
    database: { path: join(tempDir, 'state', 'agent-proxy.db') },
    auth: {
      enabled: true,
      adminToken: 'admin-token',
      initialKeys: [{ name: 'default', key: 'sk-proxy-test' }],
    },
    providers: {
      codex: {
        enabled: true,
        cli_path: 'codex',
        default_model: 'test',
        max_concurrent: 1,
        timeout_ms: 30_000,
        extra_args: [],
      },
    },
    rateLimits: { global: { rpm: 60, rpd: 1_000 }, perProvider: {} },
    cache: { enabled: false, ttlSeconds: 60, maxEntries: 10 },
    validation: {
      maxMessageCount: 10,
      maxMessageLength: 1_000,
      maxPromptLength: 10_000,
      maxResponseLength: 10_000,
      bodyLimitBytes: 1_000_000,
    },
    modelMappings: [],
    ...overrides,
  };
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'agent-proxy-preflight-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('runPreflightChecks', () => {
  it('resolves enabled CLIs and creates the writable state directory', () => {
    const appConfig = config();
    const result = runPreflightChecks(appConfig, {
      configPath: join(tempDir, 'config.yaml'),
      path: tempDir,
    });

    expect(result.executables.codex).toBe(join(tempDir, 'codex'));
    expect(result.stateDirectory).toBe(join(tempDir, 'state'));
  });

  it('reports every actionable startup problem', () => {
    const appConfig = config({
      auth: {
        enabled: true,
        adminToken: '',
        initialKeys: [{ name: 'default', key: '' }],
      },
      providers: {
        codex: {
          enabled: true,
          cli_path: 'missing-codex',
          default_model: 'test',
          max_concurrent: 1,
          timeout_ms: 30_000,
          extra_args: [],
          working_dir: join(tempDir, 'missing-workdir'),
        },
      },
    });

    expect(() => runPreflightChecks(appConfig, {
      configPath: join(tempDir, 'missing-config.yaml'),
      path: tempDir,
    })).toThrow(/Configuration file does not exist[\s\S]*auth\.admin_token[\s\S]*initial_keys\[0\][\s\S]*cli_path[\s\S]*working_dir/);
  });

  it('ignores unavailable disabled providers', () => {
    const appConfig = config({
      providers: {
        agy: {
          enabled: false,
          cli_path: 'missing-agy',
          default_model: 'antigravity',
          max_concurrent: 1,
          timeout_ms: 30_000,
          extra_args: [],
        },
      },
    });

    expect(() => runPreflightChecks(appConfig, {
      configPath: join(tempDir, 'config.yaml'),
      path: tempDir,
    })).not.toThrow();
  });

  it('rejects shipped placeholder credentials', () => {
    const appConfig = config({
      auth: {
        enabled: true,
        adminToken: 'replace-with-at-least-32-random-bytes',
        initialKeys: [{
          name: 'default',
          key: 'sk-proxy-replace-with-at-least-24-random-bytes',
        }],
      },
    });

    expect(() => runPreflightChecks(appConfig, {
      configPath: join(tempDir, 'config.yaml'),
      path: tempDir,
    })).toThrow(/admin_token still contains a placeholder[\s\S]*initial_keys\[0\]\.key still contains a placeholder/);
  });

  it('requires the admin token when data-plane authentication is disabled', () => {
    const appConfig = config({
      auth: {
        enabled: false,
        adminToken: '',
        initialKeys: [],
      },
    });

    expect(() => runPreflightChecks(appConfig, {
      configPath: join(tempDir, 'config.yaml'),
      path: tempDir,
    })).toThrow(/auth\.admin_token must not be empty/);
  });
});
