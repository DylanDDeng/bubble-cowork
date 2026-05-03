import { readdir, stat } from 'fs/promises';
import { relative, resolve } from 'path';
import type { BuiltinToolRegistryEntry } from '../types';
import { asString, globToRegExp, isSensitivePath, resolveInsideCwd } from './common';

const MAX_RESULTS = 100;
const DEFAULT_IGNORES = new Set(['.git', 'node_modules', 'dist', 'dist-electron', 'dist-react', 'build', '.next', '.turbo', '.cache', 'coverage']);

export function createGlobTool(cwd: string): BuiltinToolRegistryEntry {
  return {
    name: 'glob',
    readOnly: true,
    description: `Find files by glob pattern without using the shell. Returns up to ${MAX_RESULTS} files sorted by recent modification time.`,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: "Glob pattern, for example '**/*', '**/*.ts', or 'src/**/*.tsx'." },
        path: { type: 'string', description: 'Optional directory to search in, relative to the project root.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const root = resolveInsideCwd(cwd, args.path || '.');
      if (!root.ok) return { content: `Error: ${root.error}`, isError: true, status: 'command_error' };
      const pattern = asString(args.pattern).trim();
      if (!pattern) return { content: 'Error: glob pattern is required', isError: true, status: 'command_error' };
      if (isSensitivePath(root.path)) {
        return {
          content: `Error: Glob blocked for sensitive credential storage: ${root.path}`,
          isError: true,
          status: 'blocked',
          metadata: { kind: 'security', path: root.path, pattern },
        };
      }
      const matcher = globToRegExp(pattern);
      const files: Array<{ path: string; mtimeMs: number }> = [];
      const truncated = { value: false };
      try {
        const rootStat = await stat(root.path);
        if (!rootStat.isDirectory()) {
          return { content: `Error: Path is not a directory: ${root.rel}`, isError: true, status: 'command_error' };
        }
        await walk(root.path, root.path, matcher, files, truncated, ctx.abortSignal);
      } catch (error) {
        return { content: `Error: Cannot glob path: ${root.rel} (${error instanceof Error ? error.message : String(error)})`, isError: true, status: 'command_error' };
      }
      files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path));
      const matches = files.slice(0, MAX_RESULTS).map((item) => item.path);
      const wasTruncated = truncated.value || files.length > MAX_RESULTS;
      if (matches.length === 0) {
        return {
          content: 'No files found.',
          status: 'no_match',
          metadata: { kind: 'search', path: root.path, pattern, matches: 0, truncated: false, searchSignature: `glob:${root.path}:${pattern}`, searchFamily: `glob:${pattern}` },
        };
      }
      return {
        content: `${matches.join('\n')}${wasTruncated ? `\n[More than ${MAX_RESULTS} files, output truncated]` : ''}`,
        status: wasTruncated ? 'partial' : 'success',
        metadata: { kind: 'search', path: root.path, pattern, matches: matches.length, truncated: wasTruncated, searchSignature: `glob:${root.path}:${pattern}`, searchFamily: `glob:${pattern}` },
      };
    },
  };
}

async function walk(
  root: string,
  dir: string,
  matcher: RegExp,
  files: Array<{ path: string; mtimeMs: number }>,
  truncated: { value: boolean },
  abortSignal?: AbortSignal
): Promise<void> {
  if (abortSignal?.aborted || files.length >= MAX_RESULTS) {
    truncated.value = true;
    return;
  }
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (abortSignal?.aborted || files.length >= MAX_RESULTS) {
      truncated.value = true;
      return;
    }
    if (entry.isDirectory() && DEFAULT_IGNORES.has(entry.name)) continue;
    const absolute = resolve(dir, entry.name);
    const rel = relative(root, absolute).split('\\').join('/');
    if (entry.isDirectory()) {
      await walk(root, absolute, matcher, files, truncated, abortSignal);
      continue;
    }
    if (entry.isFile() && matcher.test(rel)) {
      const info = await stat(absolute);
      files.push({ path: rel, mtimeMs: info.mtimeMs });
    }
  }
}

