// Runs workflow check commands as app-owned processes (plan §6.7): each runs
// in its own process group, output goes to a log file, and success requires
// the whole group to have exited — a parent that returns while children keep
// running is not a finished check.

import { execFile, spawn } from 'child_process';
import { createWriteStream, promises as fs } from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const KILL_GRACE_MS = 5_000;
const GROUP_SETTLE_MS = 3_000;

export type CheckRunResult = {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  /** Every process in the command's group is gone. */
  groupExited: boolean;
  /** Processes outlived the command and had to be terminated; such a run never passes. */
  leftoversTerminated: boolean;
  pid: number | null;
  startedAt: number;
  logPath: string;
  tail: string;
  spawnError?: string;
};

function groupAlive(pid: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killGroup(pid: number, signal: NodeJS.Signals): Promise<void> {
  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => {});
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    /* already gone */
  }
}

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return predicate();
}

/** Terminate a process group: SIGTERM, then SIGKILL; true when confirmed gone. */
export async function terminateGroup(pid: number): Promise<boolean> {
  if (!groupAlive(pid)) return true;
  await killGroup(pid, 'SIGTERM');
  if (await waitFor(() => !groupAlive(pid), KILL_GRACE_MS)) return true;
  await killGroup(pid, 'SIGKILL');
  return waitFor(() => !groupAlive(pid), KILL_GRACE_MS);
}

/**
 * Start time of a process as reported by `ps`, used with the pid to prove a
 * recorded process is the one still running after an app restart.
 */
export async function processStartTime(pid: number): Promise<string | null> {
  if (process.platform === 'win32') return null;
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export function isGroupAlive(pid: number): boolean {
  return groupAlive(pid);
}

async function readTail(file: string, bytes = 4000): Promise<string> {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const { size } = await handle.stat();
      const start = Math.max(0, size - bytes);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

export async function runCheckCommand(input: {
  argv: string[];
  cwd: string;
  timeoutMs: number;
  logPath: string;
  signal?: { aborted: boolean };
  onStarted?: (pid: number, startedAt: number) => void;
}): Promise<CheckRunResult> {
  await fs.mkdir(path.dirname(input.logPath), { recursive: true });
  const log = createWriteStream(input.logPath);
  const startedAt = Date.now();
  log.write(`$ ${input.argv.join(' ')}\n# cwd: ${input.cwd}\n\n`);
  const child = spawn(input.argv[0], input.argv.slice(1), {
    cwd: input.cwd,
    env: { ...process.env, CI: process.env.CI ?? '1' },
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });

  const pid = child.pid ?? null;
  if (pid !== null) input.onStarted?.(pid, startedAt);

  let timedOut = false;
  let cancelled = false;
  let spawnError: string | undefined;

  const exit = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on('error', (error) => {
      spawnError = error.message;
      resolve({ code: null, signal: null });
    });
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  const timer = setTimeout(() => {
    timedOut = true;
    if (pid !== null) void terminateGroup(pid);
  }, input.timeoutMs);
  const cancelPoll = setInterval(() => {
    if (input.signal?.aborted && !cancelled) {
      cancelled = true;
      if (pid !== null) void terminateGroup(pid);
    }
  }, 200);

  const { code, signal } = await exit;
  clearTimeout(timer);
  clearInterval(cancelPoll);

  // The parent is gone; anything left in its group (watchers, servers) is
  // terminated, and only a confirmed-empty group counts as exited.
  let groupExited = true;
  let leftoversTerminated = false;
  if (pid !== null && process.platform !== 'win32') {
    if (!(await waitFor(() => !groupAlive(pid), GROUP_SETTLE_MS))) {
      leftoversTerminated = true;
      groupExited = await terminateGroup(pid);
      log.write(`\n# leftover processes in the command's group were terminated (confirmed: ${groupExited})\n`);
    }
  }
  await new Promise<void>((resolve) => log.end(resolve));
  if (spawnError) await fs.appendFile(input.logPath, `\n# failed to start: ${spawnError}\n`).catch(() => {});

  return {
    exitCode: code,
    signal: signal ?? null,
    timedOut,
    cancelled,
    groupExited,
    leftoversTerminated,
    pid,
    startedAt,
    logPath: input.logPath,
    tail: await readTail(input.logPath),
    ...(spawnError ? { spawnError } : {}),
  };
}
