import { execFile, spawn } from 'child_process';
import type { GrokRuntimeStatus } from '../../shared/types';
import { buildGrokEnv, buildGrokLoginCommand, resolveGrokBinary } from './grok-cli';

const PROBE_TIMEOUT_MS = 5000;

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string };
};

function execFileText(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 2500, env: buildGrokEnv() }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(`${stdout || ''}${stderr || ''}`.trim());
    });
  });
}

async function getGrokVersion(binaryPath: string): Promise<string | null> {
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
    const output = await execFileText(binaryPath, ['agent', '--help']);
    return output.includes('stdio') || output.includes('Agent Client Protocol') || output.includes('agent');
  } catch {
    return false;
  }
}

function send(proc: ReturnType<typeof spawn>, id: number, method: string, params?: Record<string, unknown>): void {
  proc.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
}

async function probeGrokAuth(binaryPath: string): Promise<GrokRuntimeStatus['authState']> {
  return new Promise((resolve) => {
    const proc = spawn(binaryPath, ['agent', 'stdio'], {
      cwd: process.cwd(),
      env: buildGrokEnv(),
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

    const finish = (state: GrokRuntimeStatus['authState']) => {
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
          if (msg.error) {
            const message = msg.error.message || '';
            finish(
              message.toLowerCase().includes('auth') || message.toLowerCase().includes('login')
                ? 'login_required'
                : 'error'
            );
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
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });
  });
}

export async function getGrokRuntimeStatus(): Promise<GrokRuntimeStatus> {
  const cliPath = await resolveGrokBinary();
  const checkedAt = Date.now();
  if (!cliPath) {
    return {
      ready: false,
      cliAvailable: false,
      cliPath: null,
      cliVersion: null,
      acpAvailable: false,
      authState: 'unknown',
      loginCommand: buildGrokLoginCommand(null),
      summary: 'Grok Build CLI was not found.',
      detail: 'Install Grok Build or set GROK_CODE_PATH to the grok executable.',
      checkedAt,
    };
  }

  const [cliVersion, acpAvailable] = await Promise.all([
    getGrokVersion(cliPath),
    checkAcpAvailable(cliPath),
  ]);
  const authState = acpAvailable ? await probeGrokAuth(cliPath) : 'error';
  const ready = acpAvailable && authState === 'ready';

  return {
    ready,
    cliAvailable: true,
    cliPath,
    cliVersion,
    acpAvailable,
    authState,
    loginCommand: buildGrokLoginCommand(cliPath),
    summary: ready
      ? 'Grok Build ACP is ready.'
      : authState === 'login_required'
        ? 'Grok Build needs login.'
        : acpAvailable
          ? 'Grok Build ACP is installed but not ready.'
          : 'Grok Build ACP was not found.',
    detail: ready
      ? 'Aegis can start Grok Build sessions through ACP.'
      : authState === 'login_required'
        ? `Run ${buildGrokLoginCommand(cliPath)} to authenticate Grok Build.`
        : acpAvailable
          ? 'Aegis could not verify Grok Build authentication.'
          : 'The grok executable does not expose the agent stdio command.',
    checkedAt,
  };
}

export function formatGrokRuntimeBlockingMessage(status: GrokRuntimeStatus): string {
  if (status.authState === 'login_required') {
    return `Grok Build login required. Run: ${status.loginCommand || 'grok login'}`;
  }
  if (!status.cliAvailable) {
    return 'Grok Build CLI is not installed or was not found. Install Grok Build, then restart Aegis.';
  }
  if (!status.acpAvailable) {
    return 'Grok Build ACP is not available from the detected grok executable.';
  }
  return status.detail || 'Grok Build ACP is not ready.';
}
