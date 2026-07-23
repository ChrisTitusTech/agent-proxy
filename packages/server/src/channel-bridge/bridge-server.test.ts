import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./pty-session.js', () => ({
  runClaudeJob: vi.fn((
    _prompt: string,
    _config: unknown,
    signal?: AbortSignal,
  ) => new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('Request cancelled')), {
      once: true,
    });
  })),
}));

import { ChannelBridge, type BridgeServerOptions } from './bridge-server.js';




let bridge: ChannelBridge | null = null;
let portCounter = 18990;

function baseOpts(overrides?: Partial<BridgeServerOptions>): BridgeServerOptions {
  return {
    port: portCounter++,
    cliPath: 'claude',
    defaultModel: 'claude-sonnet-5',
    timeoutMs: 5000,
    ...overrides,
  };
}

async function boot(overrides?: Partial<BridgeServerOptions>): Promise<{ port: number; base: string }> {
  const opts = baseOpts(overrides);
  bridge = new ChannelBridge(opts);
  await bridge.listen();
  return { port: opts.port, base: `http://127.0.0.1:${opts.port}` };
}

afterEach(async () => {
  await bridge?.close();
  bridge = null;
});

describe('ChannelBridge HTTP', () => {
  it('responds to /health without auth', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe('agent-proxy-channel-bridge');
    expect(body.model).toBe('claude-sonnet-5');
  });

  it('rejects job submission without bearer token when api_key set', async () => {
    const { base } = await boot({ apiKey: 'secret-token' });
    const res = await fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    });
    expect(res.status).toBe(401);
  });

  it('allows /health even when api_key set (no auth required)', async () => {
    const { base } = await boot({ apiKey: 'secret-token' });
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });

  it('returns 400 when prompt is missing', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-sonnet-5' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toContain('prompt');
  });

  it('returns 404 for unknown job id', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/jobs/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for unknown route', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
  });

  it('marks queued jobs failed when the bridge closes', async () => {
    const { base } = await boot({ maxConcurrent: 1 });
    await fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'active' }),
    });
    const queuedResponse = await fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'queued' }),
    });
    const queued = await queuedResponse.json() as { job_id: string };

    const closing = bridge!.close();
    const jobs = (bridge as unknown as {
      jobs: Map<string, { status: string; error?: string }>;
    }).jobs;

    expect(jobs.get(queued.job_id)).toMatchObject({
      status: 'failed',
      error: 'Bridge shutting down',
    });
    await closing;
    bridge = null;
  });
});
