import { readFile } from 'fs/promises';
import { basename, resolve } from 'path';
import type { BuiltinLspAdapter, BuiltinToolResult } from '../types';
import { runCommand } from '../tools/command';

const SYMBOL_RE = /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z_$][\w$]*)/;

export function createStaticLspAdapter(signal: AbortSignal, children: Set<import('child_process').ChildProcess>): BuiltinLspAdapter {
  return {
    async run(input): Promise<BuiltinToolResult> {
      const filePath = resolve(input.cwd, input.filePath);
      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      const lineIndex = Math.max(0, Math.min(lines.length - 1, (input.line || 1) - 1));
      const symbol = input.query?.trim() || symbolAt(lines[lineIndex] || '', Math.max(0, (input.character || 1) - 1));

      if (input.operation === 'documentSymbol') {
        const symbols = lines
          .map((line, index) => {
            const match = line.match(SYMBOL_RE);
            return match
              ? { name: match[1], file: filePath, line: index + 1, preview: line.trim() }
              : null;
          })
          .filter(Boolean);
        return {
          content: symbols.length > 0 ? JSON.stringify(symbols, null, 2) : 'No document symbols found.',
          status: symbols.length > 0 ? 'success' : 'no_match',
          metadata: { kind: 'lsp', path: filePath, matches: symbols.length },
        };
      }

      if (input.operation === 'hover') {
        const start = Math.max(0, lineIndex - 2);
        const end = Math.min(lines.length, lineIndex + 3);
        return {
          content: [
            `File: ${filePath}`,
            `Symbol: ${symbol || '(none)'}`,
            '',
            ...lines.slice(start, end).map((line, index) => `${start + index + 1}: ${line}`),
          ].join('\n'),
          status: 'success',
          metadata: { kind: 'lsp', path: filePath },
        };
      }

      if (input.operation === 'workspaceSymbol') {
        const query = input.query?.trim() || symbol;
        if (!query) return { content: 'Error: query or symbol is required.', isError: true, status: 'command_error' };
        return runCommand({
          command: 'rg',
          args: ['-n', '--color', 'never', query, input.cwd],
          cwd: input.cwd,
          timeoutMs: 20_000,
          signal,
          children,
          maxChars: 40_000,
          noMatchOk: true,
        });
      }

      if (!symbol) {
        return { content: 'No symbol found at the requested position.', status: 'no_match', metadata: { kind: 'lsp', path: filePath } };
      }

      if (input.operation === 'goToDefinition' || input.operation === 'goToImplementation') {
        const declarationPattern = `(function|class|interface|type|const|let|var|enum)\\s+${escapeRegex(symbol)}\\b`;
        const result = await runCommand({
          command: 'rg',
          args: ['-n', '--color', 'never', declarationPattern, input.cwd],
          cwd: input.cwd,
          timeoutMs: 20_000,
          signal,
          children,
          maxChars: 40_000,
          noMatchOk: true,
        });
        return { ...result, metadata: { kind: 'lsp', path: filePath, pattern: declarationPattern } };
      }

      if (input.operation === 'findReferences') {
        const result = await runCommand({
          command: 'rg',
          args: ['-n', '--color', 'never', `\\b${escapeRegex(symbol)}\\b`, input.cwd],
          cwd: input.cwd,
          timeoutMs: 20_000,
          signal,
          children,
          maxChars: 40_000,
          noMatchOk: true,
        });
        return { ...result, metadata: { kind: 'lsp', path: filePath, pattern: symbol } };
      }

      if (input.operation === 'prepareCallHierarchy' || input.operation === 'incomingCalls' || input.operation === 'outgoingCalls') {
        return {
          content: `${input.operation} is not available in the static Aegis code-intelligence adapter for ${basename(filePath)}.`,
          status: 'no_match',
          metadata: { kind: 'lsp', path: filePath },
        };
      }

      return { content: `Unsupported operation: ${input.operation}`, isError: true, status: 'command_error' };
    },
  };
}

function symbolAt(line: string, character: number): string {
  const left = line.slice(0, character + 1).match(/[A-Za-z_$][\w$]*$/)?.[0] || '';
  const right = line.slice(character + 1).match(/^[\w$]*/)?.[0] || '';
  return `${left}${right}`;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

