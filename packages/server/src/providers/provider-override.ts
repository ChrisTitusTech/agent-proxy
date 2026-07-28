import type { ProviderConfigYaml, ProviderOverrides } from '@agent-proxy/shared';
import { CLAUDE_OVERRIDE_ALLOWED_KEYS, CODEX_OVERRIDE_ALLOWED_KEYS } from '@agent-proxy/shared';


const CODEX_ALLOWED_SET = new Set<string>(CODEX_OVERRIDE_ALLOWED_KEYS);
const CLAUDE_ALLOWED_SET = new Set<string>(CLAUDE_OVERRIDE_ALLOWED_KEYS);


const ALLOWED_BY_PROVIDER: Record<string, Set<string>> = {
  claude: CLAUDE_ALLOWED_SET,
  codex: CODEX_ALLOWED_SET,
};


const warnedKeys = new Set<string>();

function warnUnallowed(provider: string, key: string): void {
  const dedupeKey = `${provider}:${key}`;
  if (warnedKeys.has(dedupeKey)) return;
  warnedKeys.add(dedupeKey);
  console.warn(`[provider-override] '${key}' is not in the whitelist for provider '${provider}' — ignored.`);
}





export function mergeProviderConfig(
  base: ProviderConfigYaml,
  overrides: ProviderOverrides | undefined,
  provider: string,
): ProviderConfigYaml {
  if (!overrides || Object.keys(overrides).length === 0) {
    return { ...base };
  }

  const allowed = ALLOWED_BY_PROVIDER[provider];
  if (!allowed) {

    warnUnallowed(provider, '*');
    return { ...base };
  }

  const merged: ProviderConfigYaml = {
    ...base,
    cli_options: base.cli_options ? { ...base.cli_options } : undefined,
  };

  if (overrides.extra_args !== undefined) {
    if (allowed.has('extra_args')) merged.extra_args = [...overrides.extra_args];
    else warnUnallowed(provider, 'extra_args');
  }
  if (overrides.timeout_ms !== undefined) {
    if (allowed.has('timeout_ms')) merged.timeout_ms = overrides.timeout_ms;
    else warnUnallowed(provider, 'timeout_ms');
  }
  if (overrides.working_dir !== undefined) {
    if (allowed.has('working_dir')) merged.working_dir = overrides.working_dir;
    else warnUnallowed(provider, 'working_dir');
  }
  if (overrides.cli_options) {
    const cli = merged.cli_options ?? {};
    if (overrides.cli_options.ephemeral !== undefined) {
      if (allowed.has('cli_options.ephemeral')) cli.ephemeral = overrides.cli_options.ephemeral;
      else warnUnallowed(provider, 'cli_options.ephemeral');
    }
    if (overrides.cli_options.enable_session_reuse !== undefined) {
      if (allowed.has('cli_options.enable_session_reuse')) cli.enable_session_reuse = overrides.cli_options.enable_session_reuse;
      else warnUnallowed(provider, 'cli_options.enable_session_reuse');
    }
    if (overrides.cli_options.session_ttl_ms !== undefined) {
      if (allowed.has('cli_options.session_ttl_ms')) cli.session_ttl_ms = overrides.cli_options.session_ttl_ms;
      else warnUnallowed(provider, 'cli_options.session_ttl_ms');
    }
    merged.cli_options = cli;
  }
  return merged;
}


export function _resetOverrideWarnCache(): void {
  warnedKeys.clear();
}
