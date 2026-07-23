import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getActiveProcessCount,
  killAllChildProcesses,
  trackProcess,
} from './base-provider.js';

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const state = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2];
      return state !== 'Z';
    }
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!isProcessRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isProcessRunning(pid);
}

afterEach(async () => {
  await killAllChildProcesses(100);
});

describe('provider child-process lifecycle', () => {
  it('terminates every tracked child and waits for exit', async () => {
    const first = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    const second = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    trackProcess(first);
    trackProcess(second);
    expect(getActiveProcessCount()).toBe(2);

    await killAllChildProcesses(500);

    expect(getActiveProcessCount()).toBe(0);
    expect(first.exitCode !== null || first.signalCode !== null).toBe(true);
    expect(second.exitCode !== null || second.signalCode !== null).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('terminates the tracked process group', async () => {
    const child = spawn('/bin/sh', ['-c', 'sleep 60 & printf "%s\\n" "$!"; wait'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    trackProcess(child, true);
    const grandchildPid = await new Promise<number>((resolve) => {
      child.stdout!.once('data', (data: Buffer) => resolve(Number(data.toString().trim())));
    });

    await killAllChildProcesses(500);

    await expect(waitForProcessExit(grandchildPid)).resolves.toBe(true);
  });
});
