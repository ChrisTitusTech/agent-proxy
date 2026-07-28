import { describe, expect, it } from 'vitest';
import {
  classifyProviderError,
  sanitizeProviderError,
} from './provider-error.js';

describe('provider error classification', () => {
  it.each([
    ['spawn /private/provider ENOENT', 'provider_executable_missing'],
    ['Herdr worker failed: spawn codex ENOENT', 'provider_executable_missing'],
    ['Not logged in. Run login.', 'provider_login_required'],
    ['OAuth token expired and refresh failed', 'provider_login_expired'],
    ['connect ECONNREFUSED 127.0.0.1:443', 'provider_unreachable'],
    ['provider request timed out after 30000ms', 'timeout'],
    ['quota exhausted for this account', 'provider_quota_exceeded'],
    ['unknown model gpt-missing', 'provider_model_unavailable'],
    ['invalid request payload', 'provider_validation_error'],
    ['Herdr is unavailable', 'herdr_unavailable'],
    ['Herdr worker failed to spawn before startup', 'herdr_unavailable'],
    ['codex queue is full', 'provider_queue_overloaded'],
  ])('classifies %s', (message, code) => {
    expect(classifyProviderError(message, 'codex').code).toBe(code);
  });

  it('returns actionable login guidance without leaking raw provider output', () => {
    const failure = classifyProviderError(
      'Not logged in for person@example.test using sk-secretvalue123456',
      'codex',
    );
    expect(failure.message).toContain('current user');
    expect(failure.message).not.toContain('person@example.test');
    expect(failure.message).not.toContain('sk-secretvalue123456');
  });

  it('keeps client retry policy separate from provider fallback policy', () => {
    expect(classifyProviderError('Herdr is unavailable', 'codex')).toMatchObject({
      retryable: true,
      fallbackEligible: false,
    });
    expect(classifyProviderError(
      'Codex configuration routes provider traffic back to agent-proxy',
      'codex',
    ).fallbackEligible).toBe(false);
    expect(classifyProviderError('quota exhausted', 'codex')).toMatchObject({
      retryable: true,
      fallbackEligible: true,
    });
  });

  it('redacts paths, accounts, and credential-like values from fallback errors', () => {
    expect(sanitizeProviderError(
      'failure /var/lib/agent-proxy/private person@example.test sk-secretvalue123456',
    )).toBe('failure [path] [account] [credential]');
    expect(sanitizeProviderError(
      'Authorization: Bearer abcdefghijklmnop123456',
    )).toBe('Authorization: [credential]');
    expect(sanitizeProviderError(
      'api_key=genericsecret123 token: tokensecret456 '
      + 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123',
    )).not.toMatch(/genericsecret|tokensecret|eyJ/);
    expect(sanitizeProviderError(
      'spawn /usr/local/bin/codex in /srv/agent-proxy and C:\\Users\\agent\\secret',
    )).toBe('spawn [path] in [path] and [path]');
    expect(sanitizeProviderError(
      'request to https://example.test/v1 failed',
    )).toBe('request to https://example.test/v1 failed');
  });

  it('does not classify words containing sign-in or DNS substrings', () => {
    expect(classifyProviderError('The design input was rejected', 'codex').code)
      .toBe('provider_error');
    expect(classifyProviderError('dnsmasq configuration was rejected', 'codex').code)
      .toBe('provider_error');
  });
});
