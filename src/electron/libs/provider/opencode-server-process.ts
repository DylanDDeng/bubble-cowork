import { execFile, spawn, spawnSync, type ChildProcess } from 'child_process';
import { accessSync, constants, realpathSync } from 'fs';
import { delimiter, join } from 'path';

/**
 * Starts an OpenCode 2.x server (`opencode serve --stdio`) that only Aegis
 * talks to. The server authenticates every `/api/*` request with HTTP Basic
 * `opencode:<password>`; the password is generated per launch and handed over
 * through OPENCODE_SERVER_PASSWORD (the server scrubs it from the environment
 * its own children inherit). In stdio mode the server exits when its stdin
 * closes, so it cannot outlive Aegis even after a crash.
 */

/** Points at a specific opencode binary, bypassing the PATH search. */
export const OPENCODE_BIN_ENV = 'AEGIS_OPENCODE_BIN';

const MIN_SUPPORTED_MAJOR_VERSION = 2;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const STOP_GRACE_MS = 3_000;

export type OpenCodeVersion = {
  major: number;
  minor: number;
  patch: number;
  raw: string;
};

export type OpenCodeBinary = {
  path: string;
  version: OpenCodeVersion;
};

export type OpenCodeServerProcess = {
  url: string;
  pid: number | undefined;
  /** Resolves with the exit code once the process is gone. */
  exited: Promise<number | null>;
  close(): void;
};

export function parseOpenCodeVersion(output: string): OpenCodeVersion | null {
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    raw: match[0],
  };
}

/**
 * Reads the server URL from an `opencode serve` stdout line: stdio mode prints
 * `{"url":"http://127.0.0.1:PORT"}`, plain mode "server listening on <url>".
 */
export function parseOpenCodeServerUrl(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { url?: unknown };
      return typeof parsed.url === 'string' && /^https?:\/\//.test(parsed.url) ? parsed.url : null;
    } catch {
      return null;
    }
  }
  const match = trimmed.match(/^(?:opencode )?server listening on\s+(https?:\/\/\S+)/);
  return match ? match[1] : null;
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Every `opencode` on PATH, in PATH order, de-duplicated by real path. */
export function findOpenCodeBinaryCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const override = env[OPENCODE_BIN_ENV]?.trim();
  if (override) return [override];

  const names = process.platform === 'win32'
    ? ['opencode.exe', 'opencode.cmd', 'opencode.bat', 'opencode']
    : ['opencode'];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const dir of (env.PATH || '').split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const file = join(dir, name);
      if (!isExecutableFile(file)) continue;
      let real = file;
      try {
        real = realpathSync(file);
      } catch {
        // Keep the unresolved path; the version probe decides whether it runs.
      }
      if (seen.has(real)) continue;
      seen.add(real);
      candidates.push(file);
    }
  }
  return candidates;
}

function needsShell(file: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
}

function probeOpenCodeVersion(file: string): Promise<OpenCodeVersion | null> {
  return new Promise((resolve) => {
    execFile(
      file,
      ['--version'],
      { timeout: VERSION_PROBE_TIMEOUT_MS, shell: needsShell(file), windowsHide: true },
      (error, stdout, stderr) => {
        resolve(error ? null : parseOpenCodeVersion(`${stdout}\n${stderr}`));
      }
    );
  });
}

/** The first opencode on PATH that is 2.x or newer. */
export async function resolveOpenCodeBinary(env: NodeJS.ProcessEnv = process.env): Promise<OpenCodeBinary> {
  const unsupported: OpenCodeBinary[] = [];
  for (const file of findOpenCodeBinaryCandidates(env)) {
    const version = await probeOpenCodeVersion(file);
    if (!version) continue;
    if (version.major >= MIN_SUPPORTED_MAJOR_VERSION) {
      return { path: file, version };
    }
    unsupported.push({ path: file, version });
  }

  if (unsupported.length > 0) {
    const found = unsupported.map((binary) => `${binary.version.raw} at ${binary.path}`).join(', ');
    throw new Error(
      `OpenCode CLI ${found} is too old: Aegis needs OpenCode 2.x. ` +
        `Install it with "npm install -g @opencode/cli" or set ${OPENCODE_BIN_ENV} to a 2.x opencode binary.`
    );
  }
  if (env[OPENCODE_BIN_ENV]?.trim()) {
    throw new Error(`${OPENCODE_BIN_ENV}=${env[OPENCODE_BIN_ENV]} is not a runnable opencode binary.`);
  }
  throw new Error('OpenCode CLI not found on PATH. Install it with "npm install -g @opencode/cli".');
}

function killProcess(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === 'win32' && proc.pid) {
    const out = spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
    if (!out.error && out.status === 0) return;
  }
  proc.kill();
}

export async function startOpenCodeServerProcess(options: {
  binary: string;
  hostname: string;
  port: number;
  password: string;
  timeout: number;
  config: Record<string, unknown>;
}): Promise<OpenCodeServerProcess> {
  const proc = spawn(
    options.binary,
    ['serve', '--stdio', `--hostname=${options.hostname}`, `--port=${options.port}`],
    {
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: options.password,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config),
      },
      // stdin stays open for the server's lifetime: closing it is the shutdown signal.
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: needsShell(options.binary),
      windowsHide: true,
    }
  );
  const exited = new Promise<number | null>((resolve) => {
    proc.once('exit', (code) => resolve(code));
    proc.once('error', () => resolve(null));
  });
  // An EPIPE on stdin after the server died must not crash the main process.
  proc.stdin?.on('error', () => undefined);

  const close = () => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    proc.stdin?.end();
    const fallback = setTimeout(() => killProcess(proc), STOP_GRACE_MS);
    fallback.unref?.();
    void exited.then(() => clearTimeout(fallback));
  };

  const url = await new Promise<string>((resolve, reject) => {
    let output = '';
    let settled = false;
    const settle = (error: Error | null, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        killProcess(proc);
        reject(error);
      } else {
        resolve(value as string);
      }
    };
    const withOutput = (message: string) => message + (output.trim() ? `\nServer output: ${output.trim()}` : '');
    const timer = setTimeout(() => {
      settle(new Error(withOutput(`Timeout waiting for OpenCode server to start after ${options.timeout}ms`)));
    }, options.timeout);

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      output += chunk.toString();
      for (const line of output.split('\n')) {
        const found = parseOpenCodeServerUrl(line);
        if (found) {
          settle(null, found);
          return;
        }
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (!settled) output += chunk.toString();
    });
    proc.once('exit', (code) => settle(new Error(withOutput(`OpenCode server exited with code ${code}`))));
    proc.once('error', (error) => settle(error));
  });

  return { url, pid: proc.pid, exited, close };
}
