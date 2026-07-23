import { describe, it, expect, afterEach } from 'vitest';
import type { ExecuteOptions, ProviderConfigYaml } from '@agent-proxy/shared';
import { CodexProvider, filterResumeUnsupportedArgs } from './codex-provider.js';

function baseConfig(extra: Partial<ProviderConfigYaml> = {}): ProviderConfigYaml {
  return {
    enabled: true,
    cli_path: 'codex',
    default_model: 'gpt-5.6-sol',
    max_concurrent: 1,
    timeout_ms: 30000,
    extra_args: ['--skip-git-repo-check', '-s', 'workspace-write'],
    ...extra,
  };
}

function baseOptions(extra: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    model: 'gpt-5.6-sol',
    stream: false,
    ...extra,
  };
}

describe('filterResumeUnsupportedArgs', () => {
  it('removes -s and its value', () => {
    expect(filterResumeUnsupportedArgs(['--keep', '-s', 'workspace-write', '--end']))
      .toEqual(['--keep', '--end']);
  });

  it('removes --sandbox=read-only (= form)', () => {
    expect(filterResumeUnsupportedArgs(['--sandbox=read-only', '--keep']))
      .toEqual(['--keep']);
  });

  it('removes --add-dir and its value', () => {
    expect(filterResumeUnsupportedArgs(['--add-dir', '/tmp', '--ok']))
      .toEqual(['--ok']);
  });

  it('removes standalone --oss', () => {
    expect(filterResumeUnsupportedArgs(['--oss', '--keep'])).toEqual(['--keep']);
  });

  it('keeps unrelated args', () => {
    expect(filterResumeUnsupportedArgs(['--skip-git-repo-check', '-c', 'x=y']))
      .toEqual(['--skip-git-repo-check', '-c', 'x=y']);
  });
});

describe('CodexProvider buildArgs (resume branch)', () => {
  let provider: CodexProvider | null = null;

  afterEach(() => {
    provider?.destroyCliSessionManager();
    provider = null;
  });

  it('builds Codex resume arguments', () => {
    provider = new CodexProvider(baseConfig());
    const args = (provider as any).buildArgs(baseOptions({ clientKey: undefined }));
    expect(args[0]).toBe('exec');
    expect(args).toContain('--json');
    expect(args).not.toContain('resume');
  });

  it('builds Codex resume arguments', () => {
    provider = new CodexProvider(baseConfig());
    const args = (provider as any).buildArgs(baseOptions({
      clientKey: 'client-a',
      providerOverrides: { cli_options: { enable_session_reuse: true } },
    }));
    expect(args[0]).toBe('exec');
    expect(args[1]).toBe('--json');
    expect(args).not.toContain('resume');
  });

  it('builds Codex resume arguments', () => {
    provider = new CodexProvider(baseConfig());
    const options = baseOptions({
      clientKey: 'client-a',
      providerOverrides: { cli_options: { enable_session_reuse: true } },
    });


    (provider as any).buildArgs(options);
    const sm = provider.getCliSessionManager();
    expect(sm).not.toBeNull();
    sm!.set('client-a', 'tid-XYZ', 'gpt-5.6-sol');


    const args2: string[] = (provider as any).buildArgs(options);
    expect(args2[0]).toBe('exec');
    expect(args2[1]).toBe('resume');
    expect(args2[2]).toBe('tid-XYZ');
    expect(args2).toContain('--json');

    expect(args2).not.toContain('-s');
    expect(args2).not.toContain('workspace-write');

    expect(args2).toContain('--skip-git-repo-check');
    expect(args2).toContain('-m');
    expect(args2).toContain('gpt-5.6-sol');
  });

  it('builds Codex resume arguments', () => {
    provider = new CodexProvider(baseConfig({
      cli_options: { ephemeral: true },
    }));
    const args: string[] = (provider as any).buildArgs(baseOptions({
      clientKey: 'client-x',
      providerOverrides: { cli_options: { enable_session_reuse: true, ephemeral: true } },
    }));
    expect(args).not.toContain('--ephemeral');
  });

  it('builds Codex resume arguments', () => {
    provider = new CodexProvider(baseConfig({
      cli_options: {},
    }));
    const args: string[] = (provider as any).buildArgs(baseOptions({
      clientKey: 'client-y',
      providerOverrides: { cli_options: { enable_session_reuse: true } },
    }));
    expect(args).not.toContain('--ephemeral');
  });

  it('builds Codex resume arguments', () => {
    provider = new CodexProvider(baseConfig({ extra_args: ['--old'] }));
    const args: string[] = (provider as any).buildArgs(baseOptions({
      providerOverrides: { extra_args: ['--new'] },
    }));
    expect(args).toContain('--new');
    expect(args).not.toContain('--old');
  });

  it('builds Codex resume arguments', () => {
    provider = new CodexProvider(baseConfig());
    const opt = (key: string) => baseOptions({
      clientKey: key,
      providerOverrides: { cli_options: { enable_session_reuse: true } },
    });
    (provider as any).buildArgs(opt('a'));
    const sm = provider.getCliSessionManager()!;
    sm.set('a', 'tid-A', 'gpt-5.6-sol');

    const argsB: string[] = (provider as any).buildArgs(opt('b'));
    expect(argsB).not.toContain('resume');

    const argsA: string[] = (provider as any).buildArgs(opt('a'));
    expect(argsA[1]).toBe('resume');
    expect(argsA[2]).toBe('tid-A');
  });
});
