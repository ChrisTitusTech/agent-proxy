import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HERDR_WORKER_PROTOCOL, type HerdrWorkerEvent } from './protocol.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(
    (directory) => rm(directory, { recursive: true, force: true }),
  ));
});

describe('Herdr worker protocol', () => {
  it('forwards structured stdout, stderr, and exit state', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'agent-proxy-worker-'));
    temporaryDirectories.push(directory);
    const socketPath = resolve(directory, 'worker.sock');
    const events: HerdrWorkerEvent[] = [];

    const completion = new Promise<void>((resolveCompletion, rejectCompletion) => {
      const server = createServer((socket: Socket) => {
        let buffered = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
          buffered += chunk;
          for (;;) {
            const newline = buffered.indexOf('\n');
            if (newline < 0) break;
            const event = JSON.parse(buffered.slice(0, newline)) as HerdrWorkerEvent;
            buffered = buffered.slice(newline + 1);
            events.push(event);
            if (event.type === 'ready') {
              socket.write(`${JSON.stringify({
                type: 'start',
                protocol: HERDR_WORKER_PROTOCOL,
                command: process.execPath,
                args: ['-e', 'console.log("out"); console.error("err")'],
                cwd: process.cwd(),
                env: process.env,
              })}\n`);
            }
            if (event.type === 'exit') {
              server.close(() => resolveCompletion());
            }
          }
        });
      });
      server.once('error', rejectCompletion);
      server.listen(socketPath, () => {
        const workerPath = resolve(import.meta.dirname, 'worker.ts');
        const tsxLoader = resolve(
          import.meta.dirname,
          '../../node_modules/tsx/dist/loader.mjs',
        );
        const worker = spawn(
          process.execPath,
          ['--import', tsxLoader, workerPath, socketPath],
          { stdio: 'ignore' },
        );
        worker.once('error', rejectCompletion);
        worker.once('exit', (code) => {
          if (events.at(-1)?.type !== 'exit') {
            rejectCompletion(new Error(`Worker exited early with code ${code}.`));
          }
        });
      });
    });

    await completion;
    expect(events).toContainEqual(expect.objectContaining({ type: 'ready' }));
    expect(events).toContainEqual({
      type: 'stdout',
      data: Buffer.from('out\n').toString('base64'),
    });
    expect(events).toContainEqual({
      type: 'stderr',
      data: Buffer.from('err\n').toString('base64'),
    });
    expect(events.at(-1)).toEqual({ type: 'exit', code: 0 });
  });
});
