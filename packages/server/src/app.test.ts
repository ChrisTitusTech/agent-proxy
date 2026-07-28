import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { AppConfig } from '@agent-proxy/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDatabase } from './db/client.js';
import type { ProviderExecutionBackend } from './herdr/launcher.js';
import { createApp, type AgentProxyApp } from './app.js';

let app: AgentProxyApp | undefined;
let directory: string | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  closeDatabase();
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('application health authentication', () => {
  it('keeps detailed readiness behind the admin hook', async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'agent-proxy-app-'));
    const config: AppConfig = {
      server: { host: '127.0.0.1', port: 8300, cors: { origins: [] } },
      dashboard: { host: '127.0.0.1', port: 5300 },
      database: { path: resolve(directory, 'agent-proxy.db') },
      herdr: {
        binary: 'herdr',
        runtimeDirectory: resolve(directory, 'runtime'),
        workspaceLabel: 'agent-proxy',
        commandTimeoutMs: 1_000,
        paneTtlMs: 30_000,
        maxPanes: 4,
      },
      auth: {
        enabled: true,
        adminToken: 'admin-token-for-app-test',
        initialKeys: [],
      },
      providers: {},
      rateLimits: { global: { rpm: 60, rpd: 1_000 }, perProvider: {} },
      cache: { enabled: false, ttlSeconds: 60, maxEntries: 10 },
      responses: { retentionTtlMs: 60_000, maxEntries: 10 },
      validation: {
        maxMessageCount: 10,
        maxMessageLength: 1_000,
        maxPromptLength: 10_000,
        maxResponseLength: 10_000,
        bodyLimitBytes: 1_000_000,
      },
      modelMappings: [],
    };
    const executionBackend: ProviderExecutionBackend = {
      readiness: async () => ({
        ready: true,
        version: 'fixture',
        protocol: 17,
      }),
      start: async () => {
        throw new Error('Health checks must not start providers.');
      },
      shutdown: async () => undefined,
    };
    app = await createApp(config, { executionBackend });

    const liveness = await app.inject({ method: 'GET', url: '/health' });
    expect(liveness.statusCode).toBe(200);
    expect(liveness.json()).toEqual({ status: 'ok' });

    const denied = await app.inject({ method: 'GET', url: '/admin/health' });
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain('fixture');

    const allowed = await app.inject({
      method: 'GET',
      url: '/admin/health',
      headers: { 'x-admin-token': config.auth.adminToken },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      status: 'ready',
      herdr: { ready: true, version: 'fixture', protocol: 17 },
    });
  });

  it('reports an enabled provider executable failure without starting an agent', async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'agent-proxy-app-'));
    const config: AppConfig = {
      server: { host: '127.0.0.1', port: 8300, cors: { origins: [] } },
      dashboard: { host: '127.0.0.1', port: 5300 },
      database: { path: resolve(directory, 'agent-proxy.db') },
      herdr: {
        binary: 'herdr',
        runtimeDirectory: resolve(directory, 'runtime'),
        workspaceLabel: 'agent-proxy',
        commandTimeoutMs: 1_000,
        paneTtlMs: 30_000,
        maxPanes: 4,
      },
      auth: {
        enabled: true,
        adminToken: 'admin-token-for-app-test',
        initialKeys: [],
      },
      providers: {
        codex: {
          enabled: true,
          cli_path: resolve(directory, 'missing-codex'),
          default_model: 'gpt-test',
          max_concurrent: 1,
          max_queue_size: 1,
          max_queue_wait_ms: 1_000,
          timeout_ms: 1_000,
          extra_args: [],
        },
      },
      rateLimits: { global: { rpm: 60, rpd: 1_000 }, perProvider: { codex: { rpm: 20 } } },
      cache: { enabled: false, ttlSeconds: 60, maxEntries: 10 },
      responses: { retentionTtlMs: 60_000, maxEntries: 10 },
      validation: {
        maxMessageCount: 10,
        maxMessageLength: 1_000,
        maxPromptLength: 10_000,
        maxResponseLength: 10_000,
        bodyLimitBytes: 1_000_000,
      },
      modelMappings: [],
    };
    let starts = 0;
    const executionBackend: ProviderExecutionBackend = {
      readiness: async () => ({ ready: true }),
      start: async () => {
        starts++;
        throw new Error('Health checks must not start providers.');
      },
      shutdown: async () => undefined,
    };
    app = await createApp(config, { executionBackend });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/health',
      headers: { 'x-admin-token': config.auth.adminToken },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'unavailable',
      providers: [{ name: 'codex', health: 'unhealthy' }],
    });
    expect(starts).toBe(0);
  });

  it('treats an unknown login state as not ready', async () => {
    directory = await mkdtemp(resolve(tmpdir(), 'agent-proxy-app-'));
    const cliPath = resolve(directory, 'codex');
    await writeFile(cliPath, '#!/bin/sh\nsleep 2\n', 'utf8');
    await chmod(cliPath, 0o700);
    const config: AppConfig = {
      server: { host: '127.0.0.1', port: 8300, cors: { origins: [] } },
      dashboard: { host: '127.0.0.1', port: 5300 },
      database: { path: resolve(directory, 'agent-proxy.db') },
      herdr: {
        binary: 'herdr',
        runtimeDirectory: resolve(directory, 'runtime'),
        workspaceLabel: 'agent-proxy',
        commandTimeoutMs: 1_000,
        paneTtlMs: 30_000,
        maxPanes: 4,
      },
      auth: {
        enabled: true,
        adminToken: 'admin-token-for-app-test',
        initialKeys: [],
      },
      providers: {
        codex: {
          enabled: true,
          cli_path: cliPath,
          default_model: 'gpt-test',
          max_concurrent: 1,
          timeout_ms: 1_000,
          extra_args: [],
        },
      },
      rateLimits: { global: { rpm: 60, rpd: 1_000 }, perProvider: {} },
      cache: { enabled: false, ttlSeconds: 60, maxEntries: 10 },
      responses: { retentionTtlMs: 60_000, maxEntries: 10 },
      validation: {
        maxMessageCount: 10,
        maxMessageLength: 1_000,
        maxPromptLength: 10_000,
        maxResponseLength: 10_000,
        bodyLimitBytes: 1_000_000,
      },
      modelMappings: [],
    };
    app = await createApp(config, {
      executionBackend: {
        readiness: async () => ({ ready: true }),
        start: async () => {
          throw new Error('Health checks must not start providers.');
        },
        shutdown: async () => undefined,
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/admin/health',
      headers: { 'x-admin-token': config.auth.adminToken },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'unavailable',
      providers: [{ name: 'codex', health: 'healthy' }],
    });
  });
});
