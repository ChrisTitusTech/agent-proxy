import { describe, it, expect, afterEach, vi } from 'vitest';
import type { ExecuteOptions, ProviderConfigYaml } from '@agent-proxy/shared';
import { providerExecutionIdentity } from './base-provider.js';
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

  it('disables the complete native tool surface for external tool selection', () => {
    provider = new CodexProvider(baseConfig({
      extra_args: ['--disable', 'shell_tool'],
    }));
    const args: string[] = (provider as any).buildArgs(baseOptions({
      extraBody: { __agentProxyExternalToolSelection: true },
    }));

    const disabled = args.flatMap((arg, index) => (
      arg === '--disable' ? [args[index + 1]] : []
    ));
    expect(disabled.filter((feature) => feature === 'shell_tool')).toHaveLength(1);
    expect(disabled).toEqual(expect.arrayContaining([
      'apply_patch_freeform',
      'apply_patch_streaming_events',
      'apps',
      'browser_use',
      'code_mode',
      'code_mode_host',
      'computer_use',
      'image_generation',
      'multi_agent',
      'shell_tool',
      'unified_exec',
    ]));
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
    sm!.set(
      'client-a',
      'tid-XYZ',
      'gpt-5.6-sol',
      providerExecutionIdentity(provider.getEffectiveConfig(options)),
    );


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
    sm.set(
      'a',
      'tid-A',
      'gpt-5.6-sol',
      providerExecutionIdentity(provider.getEffectiveConfig(opt('a'))),
    );

    const argsB: string[] = (provider as any).buildArgs(opt('b'));
    expect(argsB).not.toContain('resume');

    const argsA: string[] = (provider as any).buildArgs(opt('a'));
    expect(argsA[1]).toBe('resume');
    expect(argsA[2]).toBe('tid-A');
  });

  it('does not resume a thread across different permission arguments', () => {
    provider = new CodexProvider(baseConfig());
    const permissive = baseOptions({
      clientKey: 'client-a',
      providerOverrides: {
        extra_args: ['--sandbox', 'workspace-write'],
        cli_options: { enable_session_reuse: true },
      },
    });
    (provider as any).buildArgs(permissive);
    provider.getCliSessionManager()!.set(
      'client-a',
      'tid-permissive',
      'gpt-5.6-sol',
      providerExecutionIdentity(provider.getEffectiveConfig(permissive)),
    );

    const restrictedArgs: string[] = (provider as any).buildArgs(baseOptions({
      clientKey: 'client-a',
      providerOverrides: {
        extra_args: ['--sandbox', 'read-only'],
        cli_options: { enable_session_reuse: true },
      },
    }));

    expect(restrictedArgs).not.toContain('resume');
    expect(restrictedArgs).toContain('read-only');
  });

  it('serializes thread selection for concurrent reusable-session turns', async () => {
    provider = new CodexProvider(baseConfig());
    const options = baseOptions({
      clientKey: 'shared-session',
      providerOverrides: { cli_options: { enable_session_reuse: true } },
    });
    const builtArgs: string[][] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    (provider as any).executeWithoutExternalTools = async (
      current: ExecuteOptions,
    ) => {
      const args = (provider as any).buildArgs(current) as string[];
      builtArgs.push(args);
      if (builtArgs.length === 1) {
        await firstBlocked;
        provider!.getCliSessionManager()!.set(
          current.clientKey!,
          'tid-first',
          current.model,
          providerExecutionIdentity(provider!.getEffectiveConfig(current)),
        );
      }
      return {
        content: 'done',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: 'stop',
      };
    };

    const first = provider.execute(options);
    await vi.waitFor(() => expect(builtArgs).toHaveLength(1));
    const second = provider.execute(options);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(builtArgs).toHaveLength(1);

    releaseFirst();
    await Promise.all([first, second]);
    expect(builtArgs[1].slice(0, 3)).toEqual([
      'exec',
      'resume',
      'tid-first',
    ]);
  });
});
