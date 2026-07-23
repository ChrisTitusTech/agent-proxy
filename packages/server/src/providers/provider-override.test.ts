import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ProviderConfigYaml, ProviderOverrides } from '@agent-proxy/shared';
import { mergeProviderConfig, _resetOverrideWarnCache } from './provider-override.js';

function baseConfig(extra: Partial<ProviderConfigYaml> = {}): ProviderConfigYaml {
  return {
    enabled: true,
    cli_path: 'codex',
    default_model: 'gpt-5.6-sol',
    max_concurrent: 10,
    timeout_ms: 300000,
    extra_args: ['--skip-git-repo-check'],
    cli_options: { ephemeral: true },
    ...extra,
  };
}

describe('mergeProviderConfig', () => {
  beforeEach(() => {
    _resetOverrideWarnCache();
  });

  it('merges provider overrides safely', () => {
    const base = baseConfig();
    const merged = mergeProviderConfig(base, undefined, 'codex');
    expect(merged).toEqual(base);
    expect(merged).not.toBe(base);
  });

  it('merges provider overrides safely', () => {
    const base = baseConfig();
    const merged = mergeProviderConfig(base, {}, 'codex');
    expect(merged).toEqual(base);
  });

  it('merges provider overrides safely', () => {
    const base = baseConfig({ cli_options: { ephemeral: true } });
    const overrides: ProviderOverrides = {
      cli_options: { enable_session_reuse: true, session_ttl_ms: 3600000 },
    };
    const merged = mergeProviderConfig(base, overrides, 'codex');
    expect(merged.cli_options).toEqual({
      ephemeral: true,
      enable_session_reuse: true,
      session_ttl_ms: 3600000,
    });
  });

  it('merges provider overrides safely', () => {
    const base = baseConfig({ cli_options: { ephemeral: true } });
    const overrides: ProviderOverrides = { cli_options: { ephemeral: false } };
    const merged = mergeProviderConfig(base, overrides, 'codex');
    expect(merged.cli_options?.ephemeral).toBe(false);
  });

  it('merges provider overrides safely', () => {
    const base = baseConfig({ extra_args: ['--a', '--b'] });
    const overrides: ProviderOverrides = { extra_args: ['--c'] };
    const merged = mergeProviderConfig(base, overrides, 'codex');
    expect(merged.extra_args).toEqual(['--c']);
  });

  it('merges provider overrides safely', () => {
    const base = baseConfig();
    const overrides: ProviderOverrides = { timeout_ms: 60000, working_dir: '/tmp/x' };
    const merged = mergeProviderConfig(base, overrides, 'codex');
    expect(merged.timeout_ms).toBe(60000);
    expect(merged.working_dir).toBe('/tmp/x');
  });

  it('merges provider overrides safely', () => {
    const base = baseConfig({ cli_options: { ephemeral: true }, extra_args: ['--keep'] });
    const baseSnapshot = JSON.parse(JSON.stringify(base));
    mergeProviderConfig(base, {
      extra_args: ['--new'],
      cli_options: { ephemeral: false },
    }, 'codex');
    expect(base).toEqual(baseSnapshot);
  });

  it('merges provider overrides safely', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const base = baseConfig();
    const merged = mergeProviderConfig(
      base,
      { cli_options: { ephemeral: false } },
      'unknown-provider',
    );
    expect(merged).toEqual(base);
    expect(warn).toHaveBeenCalledTimes(1);

    mergeProviderConfig(base, { cli_options: { ephemeral: false } }, 'unknown-provider');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('merges provider overrides safely', () => {
    const base = baseConfig({
      cli_path: 'claude',
      default_model: 'claude-sonnet-5',
      channel_options: {
        endpoint_url: 'http://old.example',
        poll_interval_ms: 1000,
      },
    });
    const overrides: ProviderOverrides = {
      mode: 'channel-worker',
      channel_options: {
        endpoint_url: 'http://127.0.0.1:8788',
        result_timeout_ms: 120000,
        isolation: 'external',
      },
    };

    const merged = mergeProviderConfig(base, overrides, 'claude');

    expect(merged.mode).toBe('channel-worker');
    expect(merged.channel_options).toEqual({
      endpoint_url: 'http://127.0.0.1:8788',
      poll_interval_ms: 1000,
      result_timeout_ms: 120000,
      isolation: 'external',
    });
  });
});
