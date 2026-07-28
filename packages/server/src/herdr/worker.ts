import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { HERDR_WORKER_PROTOCOL, type HerdrWorkerCommand, type HerdrWorkerEvent } from './protocol.js';

const socketPath = process.argv[2];
if (!socketPath) {
  console.error('Usage: worker.js SOCKET_PATH');
  process.exit(2);
}

let child: ChildProcess | null = null;
let killTimer: ReturnType<typeof setTimeout> | undefined;

function send(socket: Socket, event: HerdrWorkerEvent): void {
  if (socket.destroyed || !socket.writable) return;
  socket.write(`${JSON.stringify(event)}\n`);
}

function signalProcessGroup(signal: NodeJS.Signals): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== 'win32' && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // The process may have exited between the state check and signal.
  }
}

function cancel(): void {
  signalProcessGroup('SIGTERM');
  killTimer ??= setTimeout(() => signalProcessGroup('SIGKILL'), 3_000);
}

function start(socket: Socket, command: Extract<HerdrWorkerCommand, { type: 'start' }>): void {
  if (child) {
    send(socket, { type: 'error', message: 'Worker already started a provider process.' });
    return;
  }
  if (command.protocol !== HERDR_WORKER_PROTOCOL) {
    send(socket, {
      type: 'error',
      message: `Worker protocol mismatch: expected ${HERDR_WORKER_PROTOCOL}, received ${command.protocol}.`,
    });
    socket.end();
    return;
  }

  child = spawn(command.command, command.args, {
    cwd: command.cwd,
    env: command.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    detached: process.platform !== 'win32',
  });

  child.stdout?.on('data', (data: Buffer) => {
    send(socket, { type: 'stdout', data: data.toString('base64') });
  });
  child.stderr?.on('data', (data: Buffer) => {
    send(socket, { type: 'stderr', data: data.toString('base64') });
  });
  child.on('error', (error) => {
    send(socket, { type: 'error', message: error.message });
    if (child?.pid === undefined) {
      process.exitCode = 1;
      socket.end();
    }
  });
  child.on('close', (code, signal) => {
    if (killTimer) clearTimeout(killTimer);
    send(socket, {
      type: 'exit',
      code: code ?? 1,
      ...(signal ? { signal } : {}),
    });
    socket.end();
  });

  child.stdin?.on('error', () => {
    // Providers may close stdin before the prompt write completes.
  });
  if (command.stdin !== undefined) child.stdin?.end(command.stdin);
  else child.stdin?.end();
  send(socket, { type: 'started', pid: child.pid ?? 0 });
}

const socket = createConnection(socketPath);
socket.once('connect', () => {
  send(socket, { type: 'ready', protocol: HERDR_WORKER_PROTOCOL, pid: process.pid });
});
socket.on('error', (error) => {
  console.error(`Herdr worker IPC failed: ${error.message}`);
  process.exitCode = 1;
});
socket.once('close', () => {
  cancel();
});

const lines = createInterface({ input: socket });
lines.on('line', (line) => {
  try {
    const command = JSON.parse(line) as HerdrWorkerCommand;
    if (command.type === 'start') start(socket, command);
    else if (command.type === 'cancel') cancel();
  } catch (error) {
    send(socket, {
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    cancel();
  });
}
