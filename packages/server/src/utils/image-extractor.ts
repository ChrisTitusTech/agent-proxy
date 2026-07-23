



import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { ChatMessage, ChatMessageContent, ChatMessageContentPart } from '@agent-proxy/shared';
import { convertMessagesToSinglePrompt, isImagePart } from './message-converter.js';

const MAX_IMAGE_BYTES = 16 * 1024 * 1024; // 16MB
const FETCH_TIMEOUT_MS = 10_000;

// data:image/png;base64,XXXX
const DATA_URL_RE = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/;

interface ImageRef {
  url: string;
  rawBase64?: string;
  mediaType?: string;
}

function refFromPart(part: ChatMessageContentPart): ImageRef | null {
  if (!part || typeof part !== 'object') return null;
  const type = part.type;

  // OpenAI Chat Completions: { type:'image_url', image_url:{ url } }
  // Responses API:           { type:'input_image', image_url:string|{url} }
  if (type === 'image_url' || type === 'input_image') {
    const v = (part as Record<string, unknown>).image_url ?? (part as Record<string, unknown>).url;
    if (typeof v === 'string') return { url: v };
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      if (typeof obj.url === 'string') return { url: obj.url };
    }
    return null;
  }

  // Anthropic: { type:'image', source:{ type:'base64', media_type, data } | { type:'url', url } }
  if (type === 'image') {
    const source = (part as Record<string, unknown>).source as Record<string, unknown> | undefined;
    if (!source) return null;
    if (source.type === 'base64' && typeof source.data === 'string') {
      return {
        url: '',
        rawBase64: source.data,
        mediaType: typeof source.media_type === 'string' ? source.media_type : undefined,
      };
    }
    if (source.type === 'url' && typeof source.url === 'string') {
      return { url: source.url };
    }
  }

  return null;
}

function extensionFromMediaType(mt?: string): string {
  if (!mt) return 'bin';
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'application/pdf': 'pdf',
  };
  return map[mt.toLowerCase().split(';')[0].trim()] ?? 'bin';
}

const PRIVATE_HOST_PATTERNS: RegExp[] = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fe80:/i,
  /^fc[0-9a-f]{2}:/i,
  /^fd[0-9a-f]{2}:/i,
];

function isPrivateHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '');
  return PRIVATE_HOST_PATTERNS.some((re) => re.test(h));
}

async function downloadImage(url: string): Promise<{ data: Buffer; mediaType?: string }> {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Unsupported URL protocol: ${u.protocol}`);
  }
  if (isPrivateHost(u.hostname)) {
    throw new Error(`Refusing to fetch private/internal host: ${u.hostname}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`Failed to fetch image: HTTP ${res.status}`);

    const cl = res.headers.get('content-length');
    if (cl && Number.parseInt(cl, 10) > MAX_IMAGE_BYTES) {
      throw new Error(`Image too large: ${cl} bytes (limit ${MAX_IMAGE_BYTES})`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) {
      throw new Error(`Image too large: ${buf.length} bytes (limit ${MAX_IMAGE_BYTES})`);
    }
    return { data: buf, mediaType: res.headers.get('content-type') ?? undefined };
  } finally {
    clearTimeout(timeout);
  }
}

async function imageRefToTempFile(ref: ImageRef): Promise<string> {
  let buf: Buffer;
  let mediaType = ref.mediaType;

  if (ref.rawBase64) {
    buf = Buffer.from(ref.rawBase64, 'base64');
    if (buf.length > MAX_IMAGE_BYTES) {
      throw new Error(`Image too large: ${buf.length} bytes (limit ${MAX_IMAGE_BYTES})`);
    }
  } else if (ref.url.startsWith('data:')) {
    const m = DATA_URL_RE.exec(ref.url);
    if (!m) throw new Error('Invalid data URL');
    mediaType = mediaType ?? m[1];
    const isB64 = !!m[2];
    const payload = m[3] ?? '';
    buf = isB64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8');
    if (buf.length > MAX_IMAGE_BYTES) {
      throw new Error(`Image too large: ${buf.length} bytes (limit ${MAX_IMAGE_BYTES})`);
    }
  } else if (ref.url) {
    const fetched = await downloadImage(ref.url);
    buf = fetched.data;
    mediaType = mediaType ?? fetched.mediaType;
  } else {
    throw new Error('No image data');
  }

  const ext = extensionFromMediaType(mediaType);
  const filePath = join(tmpdir(), `agent-proxy-img-${randomBytes(8).toString('hex')}.${ext}`);
  await writeFile(filePath, buf, { mode: 0o600 });
  return filePath;
}

export interface PreparedCodexPrompt {
  prompt: string;
  imageFiles: string[];
  tempFiles: string[];
  hasImages: boolean;
  failures: string[];
}

export async function prepareCodexPrompt(messages: ChatMessage[]): Promise<PreparedCodexPrompt> {
  const tempFiles: string[] = [];
  const failures: string[] = [];
  const newMessages: ChatMessage[] = [];

  for (const msg of messages) {
    const content = msg.content as ChatMessageContent;
    if (typeof content === 'string' || !Array.isArray(content)) {
      newMessages.push(msg);
      continue;
    }

    const newParts: ChatMessageContentPart[] = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;

      if (isImagePart(part)) {
        const ref = refFromPart(part);
        if (!ref) {
          failures.push('image part missing url/data');
          newParts.push({ type: 'text', text: '[image (skipped)]' });
          continue;
        }
        try {
          const filePath = await imageRefToTempFile(ref);
          tempFiles.push(filePath);
          newParts.push({ type: 'text', text: `[image attached: ${filePath}]` });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push(message);
          newParts.push({ type: 'text', text: `[image (skipped: ${message})]` });
        }
        continue;
      }

      newParts.push(part);
    }

    newMessages.push({ ...msg, content: newParts });
  }

  const prompt = convertMessagesToSinglePrompt(newMessages);
  return { prompt, imageFiles: tempFiles, tempFiles, hasImages: tempFiles.length > 0, failures };
}
