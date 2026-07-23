const ALLOWED_PROVIDER_ENVIRONMENT_KEYS = new Set([
  'ALL_PROXY',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CONFIG_DIR',
  'CLOUDSDK_CONFIG',
  'CODEX_HOME',
  'COLORTERM',
  'FORCE_COLOR',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GROK_API_KEY',
  'HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'NODE_EXTRA_CA_CERTS',
  'NO_COLOR',
  'NO_PROXY',
  'OPENAI_API_KEY',
  'PATH',
  'SHELL',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
  'USER',
  'XAI_API_KEY',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'XDG_STATE_HOME',
  'all_proxy',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]);

export function getProviderEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (ALLOWED_PROVIDER_ENVIRONMENT_KEYS.has(key)) {
      environment[key] = value;
    }
  }
  return environment;
}
