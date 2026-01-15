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
  const bundled = getBundledClaudeCodeCliPath();
  if (bundled) {
    return bundled;
  }

  try {
    return resolveUnpackedPath(requireFn.resolve('@anthropic-ai/claude-agent-sdk/cli.js'));
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
