import { describe, expect, it } from 'vitest';
import { getProviderEnvironment } from './provider-env.js';

describe('getProviderEnvironment', () => {
  it('keeps only runtime variables and credentials for the target provider', () => {
    const source = {
      ADMIN_TOKEN: 'admin-secret',
      PROXY_API_KEY: 'proxy-secret',
      CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'claude-secret',
      DATABASE_URL: 'postgres://deployment-secret',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      OPENAI_API_KEY: 'provider-secret',
      XAI_API_KEY: 'xai-secret',
      GOOGLE_API_KEY: 'google-secret',
      PATH: '/usr/bin',
    };

    expect(getProviderEnvironment('codex', source)).toEqual({
      OPENAI_API_KEY: 'provider-secret',
      PATH: '/usr/bin',
    });
    expect(getProviderEnvironment('claude', source)).toEqual({
      ANTHROPIC_API_KEY: 'anthropic-secret',
      PATH: '/usr/bin',
    });
    expect(getProviderEnvironment('grok', source)).toEqual({
      PATH: '/usr/bin',
      XAI_API_KEY: 'xai-secret',
    });
    expect(getProviderEnvironment('agy', source)).toEqual({
      GOOGLE_API_KEY: 'google-secret',
      PATH: '/usr/bin',
    });
  });
});
