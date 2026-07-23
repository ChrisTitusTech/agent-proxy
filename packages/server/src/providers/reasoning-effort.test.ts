import { describe, it, expect } from 'vitest';
import type { ExecuteOptions, ProviderConfigYaml } from '@agent-proxy/shared';
import { ClaudeProvider } from './claude-provider.js';
import { CodexProvider } from './codex-provider.js';


function baseConfig(extra: Partial<ProviderConfigYaml> = {}): ProviderConfigYaml {
  return {
    enabled: true,
    cli_path: 'cli',
    default_model: 'm',
    max_concurrent: 1,
    timeout_ms: 30000,
    extra_args: [],
    ...extra,
  };
}

function baseOptions(extra: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    model: 'm',
    stream: false,
    ...extra,
  };
}


function callBuildArgs(p: unknown, opts: ExecuteOptions): string[] {
  return (p as { buildArgs: (o: ExecuteOptions) => string[] }).buildArgs(opts);
}

describe('ClaudeProvider buildArgs — reasoning_effort', () => {
  it('maps provider reasoning effort', () => {
    const p = new ClaudeProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions());
    expect(args).not.toContain('--effort');
  });

  it('maps provider reasoning effort', () => {
    const p = new ClaudeProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'high' }));
    const idx = args.indexOf('--effort');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe('high');
  });

  it('maps provider reasoning effort', () => {
    const p = new ClaudeProvider(baseConfig());
    expect(callBuildArgs(p, baseOptions({ reasoningEffort: 'xhigh' }))).toContain('xhigh');
    expect(callBuildArgs(p, baseOptions({ reasoningEffort: 'max' }))).toContain('max');
  });

  it('maps provider reasoning effort', () => {
    const p = new ClaudeProvider(baseConfig({ extra_args: ['--effort', 'low'] }));
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'high' }));

    const occurrences = args.filter((a) => a === '--effort').length;
    expect(occurrences).toBe(1);
  });
});

describe('CodexProvider buildArgs — reasoning_effort', () => {
  it('maps provider reasoning effort', () => {
    const p = new CodexProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions());
    expect(args.some((a) => a.startsWith('model_reasoning_effort'))).toBe(false);
  });

  it('maps provider reasoning effort', () => {
    const p = new CodexProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'medium' }));
    expect(args).toContain('-c');
    expect(args).toContain('model_reasoning_effort=medium');
  });

  it('maps provider reasoning effort', () => {
    const p = new CodexProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'xhigh' }));
    expect(args).toContain('model_reasoning_effort=high');
  });

  it('maps provider reasoning effort', () => {
    const p = new CodexProvider(baseConfig());
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'max' }));
    expect(args).toContain('model_reasoning_effort=high');
  });

  it('maps provider reasoning effort', () => {
    const p = new CodexProvider(baseConfig({
      extra_args: ['-c', 'model_reasoning_effort=low'],
    }));
    const args = callBuildArgs(p, baseOptions({ reasoningEffort: 'high' }));
    const efforts = args.filter((a) => a.startsWith('model_reasoning_effort='));
    expect(efforts).toEqual(['model_reasoning_effort=low']);
  });
});
