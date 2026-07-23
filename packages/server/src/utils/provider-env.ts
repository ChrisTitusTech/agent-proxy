const ALLOWED_PROVIDER_ENVIRONMENT_KEYS = new Set([
  'ALL_PROXY',
  'COLORTERM',
  'FORCE_COLOR',
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

const PROVIDER_ENVIRONMENT_KEYS: Record<string, ReadonlySet<string>> = {
  claude: new Set([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CONFIG_DIR',
  ]),
  codex: new Set([
    'CODEX_HOME',
    'OPENAI_API_KEY',
  ]),
  agy: new Set([
    'CLOUDSDK_CONFIG',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
  ]),
  grok: new Set([
    'GROK_API_KEY',
    'XAI_API_KEY',
  ]),
};

export function getProviderEnvironment(
  provider: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const providerKeys = PROVIDER_ENVIRONMENT_KEYS[provider] ?? new Set<string>();
  for (const [key, value] of Object.entries(source)) {
    if (
      ALLOWED_PROVIDER_ENVIRONMENT_KEYS.has(key) ||
      providerKeys.has(key)
    ) {
      environment[key] = value;
    }
  }
  return environment;
}
