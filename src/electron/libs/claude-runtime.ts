import fs from 'fs';
import path from 'path';

export type ClaudeCodeRuntime = {
  executable: string;
  executableArgs: string[];
  env: Record<string, string | undefined>;
  pathToClaudeCodeExecutable?: string;
};

export const CLAUDE_CODE_NOT_FOUND_MESSAGE =
  'Claude Code is not installed. Aegis uses the Claude Code installed on this machine. Install Claude Code, make sure `claude` is available on PATH, then restart Aegis.';

function canExecute(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExecutableOnPath(command: string): string | undefined {
  const pathValue = process.env.PATH || '';
  if (!pathValue.trim()) {
    return undefined;
  }

  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .filter(Boolean)
      : [''];

  for (const dir of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate =
        process.platform === 'win32' && command.toLowerCase().endsWith(extension.toLowerCase())
          ? path.join(dir, command)
          : path.join(dir, `${command}${extension}`);

      if (fs.existsSync(candidate) && canExecute(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

function getGlobalClaudeCodeCliPath(): string | undefined {
  const globalBinary = resolveExecutableOnPath('claude');
  if (!globalBinary) {
    return undefined;
  }

  return globalBinary;
}

function resolveClaudeCodeCliPath(): string | undefined {
  return getGlobalClaudeCodeCliPath();
}

function isNodeScriptPath(filePath: string | undefined): boolean {
  if (!filePath) {
    return false;
  }
  const lower = filePath.toLowerCase();
  return lower.endsWith('.js') || lower.endsWith('.cjs') || lower.endsWith('.mjs');
}

export function isClaudeCodeNativeExecutable(filePath: string | undefined): boolean {
  return Boolean(filePath && !isNodeScriptPath(filePath));
}

export function getClaudeCodeRuntime(): ClaudeCodeRuntime {
  const cliPath = resolveClaudeCodeCliPath();
  const env: Record<string, string | undefined> = {};
  let executable = process.execPath;
  let executableArgs: string[] = [];
  let pathToClaudeCodeExecutable = cliPath;

  if (!cliPath) {
    return {
      executable: '',
      executableArgs: [],
      env: {},
      pathToClaudeCodeExecutable: undefined,
    };
  }

  if (isClaudeCodeNativeExecutable(cliPath)) {
    return {
      executable,
      executableArgs: [],
      env: {},
      pathToClaudeCodeExecutable,
    };
  }

  if (process.versions?.electron) {
    const helperExecPath = (process as unknown as { helperExecPath?: string }).helperExecPath;
    executable = helperExecPath || process.execPath;
    env.ELECTRON_RUN_AS_NODE = '1';
    executableArgs = [];
  }

  return {
    executable,
    executableArgs,
    env,
    pathToClaudeCodeExecutable,
  };
}

export function getRequiredClaudeCodeRuntime(): ClaudeCodeRuntime {
  const runtime = getClaudeCodeRuntime();
  if (!runtime.pathToClaudeCodeExecutable) {
    throw new Error(CLAUDE_CODE_NOT_FOUND_MESSAGE);
  }
  return runtime;
}
