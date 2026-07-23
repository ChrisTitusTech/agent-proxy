import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';
import type { AppConfig } from '@agent-proxy/shared';

export interface PreflightOptions {
  configPath: string;
  path?: string;
}

export interface PreflightResult {
  executables: Record<string, string>;
  stateDirectory: string;
}

function findExecutable(command: string, pathValue: string): string | null {
  const candidates = command.includes('/')
    ? [isAbsolute(command) ? command : resolve(command)]
    : pathValue.split(delimiter).filter(Boolean).map((entry) => resolve(entry, command));

  for (const candidate of candidates) {
    try {
      const stat = statSync(candidate);
      if (!stat.isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  return null;
}

function assertWritableDirectory(path: string, label: string, create = false): void {
  if (create) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const stat = statSync(path);
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
  accessSync(path, constants.R_OK | constants.W_OK | constants.X_OK);
}

function isPlaceholderSecret(value: string): boolean {
  return /(?:change[-_ ]?me|replace[-_ ]?with|example|placeholder)/i.test(value);
}

export function runPreflightChecks(
  config: AppConfig,
  options: PreflightOptions,
): PreflightResult {
  const errors: string[] = [];
  const executables: Record<string, string> = {};
  const stateDirectory = dirname(config.database.path);

  if (!existsSync(options.configPath)) {
    errors.push(`Configuration file does not exist: ${options.configPath}`);
  } else {
    try {
      accessSync(options.configPath, constants.R_OK);
    } catch {
      errors.push(`Configuration file is not readable: ${options.configPath}`);
    }
  }

  if (!config.auth.adminToken.trim()) {
    errors.push('auth.admin_token must not be empty.');
  } else if (isPlaceholderSecret(config.auth.adminToken)) {
    errors.push('auth.admin_token still contains a placeholder value.');
  }
  for (const [index, key] of config.auth.initialKeys.entries()) {
    if (!key.key.trim()) {
      errors.push(`auth.initial_keys[${index}].key must not be empty.`);
    } else if (isPlaceholderSecret(key.key)) {
      errors.push(`auth.initial_keys[${index}].key still contains a placeholder value.`);
    }
  }

  try {
    assertWritableDirectory(stateDirectory, 'Database state directory', true);
  } catch (error) {
    errors.push(
      `Database state directory is not writable: ${stateDirectory} (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  if (existsSync(config.database.path)) {
    try {
      const stat = statSync(config.database.path);
      if (!stat.isFile()) {
        errors.push(`Database path is not a regular file: ${config.database.path}`);
      } else {
        accessSync(config.database.path, constants.R_OK | constants.W_OK);
      }
    } catch (error) {
      errors.push(
        `Database file is not accessible: ${config.database.path} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  const pathValue = options.path ?? process.env.PATH ?? '';
  for (const [name, provider] of Object.entries(config.providers)) {
    if (!provider.enabled) continue;
    const executable = findExecutable(provider.cli_path, pathValue);
    if (!executable) {
      errors.push(
        `providers.${name}.cli_path is not an executable file or PATH command: ${provider.cli_path}`,
      );
    } else {
      executables[name] = executable;
    }

    if (provider.working_dir) {
      try {
        assertWritableDirectory(provider.working_dir, `providers.${name}.working_dir`);
      } catch (error) {
        errors.push(
          `providers.${name}.working_dir is not accessible: ${provider.working_dir} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Startup preflight failed:\n- ${errors.join('\n- ')}`);
  }

  return { executables, stateDirectory };
}
