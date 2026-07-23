import { describe, it, expect } from 'vitest';
import { redactSecrets } from './debug.js';

describe('redactSecrets', () => {
  it('redacts agent-proxy API keys', () => {
    expect(redactSecrets('key=sk-proxy-abc123XYZ')).toContain('sk-proxy-[redacted]');
    expect(redactSecrets('sk-proxy-abc123XYZ')).not.toContain('abc123XYZ');
  });

  it('redacts bearer tokens', () => {
    expect(redactSecrets('Authorization: Bearer abc.def-ghi_123')).toContain('Bearer [redacted]');
  });

  it('redacts sensitive JSON headers', () => {
    const json = '{"x-admin-token":"supersecret","authorization":"tok123"}';
    const out = redactSecrets(json);
    expect(out).toContain('"x-admin-token":"[redacted]"');
    expect(out).toContain('"authorization":"[redacted]"');
    expect(out).not.toContain('supersecret');
  });

  it('redacts environment-style secrets', () => {
    expect(redactSecrets('OPENAI_API_KEY=sk-realvalue123')).toContain('OPENAI_API_KEY=[redacted]');
    expect(redactSecrets('MY_SECRET=hunter2')).toContain('MY_SECRET=[redacted]');
  });

  it('redacts known provider credential formats', () => {
    const repeatedA = 'A'.repeat(24);
    const anthropicKey = `sk-ant-api03-${repeatedA}`;
    const awsKey = `AKIA${'A'.repeat(16)}`;
    const googleKey = `AIza${'A'.repeat(35)}`;
    const githubToken = `ghp_${'0'.repeat(40)}`;
    const xaiKey = `xai-${'a'.repeat(20)}`;

    expect(redactSecrets(`My key is ${anthropicKey}`)).not.toContain(repeatedA);
    expect(redactSecrets(awsKey)).toContain('AKIA[redacted]');
    expect(redactSecrets(googleKey)).toContain('AIza[redacted]');
    expect(redactSecrets(githubToken)).toContain('gh_[redacted]');
    expect(redactSecrets(xaiKey)).toContain('xai-[redacted]');
  });

  it('preserves ordinary text', () => {
    const plain = 'Hello. What is the weather today? skiing is fun.';
    expect(redactSecrets(plain)).toBe(plain);
  });
});
