export type ProviderFailureKind =
  | 'executable_missing'
  | 'login_required'
  | 'login_expired'
  | 'unreachable'
  | 'timeout'
  | 'cancelled'
  | 'provider_error';

export interface ProviderFailure {
  kind: ProviderFailureKind;
  code: string;
  statusCode: number;
  message: string;
}

function safeProviderName(provider?: string): string {
  if (!provider || !/^[a-z0-9_-]+$/i.test(provider)) return 'Provider';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

export function sanitizeProviderError(message: string): string {
  return message
    .replace(
      /\b(?:sk|xai|sess|oauth)[-_][A-Za-z0-9._-]{8,}\b|\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}\b/gi,
      '[credential]',
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[account]')
    .replace(/\/(?:home|var|opt|etc|tmp|run)\/[\w/.@-]+/g, '[path]')
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

  if (
    /\benoent\b|command not found|executable .*not found|failed to spawn|spawn .* no such file/.test(normalized)
  ) {
    return {
      kind: 'executable_missing',
      code: 'provider_executable_missing',
      statusCode: 503,
      message: `${label} executable is unavailable. Install the configured CLI for the service account.`,
    };
  }
  if (
    /token.*expired|expired.*token|refresh.*(?:failed|expired)|credentials?.*expired|login expired/.test(normalized)
  ) {
    return {
      kind: 'login_expired',
      code: 'provider_login_expired',
      statusCode: 502,
      message: `${label} service-account login expired. Refresh it from Dashboard > Provider Login.`,
    };
  }
  if (
    /not logged in|login required|sign in|authentication required|unauthenticated|no cached credentials|missing credentials/.test(normalized)
  ) {
    return {
      kind: 'login_required',
      code: 'provider_login_required',
      statusCode: 502,
      message: `${label} service account is not logged in. Start login from Dashboard > Provider Login.`,
    };
  }
  if (
    /\benotfound\b|\beconnrefused\b|connection refused|network is unreachable|dns|failed to connect|could not connect|upstream unavailable/.test(normalized)
  ) {
    return {
      kind: 'unreachable',
      code: 'provider_unreachable',
      statusCode: 502,
      message: `${label} authentication or model service is unreachable. Check network access and retry.`,
    };
  }
  if (/timed out|timeout/.test(normalized)) {
    return {
      kind: 'timeout',
      code: 'timeout',
      statusCode: 504,
      message: `${label} request timed out.`,
    };
  }
  if (/cancelled|canceled|aborted/.test(normalized)) {
    return {
      kind: 'cancelled',
      code: 'request_cancelled',
      statusCode: 499,
      message: 'Request was cancelled.',
    };
  }
  return {
    kind: 'provider_error',
    code: 'provider_error',
    statusCode: 502,
    message: sanitizeProviderError(raw) || `${label} request failed.`,
  };
}
