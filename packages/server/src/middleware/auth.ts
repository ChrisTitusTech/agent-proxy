import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { getDatabase } from '../db/client.js';
import { apiKeys } from '../db/schema.js';
import { API_KEY_PREFIX } from '@agent-proxy/shared';

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function getKeyPrefix(key: string): string {
  return key.substring(0, 12);
}


function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf-8'), Buffer.from(b, 'utf-8'));
  } catch {
    return false;
  }
}

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {

  const xApiKey = request.headers['x-api-key'] as string | undefined;
  const authHeader = request.headers.authorization;

  let apiKey: string | undefined;

  if (xApiKey) {

    apiKey = xApiKey;
  } else if (authHeader?.startsWith('Bearer ')) {

    apiKey = authHeader.substring(7);
  }

  if (!apiKey) {
    return reply.status(401).send({
      error: {
        message: 'Missing or invalid API key. Expected: Authorization: Bearer sk-proxy-xxx or x-api-key header',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_api_key',
      },
    });
  }

  if (!apiKey.startsWith(API_KEY_PREFIX)) {
    return reply.status(401).send({
      error: {
        message: 'Invalid API key format. Keys must start with "sk-proxy-"',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_api_key',
      },
    });
  }

  const db = getDatabase();
  const keyHash = hashApiKey(apiKey);

  const results = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), eq(apiKeys.enabled, true)))
    .limit(1);

  const keyRecord = results[0];

  if (!keyRecord) {
    return reply.status(401).send({
      error: {
        message: 'Invalid API key.',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_api_key',
      },
    });
  }


  if (keyRecord.expiresAt && new Date(keyRecord.expiresAt) < new Date()) {
    return reply.status(401).send({
      error: {
        message: 'API key has expired.',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_api_key',
      },
    });
  }


  db.update(apiKeys)
    .set({ lastUsedAt: new Date().toISOString() })
    .where(eq(apiKeys.id, keyRecord.id))
    .catch((err) => console.warn('[auth] lastUsedAt update failed:', err));


  (request as FastifyRequest & { apiKeyId?: string }).apiKeyId = keyRecord.id;
  (request as FastifyRequest & { apiKeyRateLimits?: { rpm?: number | null; rpd?: number | null } }).apiKeyRateLimits = {
    rpm: keyRecord.rateLimitRpm,
    rpd: keyRecord.rateLimitRpd,
  };
}


export async function adminAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
  adminToken: string,
): Promise<void> {
  const headerToken = request.headers['x-admin-token'] as string | undefined;
  const authHeader = request.headers.authorization;
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : undefined;
  const token = headerToken ?? bearerToken;

  if (!token || !safeCompare(token, adminToken)) {
    return reply.status(403).send({
      error: {
        message: 'Forbidden. Admin token required.',
        type: 'invalid_request_error',
        param: null,
        code: 'forbidden',
      },
    });
  }
}
