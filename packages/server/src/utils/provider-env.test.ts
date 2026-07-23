import { describe, expect, it } from 'vitest';
import { getProviderEnvironment } from './provider-env.js';

describe('getProviderEnvironment', () => {
  it('removes gateway secrets and nested Claude session variables', () => {
    const environment = getProviderEnvironment({
      ADMIN_TOKEN: 'admin-secret',
      PROXY_API_KEY: 'proxy-secret',
      CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'claude-secret',
      DATABASE_URL: 'postgres://deployment-secret',
      OPENAI_API_KEY: 'provider-secret',
      PATH: '/usr/bin',
    });

    expect(environment).toEqual({
      OPENAI_API_KEY: 'provider-secret',
      PATH: '/usr/bin',
    });
  });
});
