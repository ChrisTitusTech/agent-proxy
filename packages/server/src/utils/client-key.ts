



import type { FastifyRequest } from 'fastify';

const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const SESSION_HEADER = 'x-agent-proxy-session-id';

export function extractClientKey(request: FastifyRequest, apiKeyId: string | undefined): string {
  const raw = request.headers[SESSION_HEADER];
  const headerValue = Array.isArray(raw) ? raw[0] : raw;
  if (typeof headerValue === 'string' && SESSION_ID_RE.test(headerValue)) {
    return headerValue;
  }
  return apiKeyId || 'anonymous';
}
