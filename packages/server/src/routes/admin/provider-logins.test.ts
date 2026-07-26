import Fastify from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  LoginProvider,
  ProviderLoginManager,
  ProviderLoginStatus,
} from '../../services/provider-login-manager.js';
import { registerProviderLoginRoutes } from './provider-logins.js';

const apps: ReturnType<typeof Fastify>[] = [];

function loginStatus(
  provider: LoginProvider,
  authenticated = false,
): ProviderLoginStatus {
  return {
    provider,
    state: authenticated ? 'authenticated' : 'unauthenticated',
    authenticated,
    message: authenticated ? 'Subscription login is ready.' : 'Not logged in.',
    lastCheckedAt: '2026-07-25T00:00:00.000Z',
  };
}

async function setup() {
  const app = Fastify();
  apps.push(app);
  await app.register(fastifyRateLimit, { global: false });
  const manager = {
    getAll: vi.fn(async () => [
      loginStatus('codex', true),
      loginStatus('grok'),
    ]),
    start: vi.fn((provider: LoginProvider) => ({
      ...loginStatus(provider),
      state: 'waiting' as const,
      message: 'Waiting for device login instructions.',
    })),
    submitCode: vi.fn((provider: LoginProvider) => ({
      ...loginStatus(provider),
      state: 'waiting' as const,
      message: 'Completing login.',
    })),
    cancel: vi.fn((provider: LoginProvider) => loginStatus(provider)),
  };
  registerProviderLoginRoutes(
    app,
    manager as unknown as ProviderLoginManager,
  );
  return { app, manager };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('provider login admin routes', () => {
  it('returns service-account status and supports a forced refresh', async () => {
    const { app, manager } = await setup();

    const response = await app.inject({
      method: 'GET',
      url: '/admin/provider-logins?refresh=1',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveLength(2);
    expect(manager.getAll).toHaveBeenCalledWith(true);
  });

  it('starts and cancels a supported provider login', async () => {
    const { app, manager } = await setup();

    const started = await app.inject({
      method: 'POST',
      url: '/admin/provider-logins/codex/start',
    });
    const cancelled = await app.inject({
      method: 'DELETE',
      url: '/admin/provider-logins/codex',
    });

    expect(started.statusCode).toBe(202);
    expect(started.json().state).toBe('waiting');
    expect(cancelled.statusCode).toBe(200);
    expect(manager.start).toHaveBeenCalledWith('codex');
    expect(manager.cancel).toHaveBeenCalledWith('codex');
  });

  it('submits a Claude authorization code without returning it', async () => {
    const { app, manager } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: '/admin/provider-logins/claude/code',
      payload: { code: 'one-time-code' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('one-time-code');
    expect(manager.submitCode).toHaveBeenCalledWith('claude', 'one-time-code');
  });

  it('rejects unsupported providers without invoking a command', async () => {
    const { app, manager } = await setup();

    const response = await app.inject({
      method: 'POST',
      url: '/admin/provider-logins/agy/start',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain('not supported');
    expect(manager.start).not.toHaveBeenCalled();
  });

  it('rate-limits provider login mutations by client address', async () => {
    const { app, manager } = await setup();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/provider-logins/codex/start',
      });
      expect(response.statusCode).toBe(202);
    }

    const limited = await app.inject({
      method: 'POST',
      url: '/admin/provider-logins/codex/start',
    });

    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(manager.start).toHaveBeenCalledTimes(10);
  });
});
