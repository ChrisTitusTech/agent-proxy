import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import type { ExecuteOptions, ProviderConfigYaml } from '@agent-proxy/shared';
import { CodexProvider } from './codex-provider.js';

const codexInstalled = (() => {
  try {
    execSync('which codex', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const codexIntegrationEnabled =
  process.env.RUN_CODEX_INTEGRATION === '1' && codexInstalled;

function baseCodexConfig(extra: Partial<ProviderConfigYaml> = {}): ProviderConfigYaml {
  return {
    enabled: true,
    cli_path: 'codex',
    default_model: 'gpt-5.6-sol',
    max_concurrent: 1,
    timeout_ms: 120000,
    extra_args: ['--skip-git-repo-check', '-s', 'read-only'],
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

describe.skipIf(!codexIntegrationEnabled)('CodexProvider CLI resume (integration)', () => {
  let provider: CodexProvider;

  beforeAll(() => {
    provider = new CodexProvider(baseCodexConfig());
  });

  afterAll(() => {
    provider.destroyCliSessionManager();
  });

  it('reuses Codex CLI sessions', async () => {
    const clientKey = `test-A-${Date.now()}`;
    const options = (msg: string) => baseOptions({
      messages: [{ role: 'user', content: msg }],
      clientKey,
      providerOverrides: {
        cli_options: { enable_session_reuse: true, session_ttl_ms: 60_000 },
      },
    });


    const r1 = await provider.execute(options('My name is BarTest and my favorite number is 42. Reply with a short greeting.'));
    expect(r1.meta?.threadId).toBeTruthy();
    expect(r1.meta?.threadReused).toBe(false);
    const threadId1 = r1.meta!.threadId!;


    const r2 = await provider.execute(options('What was my name? Answer with one word.'));
    expect(r2.meta?.threadId).toBe(threadId1);
    expect(r2.meta?.threadReused).toBe(true);
    expect(r2.content.toLowerCase()).toContain('bartest');
  }, 180_000);

  it('reuses Codex CLI sessions', () => {
    const sm = provider.getCliSessionManager();

    const argsResume = (provider as any).buildArgs(baseOptions({
      clientKey: 'shared-X',
      providerOverrides: { cli_options: { enable_session_reuse: true } },
    }));

    expect(argsResume).not.toContain('resume');


    if (sm) sm.set('shared-X', 'tid-DUMMY', 'gpt-5.6-sol');
    const argsNoReuse = (provider as any).buildArgs(baseOptions({
      clientKey: 'shared-X',
      providerOverrides: { cli_options: { enable_session_reuse: false } },
    }));
    expect(argsNoReuse).not.toContain('resume');
    expect(argsNoReuse[0]).toBe('exec');
    expect(argsNoReuse[1]).toBe('--json');
  });
});

describe.skipIf(codexIntegrationEnabled)('CodexProvider CLI resume (integration) - opt-in disabled', () => {
  it('placeholder', () => {
    expect(codexIntegrationEnabled).toBe(false);
  });
});
