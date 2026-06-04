import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const KIMI_DEFAULT_BINARY_PATH = path.join(homedir(), '.kimi-code', 'bin', 'kimi');

function isExecutableCandidate(filePath: string | undefined | null): filePath is string {
  return Boolean(filePath && filePath.trim() && existsSync(filePath));
}

async function resolveOnPath(command: string): Promise<string | null> {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await execFileAsync(locator, [command], { timeout: 2500 });
    const first = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

export async function resolveKimiBinary(): Promise<string | null> {
  const envPath = process.env.KIMI_CODE_PATH?.trim();
  if (isExecutableCandidate(envPath)) {
    return envPath;
  }

  if (isExecutableCandidate(KIMI_DEFAULT_BINARY_PATH)) {
    return KIMI_DEFAULT_BINARY_PATH;
  }

  return resolveOnPath('kimi');
}

export function buildKimiEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const kimiBinDir = path.dirname(KIMI_DEFAULT_BINARY_PATH);
  const currentPath = env.PATH || '';
  const parts = currentPath.split(path.delimiter).filter(Boolean);
  env.PATH = [kimiBinDir, ...parts.filter((part) => part !== kimiBinDir)].join(path.delimiter);
  return env;
}

export function buildKimiLoginCommand(binaryPath: string | null): string {
  return `${binaryPath || 'kimi'} login`;
}
