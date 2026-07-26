import { describe, expect, it } from 'vitest';
import {
  classifyProviderLoginFailure,
  hasGrokCredential,
  parseDeviceLoginOutput,
} from './provider-login-manager.js';

describe('provider device-login output parsing', () => {
  it('extracts the Claude OAuth URL without exposing terminal control sequences', () => {
    expect(parseDeviceLoginOutput('claude', `
      \u001B]8;;https://claude.com/cai/oauth/authorize?code=true&state=test\u0007link\u001B]8;;\u0007
      https://claude.com/cai/oauth/authorize?code=true&state=test
    `)).toEqual({
      verificationUri: 'https://claude.com/cai/oauth/authorize?code=true&state=test',
    });
  });

  it('extracts only the Codex verification URL and one-time code', () => {
    expect(parseDeviceLoginOutput('codex', `
      Open https://auth.openai.com/codex/device
      Enter ABCD-12345
    `)).toEqual({
      verificationUri: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-12345',
    });
  });

  it('extracts the Grok device URL and code', () => {
    expect(parseDeviceLoginOutput('grok', `
      https://accounts.x.ai/oauth2/device?user_code=ABCD-1234
      Confirm ABCD-1234
    `)).toEqual({
      verificationUri: 'https://accounts.x.ai/oauth2/device?user_code=ABCD-1234',
      userCode: 'ABCD-1234',
    });
  });
});

describe('provider login error classification', () => {
  it('distinguishes missing, expired, and network login failures', () => {
    expect(classifyProviderLoginFailure('claude', 'Not logged in')).toContain('not logged in');
    expect(classifyProviderLoginFailure('codex', 'Not logged in')).toContain('not logged in');
    expect(classifyProviderLoginFailure('grok', '401 invalid token: expired')).toContain('expired');
    expect(classifyProviderLoginFailure('codex', 'network connection refused')).toContain('network');
  });

  it('does not echo provider output in fallback errors', () => {
    const secret = 'sensitive-account@example.test';
    expect(classifyProviderLoginFailure('grok', secret)).not.toContain(secret);
  });
});

describe('Grok credential readiness', () => {
  it('requires an API key or the headless service credential file', () => {
    expect(hasGrokCredential({ HOME: '/service' }, () => false)).toBe(false);
    expect(hasGrokCredential({ HOME: '/service', XAI_API_KEY: 'configured' }, () => false))
      .toBe(true);
    expect(hasGrokCredential(
      { HOME: '/service' },
      (path) => path === '/service/.grok/auth.json',
    )).toBe(true);
  });
});
