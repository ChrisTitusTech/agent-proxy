import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { extractClientKey } from './client-key.js';

function request(headers: Record<string, string>): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

describe('extractClientKey', () => {
  it('uses the explicit agent-proxy session header first', () => {
    expect(extractClientKey(request({
      'x-agent-proxy-session-id': 'proxy-session',
      'x-claude-code-session-id': 'claude-session',
    }), 'key-1')).toBe('key:key-1|session:proxy-session');
  });

  it('uses Claude Code session identity when the proxy header is absent', () => {
    expect(extractClientKey(request({
      'x-claude-code-session-id': 'claude-session',
    }), 'key-1')).toBe('key:key-1|session:claude-session');
  });

  it('rejects unsafe client session values', () => {
    expect(extractClientKey(request({
      'x-claude-code-session-id': 'unsafe session value',
    }), 'key-1')).toBe('key:key-1');
  });
});
