import pty from 'node-pty';
import { createServer, type Server as NetServer } from 'node:net';
import { createRequire } from 'node:module';
import { writeFileSync, mkdtempSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';






export interface PtyJobConfig {
  cliPath: string;
  model: string;
  workingDir?: string;
  timeoutMs: number;
  extraArgs?: string[];
  readyMaxWaitMs?: number;
  readyIdleMs?: number;
}

export interface PtyJobResult {
  content: string;
  status: 'success' | 'error';
}

const SYSTEM_REMINDER =
  'You are operating as a one-shot worker behind an API. When you finish the task you MUST call the report_result MCP tool with your final answer as the `payload`. Do not only print the answer in chat — the report_result tool call is the only way the result is delivered to the caller.';

const require = createRequire(import.meta.url);


let helperEnsured = false;
function ensureSpawnHelper(): void {
  if (helperEnsured) return;
  helperEnsured = true;
  try {
    const ptyRoot = dirname(require.resolve('node-pty/package.json'));
    const helper = join(ptyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  } catch {
    // best-effort
  }
}


function resolveReporterCommand(): { command: string; args: string[] } {
  const here = fileURLToPath(import.meta.url);
  const isTs = here.endsWith('.ts');
  const entry = join(dirname(here), isTs ? 'mcp-reporter.ts' : 'mcp-reporter.js');
  return isTs
    ? { command: process.execPath, args: ['--import', 'tsx', entry] }
    : { command: process.execPath, args: [entry] };
}




const PTY_DROP_WITH_VALUE = new Set([
  '--output-format', '--input-format', '--permission-mode', '--model', '--resume', '--agent',
]);
const PTY_DROP_FLAGS = new Set([
  '-p', '--print', '--no-session-persistence', '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions', '--fork-session', '--verbose', '--continue',
]);

function sanitizeInteractiveArgs(args: string[]): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (PTY_DROP_WITH_VALUE.has(a)) { dropped.push(a, args[i + 1] ?? ''); i++; continue; }
    if (PTY_DROP_FLAGS.has(a)) { dropped.push(a); continue; }
    kept.push(a);
  }
  return { kept, dropped };
}

function cleanClaudeEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of [
    'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
    'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_ENABLE_TASKS', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  ]) {
    delete env[k];
  }
  return env;
}

export async function runClaudeJob(
  prompt: string,
  config: PtyJobConfig,
  signal?: AbortSignal,
): Promise<PtyJobResult> {
  ensureSpawnHelper();

  const work = mkdtempSync(join(tmpdir(), 'ch-'));
  const socketPath = join(work, 's.sock');
  const mcpConfigPath = join(work, 'mcp.json');
  const reporter = resolveReporterCommand();

  writeFileSync(mcpConfigPath, JSON.stringify({
    mcpServers: {
      reporter: {
        type: 'stdio',
        command: reporter.command,
        args: reporter.args,
        env: { BRIDGE_REPORT_SOCKET: socketPath },
      },
    },
  }));

  let settle: ((r: PtyJobResult) => void) | null = null;
  let fail: ((e: Error) => void) | null = null;
  const resultPromise = new Promise<PtyJobResult>((res, rej) => { settle = res; fail = rej; });


  const sock: NetServer = createServer((conn) => {
    let buf = '';
    conn.on('data', (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as { type?: string; payload?: unknown; status?: string };
          if (msg.type === 'report_result') {
            settle?.({
              content: typeof msg.payload === 'string' ? msg.payload : String(msg.payload ?? ''),
              status: msg.status === 'error' ? 'error' : 'success',
            });
          }
        } catch {
          // ignore malformed line
        }
      }
    });
  });
  await new Promise<void>((res, rej) => {
    sock.once('error', rej);
    sock.listen(socketPath, res);
  });

  const { kept: safeExtraArgs, dropped } = sanitizeInteractiveArgs(config.extraArgs ?? []);
  if (dropped.length > 0) {
    console.error(`[channel-bridge] dropped CLI-only extra_args for interactive session: ${dropped.filter(Boolean).join(' ')}`);
  }

  const term = pty.spawn(config.cliPath, [
    '--mcp-config', mcpConfigPath,
    '--dangerously-skip-permissions',
    '--append-system-prompt', SYSTEM_REMINDER,
    '--model', config.model,
    ...safeExtraArgs,
  ], {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: config.workingDir || process.cwd(),
    env: cleanClaudeEnv() as Record<string, string>,
  });

  let injected = false;
  let firstDataAt = 0;
  let lastDataAt = 0;
  const startedAt = Date.now();
  const readyMax = config.readyMaxWaitMs ?? 8000;
  const readyIdle = config.readyIdleMs ?? 1500;

  const debug = process.env.CHANNEL_BRIDGE_DEBUG === '1';
  term.onData((data) => {
    if (debug) process.stderr.write(data);
    const now = Date.now();
    if (!firstDataAt) firstDataAt = now;
    lastDataAt = now;
  });


  const readyTimer = setInterval(() => {
    if (injected) return;
    const now = Date.now();
    const idleReady = firstDataAt > 0 && now - lastDataAt >= readyIdle;
    const maxReady = now - startedAt >= readyMax;
    if (idleReady || maxReady) {
      injected = true;


      const injectedPrompt = `${prompt}\n\n────\n[Delivery — this OVERRIDES any "only/nothing else/brief" instruction above] You MUST call the report_result tool with your COMPLETE answer as the payload. Chat text is discarded; the tool call is the only thing delivered to the user.`;
      term.write(injectedPrompt);
      setTimeout(() => { try { term.write('\r'); } catch { /* killed */ } }, 400);
    }
  }, 300);

  const timeout = setTimeout(
    () => fail?.(new Error(`Channel PTY job timed out after ${config.timeoutMs}ms`)),
    config.timeoutMs,
  );

  const onAbort = () => fail?.(new Error('Request cancelled'));
  signal?.addEventListener('abort', onAbort, { once: true });

  term.onExit(({ exitCode }) => {

    setTimeout(() => fail?.(new Error(`claude session exited (code ${exitCode}) before report_result`)), 800);
  });

  try {
    return await resultPromise;
  } finally {
    clearInterval(readyTimer);
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
    try { term.kill(); } catch { /* already gone */ }
    try { sock.close(); } catch { /* ignore */ }
    try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
