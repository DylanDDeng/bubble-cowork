import { execFile, spawn } from 'child_process';
import type { KimiRuntimeStatus } from '../../shared/types';
import { buildKimiEnv, buildKimiLoginCommand, resolveKimiBinary } from './kimi-cli';
import { isKimiServerCapable } from './provider/kimi-adapter-facade';

const PROBE_TIMEOUT_MS = 5000;

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string };
};

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 2500, env: buildKimiEnv() }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(`${stdout || ''}${stderr || ''}`.trim());
    });
  });
}

async function getKimiVersion(binaryPath: string): Promise<string | null> {
  try {
    const output = await execFileText(binaryPath, ['--version']);
    const match = output.match(/\d+\.\d+\.\d+/);
    return match?.[0] || output || null;
  } catch {
    return null;
  }
}

async function checkAcpAvailable(binaryPath: string): Promise<boolean> {
  try {
    const output = await execFileText(binaryPath, ['acp', '--help']);
    return output.includes('Agent Client Protocol') || output.includes('kimi acp');
  } catch {
    return false;
  }
}

function send(proc: ReturnType<typeof spawn>, id: number, method: string, params?: Record<string, unknown>): void {
  proc.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
}

async function probeKimiAuth(binaryPath: string): Promise<KimiRuntimeStatus['authState']> {
  return new Promise((resolve) => {
    const proc = spawn(binaryPath, ['acp'], {
      cwd: process.cwd(),
      env: buildKimiEnv(),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buffer = '';
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      proc.stdout.removeAllListeners('data');
      if (proc.stdin && !proc.stdin.destroyed) {
        proc.stdin.destroy();
      }
      if (proc.stdout && !proc.stdout.destroyed) {
        proc.stdout.destroy();
      }
      if (proc.exitCode === null && proc.signalCode === null) {
        proc.kill('SIGTERM');
        const killTimer = setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) {
            proc.kill('SIGKILL');
          }
        }, 250);
        killTimer.unref?.();
      }
      proc.unref();
    };

    const finish = (state: KimiRuntimeStatus['authState']) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(state);
    };

    timeout = setTimeout(() => finish('unknown'), PROBE_TIMEOUT_MS);
    timeout.unref?.();
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf('\n');
        if (!line) continue;
        let msg: JsonRpcResponse | null = null;
        try {
          msg = JSON.parse(line) as JsonRpcResponse;
        } catch {
          continue;
        }
        if (msg.id === 1) {
          send(proc, 2, 'authenticate', { methodId: 'login' });
          continue;
        }
        if (msg.id === 2) {
          if (msg.error) {
            const message = msg.error.message || '';
            finish(message.toLowerCase().includes('authentication required') ? 'login_required' : 'error');
          } else {
            finish('ready');
          }
        }
      }
    });
    proc.on('error', () => {
      finish('error');
    });
    proc.on('exit', () => {
      if (!settled) {
        finish('error');
      }
    });

    send(proc, 1, 'initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'aegis', title: 'Aegis', version: '0.0.32' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
  });
}

const STATUS_CACHE_TTL_MS = 10_000;
let statusCache: { status: KimiRuntimeStatus; fetchedAt: number } | null = null;

export async function getKimiRuntimeStatus(): Promise<KimiRuntimeStatus> {
  // Turn starts gate on this per send — cache briefly so a turn does not pay
  // repeated probe spawns (and legacy machines don't pay the 5s auth
  // handshake per message).
  if (statusCache && Date.now() - statusCache.fetchedAt < STATUS_CACHE_TTL_MS) {
    return statusCache.status;
  }
  const status = await computeKimiRuntimeStatus();
  statusCache = { status, fetchedAt: Date.now() };
  return status;
}

async function computeKimiRuntimeStatus(): Promise<KimiRuntimeStatus> {
  const cliPath = await resolveKimiBinary();
  const checkedAt = Date.now();
  if (!cliPath) {
    return {
      ready: false,
      cliAvailable: false,
      cliPath: null,
      cliVersion: null,
      acpAvailable: false,
      serverAvailable: false,
      authState: 'unknown',
      loginCommand: buildKimiLoginCommand(null),
      summary: 'Kimi Code CLI was not found.',
      detail: 'Install Kimi Code or set KIMI_CODE_PATH to the kimi executable.',
      checkedAt,
    };
  }

  const [cliVersion, acpAvailable, serverAvailable] = await Promise.all([
    getKimiVersion(cliPath),
    checkAcpAvailable(cliPath),
    isKimiServerCapable(),
  ]);
  // Capability-first gating: a server-capable CLI is ready without the 5s
  // per-call ACP auth handshake (login problems surface from the daemon at
  // turn time). The ACP auth probe remains only for legacy-only machines.
  const authState = serverAvailable ? 'unknown' : acpAvailable ? await probeKimiAuth(cliPath) : 'error';
  const ready = serverAvailable || (acpAvailable && authState === 'ready');

  return {
    ready,
    cliAvailable: true,
    cliPath,
    cliVersion,
    acpAvailable,
    serverAvailable,
    authState,
    loginCommand: buildKimiLoginCommand(cliPath),
    summary: ready
      ? serverAvailable
        ? 'Kimi Code is ready.'
        : 'Kimi Code ACP is ready.'
      : authState === 'login_required'
        ? 'Kimi Code needs login.'
        : acpAvailable
          ? 'Kimi Code ACP is installed but not ready.'
          : 'Kimi Code runtime was not found.',
    detail: ready
      ? serverAvailable
        ? 'Aegis can start Kimi Code sessions through the local Kimi server.'
        : 'Aegis can start Kimi Code sessions through ACP.'
      : authState === 'login_required'
        ? `Run ${buildKimiLoginCommand(cliPath)} to authenticate Kimi Code.`
        : acpAvailable
          ? 'Aegis could not verify Kimi Code authentication.'
          : 'The kimi executable exposes neither the server nor the acp command.',
    checkedAt,
  };
}

export function formatKimiRuntimeBlockingMessage(status: KimiRuntimeStatus): string {
  if (status.authState === 'login_required') {
    return `Kimi Code login required. Run: ${status.loginCommand || 'kimi acp --login'}`;
  }
  if (!status.cliAvailable) {
    return 'Kimi Code CLI is not installed or was not found. Install Kimi Code, then restart Aegis.';
  }
  if (!status.serverAvailable && !status.acpAvailable) {
    return 'The detected kimi executable exposes neither the server nor the acp runtime.';
  }
  return status.detail || 'Kimi Code is not ready.';
}
