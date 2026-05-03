import { spawn, type ChildProcess } from 'child_process';
import type { BuiltinToolResult } from '../types';
import { truncate } from './common';

export async function runCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  children: Set<ChildProcess>;
  maxChars?: number;
  noMatchOk?: boolean;
}): Promise<BuiltinToolResult> {
  return new Promise((resolveResult) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    input.children.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
    }, input.timeoutMs);
    const abort = () => child.kill('SIGTERM');
    input.signal.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      input.signal.removeEventListener('abort', abort);
      input.children.delete(child);
      resolveResult({ content: `Error: ${error.message}`, isError: true, status: 'command_error' });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      input.signal.removeEventListener('abort', abort);
      input.children.delete(child);
      const output = [
        stdout ? `stdout:\n${stdout.trimEnd()}` : '',
        stderr ? `stderr:\n${stderr.trimEnd()}` : '',
      ].filter(Boolean).join('\n\n') || '(no output)';
      if (timedOut) {
        resolveResult({ content: truncate(`${output}\n\n[command timed out]`, input.maxChars), isError: true, status: 'timeout' });
        return;
      }
      if (input.noMatchOk && code === 1 && !stderr.trim()) {
        resolveResult({ content: 'No matches found.', status: 'no_match' });
        return;
      }
      resolveResult({
        content: truncate(output, input.maxChars),
        isError: code !== 0,
        status: code === 0 ? 'success' : 'command_error',
      });
    });
  });
}

