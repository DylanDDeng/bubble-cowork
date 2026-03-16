import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

export type ClaudeCodeRuntime = {
  executable: string;
  executableArgs: string[];
  env: Record<string, string | undefined>;
  pathToClaudeCodeExecutable?: string;
};

const requireFn = createRequire(__filename);

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

  try {
    const resolved = fs.realpathSync(globalBinary);
    return fs.existsSync(resolved) ? resolved : globalBinary;
  } catch {
    return globalBinary;
  }
}

function resolveUnpackedPath(maybeAsarPath: string): string {
  const unpacked = maybeAsarPath.replace(/app\.asar([\\/])/g, 'app.asar.unpacked$1');
  if (unpacked !== maybeAsarPath && fs.existsSync(unpacked)) {
    return unpacked;
  }
  return maybeAsarPath;
}

function getBundledClaudeCodeCliPath(): string | undefined {
  if (!process.resourcesPath) {
    return undefined;
  }

  const candidate = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@anthropic-ai',
    'claude-agent-sdk',
    'cli.js'
  );

  return fs.existsSync(candidate) ? candidate : undefined;
}

function resolveClaudeCodeCliPath(): string | undefined {
  const global = getGlobalClaudeCodeCliPath();
  if (global) {
    return global;
  }

  const bundled = getBundledClaudeCodeCliPath();
  if (bundled) {
    return bundled;
  }

  try {
    const sdkEntry = resolveUnpackedPath(requireFn.resolve('@anthropic-ai/claude-agent-sdk'));
    const candidate = path.join(path.dirname(sdkEntry), 'cli.js');
    return fs.existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function getClaudeCodeRuntime(): ClaudeCodeRuntime {
  const env: Record<string, string | undefined> = {};
  let executable = process.execPath;
  let executableArgs: string[] = [];

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
    pathToClaudeCodeExecutable: resolveClaudeCodeCliPath(),
  };
}
