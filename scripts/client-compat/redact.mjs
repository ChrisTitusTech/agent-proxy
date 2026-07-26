#!/usr/bin/env node

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const [inputPath, outputPath] = process.argv.slice(2);

if (!inputPath || !outputPath) {
  console.error('Usage: redact.mjs INPUT OUTPUT');
  process.exit(2);
}

const secretEnvironmentNames = [
  'PROXY_API_KEY',
  'AGENT_PROXY_API_KEY',
  'ADMIN_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'XAI_API_KEY',
];

const input = await readFile(inputPath);
if (input.includes(0)) {
  throw new Error(`Compatibility fixture is not UTF-8 text: ${inputPath}`);
}

let text = input.toString('utf8');
const secrets = secretEnvironmentNames
  .map((name) => process.env[name])
  .filter((value) => typeof value === 'string' && value.length > 0)
  .sort((left, right) => right.length - left.length);

for (const secret of secrets) {
  text = text.replaceAll(secret, '[REDACTED]');
}

const structuredPatterns = [
  {
    pattern: /\bsk-[A-Za-z0-9._-]{8,}\b/gu,
    replacement: '[REDACTED]',
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
    replacement: '[REDACTED]',
  },
  {
    pattern: /(\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer\s+)?)[^\s"',;]+/giu,
    replacement: '$1[REDACTED]',
  },
  {
    pattern: /(\b(?:x-api-key|api-key|x-admin-token|cookie|set-cookie)\s*[:=]\s*)[^\r\n]+/giu,
    replacement: '$1[REDACTED]',
  },
  {
    pattern: /("(?:access_token|refresh_token|id_token|api_key|apiKey|token|secret)"\s*:\s*")[^"]*(")/giu,
    replacement: '$1[REDACTED]$2',
  },
  {
    pattern: /("(?:email|account(?:Id|Uuid)?|organization(?:Id|Uuid)?|subscriptionType)"\s*:\s*")[^"]*(")/giu,
    replacement: '$1[REDACTED]$2',
  },
  {
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    replacement: '[REDACTED_EMAIL]',
  },
  {
    pattern: /(\b(?:access_token|refresh_token|id_token|api_key|apiKey|token|secret)=)[^&\s]+/giu,
    replacement: '$1[REDACTED]',
  },
];

for (const { pattern, replacement } of structuredPatterns) {
  text = text.replace(pattern, replacement);
}

await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
await writeFile(outputPath, text, { mode: 0o600 });
await chmod(outputPath, 0o600);
