import { execFile } from 'child_process';
import type { KimiRuntimeStatus } from '../../shared/types';
import { buildKimiEnv, buildKimiLoginCommand, resolveKimiBinary } from './kimi-cli';
import { isKimiServerCapable } from './provider/kimi-adapter-facade';

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
      serverAvailable: false,
      authState: 'unknown',
      loginCommand: buildKimiLoginCommand(null),
      summary: 'Kimi Code CLI was not found.',
      detail: 'Install Kimi Code or set KIMI_CODE_PATH to the kimi executable.',
      checkedAt,
    };
  }

  const [cliVersion, serverAvailable] = await Promise.all([
    getKimiVersion(cliPath),
    isKimiServerCapable(),
  ]);
  // Capability gating only: Kimi runs on the local server, and login problems
  // surface from the daemon at turn time. Nothing here spawns an agent.
  const ready = serverAvailable;

  return {
    ready,
    cliAvailable: true,
    cliPath,
    cliVersion,
    serverAvailable,
    authState: 'unknown',
    loginCommand: buildKimiLoginCommand(cliPath),
    summary: ready ? 'Kimi Code is ready.' : 'Kimi Code server runtime was not found.',
    detail: ready
      ? 'Aegis can start Kimi Code sessions through the local Kimi server.'
      : 'The detected kimi executable does not expose the server runtime. Update Kimi Code.',
    checkedAt,
  };
}

export function formatKimiRuntimeBlockingMessage(status: KimiRuntimeStatus): string {
  if (status.authState === 'login_required') {
    return `Kimi Code login required. Run: ${status.loginCommand || 'kimi login'}`;
  }
  if (!status.cliAvailable) {
    return 'Kimi Code CLI is not installed or was not found. Install Kimi Code, then restart Aegis.';
  }
  if (!status.serverAvailable) {
    return 'The detected kimi executable does not expose the server runtime. Update Kimi Code, then restart Aegis.';
  }
  return status.detail || 'Kimi Code is not ready.';
}
