import { execFile, spawn } from 'child_process';
import type { KimiRuntimeStatus } from '../../shared/types';
import { buildKimiEnv, buildKimiLoginCommand, resolveKimiBinary } from './kimi-cli';

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

export async function getKimiRuntimeStatus(): Promise<KimiRuntimeStatus> {
  const cliPath = await resolveKimiBinary();
  const checkedAt = Date.now();
  if (!cliPath) {
    return {
      ready: false,
      cliAvailable: false,
      cliPath: null,
      cliVersion: null,
      acpAvailable: false,
      authState: 'unknown',
      loginCommand: buildKimiLoginCommand(null),
      summary: 'Kimi Code CLI was not found.',
      detail: 'Install Kimi Code or set KIMI_CODE_PATH to the kimi executable.',
      checkedAt,
    };
  }

  const [cliVersion, acpAvailable] = await Promise.all([
    getKimiVersion(cliPath),
    checkAcpAvailable(cliPath),
  ]);
  const authState = acpAvailable ? await probeKimiAuth(cliPath) : 'error';
  const ready = acpAvailable && authState === 'ready';

  return {
    ready,
    cliAvailable: true,
    cliPath,
    cliVersion,
    acpAvailable,
    authState,
    loginCommand: buildKimiLoginCommand(cliPath),
    summary: ready
      ? 'Kimi Code ACP is ready.'
      : authState === 'login_required'
        ? 'Kimi Code needs login.'
        : acpAvailable
          ? 'Kimi Code ACP is installed but not ready.'
          : 'Kimi Code ACP was not found.',
    detail: ready
      ? 'Aegis can start Kimi Code sessions through ACP.'
      : authState === 'login_required'
        ? `Run ${buildKimiLoginCommand(cliPath)} to authenticate Kimi Code.`
        : acpAvailable
          ? 'Aegis could not verify Kimi Code authentication.'
          : 'The kimi executable does not expose the acp command.',
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
  if (!status.acpAvailable) {
    return 'Kimi Code ACP is not available from the detected kimi executable.';
  }
  return status.detail || 'Kimi Code ACP is not ready.';
}
