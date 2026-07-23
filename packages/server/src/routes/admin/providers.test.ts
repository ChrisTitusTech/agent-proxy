import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderConfigYaml } from '@agent-proxy/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, getDatabase, initDatabase } from '../../db/client.js';
import { settings } from '../../db/schema.js';
import {
  loadEffectiveProviderConfigs,
  validateRuntimeProviderConfig,
} from './providers.js';

let testDirectory: string;

beforeEach(async () => {
  testDirectory = mkdtempSync(join(tmpdir(), 'agent-proxy-provider-config-'));
  await initDatabase(join(testDirectory, 'agent-proxy.db'));
});

afterEach(() => {
  closeDatabase();
  rmSync(testDirectory, { recursive: true, force: true });
});

describe('loadEffectiveProviderConfigs', () => {
  it('applies persisted enablement and nested runtime options', async () => {
    const defaultConfig: ProviderConfigYaml = {
      enabled: false,
      cli_path: 'codex',
      default_model: 'gpt-5.5',
      max_concurrent: 1,
      timeout_ms: 30_000,
      extra_args: [],
      cli_options: {
        ephemeral: true,
        enable_session_reuse: false,
      },
    };
    await getDatabase().insert(settings).values({
      key: 'provider_config:codex',
      value: JSON.stringify({
        enabled: true,
        cli_options: { enable_session_reuse: true },
      }),
    });

    const configs = await loadEffectiveProviderConfigs({ codex: defaultConfig });

    expect(configs.codex.enabled).toBe(true);
    expect(configs.codex.cli_options).toEqual({
      ephemeral: true,
      enable_session_reuse: true,
    });
  });

  it('discards invalid persisted overrides and rejects invalid writes', async () => {
    const defaultConfig: ProviderConfigYaml = {
      enabled: false,
      cli_path: 'codex',
      default_model: 'gpt-5.5',
      max_concurrent: 1,
      timeout_ms: 30_000,
      extra_args: [],
    };
    await getDatabase().insert(settings).values({
      key: 'provider_config:codex',
      value: JSON.stringify({ enabled: 'yes', max_concurrent: -1 }),
    });

    const configs = await loadEffectiveProviderConfigs({ codex: defaultConfig });

    expect(configs.codex).toEqual(defaultConfig);
    expect(() => validateRuntimeProviderConfig(
      'codex',
      { enabled: 'yes' },
      true,
    )).toThrow(/Invalid provider configuration/);
  });
});
