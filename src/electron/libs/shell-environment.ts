import { execFileSync } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const ENV_MARKER_BEGIN = '__AEGIS_ENV_BEGIN_9f3a7c__';
const ENV_MARKER_END = '__AEGIS_ENV_END_9f3a7c__';

const INHERITED_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SHELL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENCODE_API_KEY',
  'NVM_DIR',
  'VOLTA_HOME',
  'PNPM_HOME',
  'BUN_INSTALL',
] as const;

type ShellEnvResult = {
  env: Record<string, string>;
  source: 'interactive-login' | 'login' | 'none';
};

function runShellEnvDump(shell: string, flags: string): Record<string, string> | null {
  // Wrap the env dump with markers so noise from interactive shell startup
  // (MOTD, prompts, plugin warnings) cannot corrupt the parsed output.
  const command = `echo ${ENV_MARKER_BEGIN}; env; echo ${ENV_MARKER_END}`;

  let stdout: string;
  try {
    stdout = execFileSync(shell, [flags, command], {
      encoding: 'utf-8',
      timeout: 8000,
      maxBuffer: 4 * 1024 * 1024,
      // Silence stderr so shell startup noise doesn't leak to Electron logs.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }

  const startIdx = stdout.indexOf(ENV_MARKER_BEGIN);
  const endIdx = stdout.indexOf(ENV_MARKER_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }

  const block = stdout.slice(startIdx + ENV_MARKER_BEGIN.length, endIdx);
  const env: Record<string, string> = {};
  for (const line of block.split('\n')) {
    if (!line) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = line.slice(eq + 1);
  }

  if (!env.PATH) {
    return null;
  }
  return env;
}

function isExecutableDir(dir: string): boolean {
  try {
    return existsSync(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

// Fallback PATH entries for when shell-probing fails. Only directories that
// actually exist on disk are appended, so we don't accumulate stale paths.
function collectFallbackPathEntries(home: string): string[] {
  const candidates: string[] = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    join(home, '.local', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.pnpm'),
  ];

  // nvm installs nodes at ~/.nvm/versions/node/<version>/bin. The `current`
  // symlink used in older docs doesn't actually exist, so we glob instead.
  const nvmRoot = join(home, '.nvm', 'versions', 'node');
  for (const entry of safeReaddir(nvmRoot)) {
    candidates.push(join(nvmRoot, entry, 'bin'));
  }

  // fnm uses ~/.fnm/node-versions/<ver>/installation/bin on macOS/Linux.
  const fnmRoot = join(home, '.fnm', 'node-versions');
  for (const entry of safeReaddir(fnmRoot)) {
    candidates.push(join(fnmRoot, entry, 'installation', 'bin'));
  }

  // asdf: ~/.asdf/installs/nodejs/<ver>/bin. Use shim dir too.
  const asdfNodejs = join(home, '.asdf', 'installs', 'nodejs');
  for (const entry of safeReaddir(asdfNodejs)) {
    candidates.push(join(asdfNodejs, entry, 'bin'));
  }
  candidates.push(join(home, '.asdf', 'shims'));

  return candidates.filter(isExecutableDir);
}

// Fallback entries are a safety net — they must never shadow what the user's
// shell rc files resolved. We de-dupe and append to the end of PATH so whatever
// the interactive shell returned (e.g. the active nvm node) still wins lookups.
function mergePathAppending(basePath: string, additions: string[]): string {
  const existing = basePath.split(':').filter(Boolean);
  const existingSet = new Set(existing);
  const appended: string[] = [];
  for (const entry of additions) {
    if (!existingSet.has(entry)) {
      appended.push(entry);
      existingSet.add(entry);
    }
  }
  return [...existing, ...appended].join(':');
}

export function loadShellEnvironment(): ShellEnvResult {
  if (process.platform === 'win32') {
    return { env: {}, source: 'none' };
  }

  const shell = process.env.SHELL || '/bin/zsh';

  // 1) Try interactive + login so .zshrc / .bashrc (where nvm/volta live) get sourced.
  let env = runShellEnvDump(shell, '-ilc');
  let source: ShellEnvResult['source'] = 'interactive-login';

  // 2) Some locked-down shells (sh, fish-as-symlink, restricted corporate setups)
  //    reject -i or time out. Fall back to a plain login shell.
  if (!env) {
    env = runShellEnvDump(shell, '-lc');
    source = env ? 'login' : 'none';
  }

  return { env: env || {}, source };
}

/**
 * Ensures process.env has the PATH and auth vars that a normal terminal would
 * see. Safe to call once at startup; does nothing on Windows.
 */
export function ensureShellEnvironment(): void {
  if (process.platform === 'win32') return;

  const { env, source } = loadShellEnvironment();

  for (const key of INHERITED_ENV_KEYS) {
    const value = env[key];
    if (value && value.length > 0) {
      process.env[key] = value;
    }
  }

  const home = process.env.HOME || env.HOME || '';
  const fallbackEntries = home ? collectFallbackPathEntries(home) : [];
  const currentPath = process.env.PATH || '';
  if (fallbackEntries.length > 0) {
    process.env.PATH = mergePathAppending(currentPath, fallbackEntries);
  }

  const pathPreview = (process.env.PATH || '').split(':').slice(0, 6).join(':');
  console.log('[Environment] Resolved shell environment', {
    source,
    shell: process.env.SHELL,
    hasPath: Boolean(process.env.PATH),
    hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
    pathPreview,
    includesNvm: (process.env.PATH || '').includes('.nvm/versions/node'),
  });
}
