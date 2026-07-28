export type ProviderFailureKind =
  | 'executable_missing'
  | 'login_required'
  | 'login_expired'
  | 'unreachable'
  | 'timeout'
  | 'cancelled'
  | 'herdr_unavailable'
  | 'queue_overloaded'
  | 'quota_exceeded'
  | 'model_unavailable'
  | 'validation_error'
  | 'recursion'
  | 'provider_error';

export interface ProviderFailure {
  kind: ProviderFailureKind;
  code: string;
  statusCode: number;
  message: string;
  retryable: boolean;
  fallbackEligible: boolean;
}

function safeProviderName(provider?: string): string {
  if (!provider || !/^[a-z0-9_-]+$/i.test(provider)) return 'Provider';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function sanitizeProviderError(message: string): string {
  return message
    .replace(
      /(\b(?:api[_-]?key|token|secret)\b["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+/-]{8,}={0,2}/gi,
      '$1[credential]',
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      '[credential]',
    )
    .replace(
      /\b(?:sk|xai|sess|oauth)[-_][A-Za-z0-9._-]{8,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}\b/gi,
      '[credential]',
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[account]')
    .replace(
      /(^|[\s("'=])\/(?:[\w.@+-]+\/)*[\w.@+-]+/g,
      '$1[path]',
    )
    .replace(/\b[A-Za-z]:\\(?:[\w.@+-]+\\)*[\w.@+-]+/g, '[path]')
    .replace(/at\s+\S+\s*\(.*?\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

export function classifyProviderError(
  error: Error | string,
  provider?: string,
): ProviderFailure {
  const raw = error instanceof Error ? error.message : error;
  const normalized = raw.toLowerCase();
  const label = safeProviderName(provider);

  if (/routes provider traffic back to agent-proxy|provider recursion/.test(normalized)) {
    return {
      kind: 'recursion',
      code: 'provider_recursion',
      statusCode: 400,
      message: `${label} configuration recursively targets this agent-proxy listener.`,
      retryable: false,
      fallbackEligible: false,
    };
  }
  if (
    /\benoent\b|command not found|executable .*not found|spawn .* no such file/.test(normalized)
  ) {
    return {
      kind: 'executable_missing',
      code: 'provider_executable_missing',
      statusCode: 503,
      message: `${label} executable is unavailable for the logged-in user.`,
      retryable: false,
      fallbackEligible: true,
    };
  }
  if (/herdr.*(?:unavailable|not running|incompatible|failed)|no herdr execution backend/.test(normalized)) {
    return {
      kind: 'herdr_unavailable',
      code: 'herdr_unavailable',
      statusCode: 503,
      message: 'Herdr is unavailable. Start the current-user Herdr session and retry.',
      retryable: true,
      fallbackEligible: false,
    };
  }
  if (/queue is full|queue wait timed out/.test(normalized)) {
    return {
      kind: 'queue_overloaded',
      code: 'provider_queue_overloaded',
      statusCode: 503,
      message: `${label} is at capacity. Retry later.`,
      retryable: true,
      fallbackEligible: true,
    };
  }
  if (
    /token.*expired|expired.*token|refresh.*(?:failed|expired)|credentials?.*expired|login expired/.test(normalized)
  ) {
    return {
      kind: 'login_expired',
      code: 'provider_login_expired',
      statusCode: 502,
      message: `${label} login expired. Refresh the logged-in user's provider session.`,
      retryable: false,
      fallbackEligible: true,
    };
  }
  if (
    /not logged in|login required|\bsign in\b|authentication required|unauthenticated|no cached credentials|missing credentials/.test(normalized)
  ) {
    return {
      kind: 'login_required',
      code: 'provider_login_required',
      statusCode: 502,
      message: `${label} is not logged in for the current user.`,
      retryable: false,
      fallbackEligible: true,
    };
  }
  if (
    /\benotfound\b|\beconnrefused\b|connection refused|network is unreachable|\bdns\b|failed to connect|could not connect|upstream unavailable/.test(normalized)
  ) {
    return {
      kind: 'unreachable',
      code: 'provider_unreachable',
      statusCode: 502,
      message: `${label} authentication or model service is unreachable. Check network access and retry.`,
      retryable: true,
      fallbackEligible: true,
    };
  }
  if (/quota|rate limit|too many requests|insufficient credits|usage limit/.test(normalized)) {
    return {
      kind: 'quota_exceeded',
      code: 'provider_quota_exceeded',
      statusCode: 429,
      message: `${label} quota is exhausted or rate limited.`,
      retryable: true,
      fallbackEligible: true,
    };
  }
  if (/model .*not found|unknown model|unsupported model|model unavailable/.test(normalized)) {
    return {
      kind: 'model_unavailable',
      code: 'provider_model_unavailable',
      statusCode: 400,
      message: `${label} does not provide the requested model.`,
      retryable: false,
      fallbackEligible: true,
    };
  }
  if (/invalid (?:request|argument|prompt)|validation failed|bad request/.test(normalized)) {
    return {
      kind: 'validation_error',
      code: 'provider_validation_error',
      statusCode: 400,
      message: `${label} rejected the request as invalid.`,
      retryable: false,
      fallbackEligible: false,
    };
  }
  if (/timed out|timeout/.test(normalized)) {
    return {
      kind: 'timeout',
      code: 'timeout',
      statusCode: 504,
      message: `${label} request timed out.`,
      retryable: true,
      fallbackEligible: true,
    };
  }
  if (/cancelled|canceled|aborted/.test(normalized)) {
    return {
      kind: 'cancelled',
      code: 'request_cancelled',
      statusCode: 499,
      message: 'Request was cancelled.',
      retryable: false,
      fallbackEligible: false,
    };
  }
  return {
    kind: 'provider_error',
    code: 'provider_error',
    statusCode: 502,
    message: sanitizeProviderError(raw) || `${label} request failed.`,
    retryable: false,
    fallbackEligible: true,
  };
}
