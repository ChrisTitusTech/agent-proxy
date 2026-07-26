import { describe, expect, it } from 'vitest';
import {
  classifyProviderError,
  sanitizeProviderError,
} from './provider-error.js';

describe('provider error classification', () => {
  it.each([
    ['spawn /private/provider ENOENT', 'provider_executable_missing'],
    ['Not logged in. Run login.', 'provider_login_required'],
    ['OAuth token expired and refresh failed', 'provider_login_expired'],
    ['connect ECONNREFUSED 127.0.0.1:443', 'provider_unreachable'],
    ['provider request timed out after 30000ms', 'timeout'],
  ])('classifies %s', (message, code) => {
    expect(classifyProviderError(message, 'codex').code).toBe(code);
  });

  it('returns actionable login guidance without leaking raw provider output', () => {
    const failure = classifyProviderError(
      'Not logged in for person@example.test using sk-secretvalue123456',
      'codex',
    );
    expect(failure.message).toContain('Dashboard > Provider Login');
    expect(failure.message).not.toContain('person@example.test');
    expect(failure.message).not.toContain('sk-secretvalue123456');
  });

  it('redacts paths, accounts, and credential-like values from fallback errors', () => {
    expect(sanitizeProviderError(
      'failure /var/lib/agent-proxy/private person@example.test sk-secretvalue123456',
    )).toBe('failure [path] [account] [credential]');
    expect(sanitizeProviderError(
      'Authorization: Bearer abcdefghijklmnop123456',
    )).toBe('Authorization: [credential]');
  });
});
