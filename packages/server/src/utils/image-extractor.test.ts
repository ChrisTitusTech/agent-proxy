import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { ChatMessage } from '@agent-proxy/shared';
import { prepareCodexPrompt } from './image-extractor.js';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('prepareCodexPrompt', () => {
  const tempFiles: string[] = [];
  let runtimeDirectory: string;
  const originalRuntimeDirectory = process.env.XDG_RUNTIME_DIR;

  beforeEach(async () => {
    runtimeDirectory = await mkdtemp(resolve(tmpdir(), 'agent-proxy-images-'));
    process.env.XDG_RUNTIME_DIR = runtimeDirectory;
  });

  afterEach(async () => {
    while (tempFiles.length > 0) {
      const file = tempFiles.pop()!;
      await unlink(file).catch(() => undefined);
    }
    if (originalRuntimeDirectory === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = originalRuntimeDirectory;
    await rm(runtimeDirectory, { recursive: true, force: true });
  });

  it('serializes messages without images as a text prompt', async () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hello' },
    ];

    const result = await prepareCodexPrompt(messages);

    expect(result.hasImages).toBe(false);
    expect(result.imageFiles).toHaveLength(0);
    expect(result.prompt).toContain('<|system|> You are helpful.');
    expect(result.prompt).toContain('hello');
  });

  it('writes an OpenAI image URL data URI to a temporary file', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${PNG_BASE64}` },
          },
        ],
      },
    ];

    const result = await prepareCodexPrompt(messages);
    tempFiles.push(...result.tempFiles);

    expect(result.hasImages).toBe(true);
    expect(result.imageFiles).toEqual(result.tempFiles);
    expect(result.failures).toHaveLength(0);

    const filePath = result.tempFiles[0];
    expect(filePath).toContain(resolve(runtimeDirectory, 'agent-proxy', 'images'));
    expect(filePath).toMatch(/agent-proxy-img-[a-f0-9]+\.png$/);
    expect(result.prompt).toContain('describe');
    expect(result.prompt).toContain(`[image attached: ${filePath}]`);
    expect(result.prompt).not.toContain('base64,');

    const written = await readFile(filePath);
    expect(written.equals(Buffer.from(PNG_BASE64, 'base64'))).toBe(true);

    const metadata = await stat(filePath);
    expect(metadata.size).toBe(Buffer.from(PNG_BASE64, 'base64').length);
    expect(metadata.mode & 0o777).toBe(0o600);
    const directoryMetadata = await stat(resolve(runtimeDirectory, 'agent-proxy', 'images'));
    expect(directoryMetadata.mode & 0o777).toBe(0o700);
  });

  it('accepts Anthropic base64 image sources', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'analyze' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: PNG_BASE64 },
          },
        ],
      },
    ];

    const result = await prepareCodexPrompt(messages);
    tempFiles.push(...result.tempFiles);

    expect(result.hasImages).toBe(true);
    expect(result.tempFiles[0]).toMatch(/\.jpg$/);
  });

  it('rejects private image URLs to prevent SSRF', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'fetch this' },
          { type: 'image_url', image_url: { url: 'http://127.0.0.1:9999/secret.png' } },
        ],
      },
    ];

    const result = await prepareCodexPrompt(messages);

    expect(result.hasImages).toBe(false);
    expect(result.tempFiles).toHaveLength(0);
    expect(result.failures.join(' ')).toMatch(/private|internal/i);
    expect(result.prompt).toContain('[image (skipped:');
  });

  it('marks malformed image parts as skipped', async () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'x' }, { type: 'image_url' }],
      },
    ];

    const result = await prepareCodexPrompt(messages);

    expect(result.hasImages).toBe(false);
    expect(result.failures).toContain('image part missing url/data');
    expect(result.prompt).toContain('[image (skipped)]');
  });
});
