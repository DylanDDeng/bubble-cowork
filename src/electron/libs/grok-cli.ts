import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const GROK_DEFAULT_BINARY_PATH = path.join(homedir(), '.grok', 'bin', 'grok');

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

export async function resolveGrokBinary(): Promise<string | null> {
  const envPath = process.env.GROK_CODE_PATH?.trim();
  if (isExecutableCandidate(envPath)) {
    return envPath;
  }

  if (isExecutableCandidate(GROK_DEFAULT_BINARY_PATH)) {
    return GROK_DEFAULT_BINARY_PATH;
  }

  return resolveOnPath('grok');
}

export function buildGrokEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const grokBinDir = path.dirname(GROK_DEFAULT_BINARY_PATH);
  const currentPath = env.PATH || '';
  const parts = currentPath.split(path.delimiter).filter(Boolean);
  env.PATH = [grokBinDir, ...parts.filter((part) => part !== grokBinDir)].join(path.delimiter);
  return env;
}

export function buildGrokLoginCommand(binaryPath: string | null): string {
  return `${binaryPath || 'grok'} login`;
}
