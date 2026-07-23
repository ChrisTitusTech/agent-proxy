


//





import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isReasoningEffort, type ReasoningEffort } from '@agent-proxy/shared';

export interface CodexCliDefaults {
  configPath: string;
  exists: boolean;
  model: string | null;
  modelReasoningEffort: ReasoningEffort | null;
}

const CONFIG_PATH = join(homedir(), '.codex', 'config.toml');


function extractTopLevelString(content: string, key: string): string | null {

  const headEnd = content.search(/^\s*\[/m);
  const head = headEnd >= 0 ? content.slice(0, headEnd) : content;

  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"\\n]*)"\\s*(?:#.*)?$`, 'm');
  const m = head.match(re);
  return m ? m[1] : null;
}

export function readCodexCliDefaults(): CodexCliDefaults {
  const base: CodexCliDefaults = {
    configPath: CONFIG_PATH,
    exists: false,
    model: null,
    modelReasoningEffort: null,
  };

  if (!existsSync(CONFIG_PATH)) {
    return base;
  }

  let content: string;
  try {
    content = readFileSync(CONFIG_PATH, 'utf-8');
  } catch {
    return { ...base, exists: true };
  }

  const model = extractTopLevelString(content, 'model');
  const rawEffort = extractTopLevelString(content, 'model_reasoning_effort');
  const effort = rawEffort && isReasoningEffort(rawEffort.toLowerCase())
    ? (rawEffort.toLowerCase() as ReasoningEffort)
    : null;

  return {
    configPath: CONFIG_PATH,
    exists: true,
    model,
    modelReasoningEffort: effort,
  };
}
