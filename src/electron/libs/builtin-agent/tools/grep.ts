import { execFile } from 'child_process';
import { resolve } from 'path';
import type { BuiltinToolRegistryEntry } from '../types';
import { asString, isSensitivePath } from './common';

const MAX_MATCHES = 100;

export function createGrepTool(cwd: string): BuiltinToolRegistryEntry {
  return {
    name: 'grep',
    readOnly: true,
    description: `Search file contents using regex via ripgrep. Use this instead of running grep/rg through bash. Returns up to ${MAX_MATCHES} matches.`,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for.' },
        path: { type: 'string', description: 'Optional file or directory path, relative to the project root.' },
        glob: { type: 'string', description: "Optional file glob filter, for example '*.ts'." },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    async execute(args) {
      const pattern = asString(args.pattern).trim();
      if (!pattern) return { content: 'Error: pattern is required', isError: true, status: 'command_error' };
      const searchPath = args.path ? resolve(cwd, asString(args.path)) : cwd;
      if (isSensitivePath(searchPath)) {
        return {
          content: `Error: Search blocked for sensitive credential storage: ${searchPath}`,
          isError: true,
          status: 'blocked',
          metadata: { kind: 'security', path: searchPath, pattern },
        };
      }
      const rgArgs = ['--json', '-n', '--max-count', String(MAX_MATCHES), pattern];
      const glob = asString(args.glob).trim();
      if (glob) rgArgs.push('--glob', glob);
      rgArgs.push(searchPath);
      return new Promise((resolveResult) => {
        execFile('rg', rgArgs, { cwd, maxBuffer: 10 * 1024 * 1024 }, (_error, stdout) => {
          const matches: string[] = [];
          for (const line of stdout.split('\n').filter((item) => item.trim())) {
            try {
              const obj = JSON.parse(line);
              if (obj.type === 'match') {
                matches.push(`${obj.data.path.text}:${obj.data.line_number}: ${obj.data.lines.text?.trim() ?? ''}`);
              }
            } catch {
              // Ignore malformed ripgrep JSON lines.
            }
          }
          if (matches.length === 0) {
            resolveResult({
              content: 'No matches found.',
              status: 'no_match',
              metadata: { kind: 'search', path: searchPath, pattern, matches: 0, truncated: false, searchSignature: `grep:${searchPath}:${pattern}:${glob}`, searchFamily: `grep:${pattern}` },
            });
            return;
          }
          const truncated = matches.length >= MAX_MATCHES;
          resolveResult({
            content: `${matches.join('\n')}${truncated ? `\n[More than ${MAX_MATCHES} matches, output truncated]` : ''}`,
            status: truncated ? 'partial' : 'success',
            metadata: { kind: 'search', path: searchPath, pattern, matches: matches.length, truncated, searchSignature: `grep:${searchPath}:${pattern}:${glob}`, searchFamily: `grep:${pattern}` },
          });
        });
      });
    },
  };
}

