import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { loadConfig } from '../config/loader.js';

const configPath = process.env.CONFIG_PATH ?? resolve(process.cwd(), 'config.yaml');
const config = loadConfig(configPath);
const child = spawn(config.herdr.binary, ['server'], {
  env: process.env,
  stdio: 'inherit',
});

let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    child.kill(signal);
  });
}

child.once('error', (error) => {
  console.error(`Unable to start configured Herdr binary: ${error.message}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal) {
    console.error(`Configured Herdr server exited after ${signal}.`);
  }
  process.exitCode = code ?? 1;
});
