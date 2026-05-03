import { existsSync } from 'fs';
import { platform } from 'os';
import type { BuiltinApprovalController, BuiltinToolRegistryEntry } from '../types';
import { asNumber, asString, parseSearchBashCommand, referencesSensitivePath } from './common';
import { runCommand } from './command';

export function createBashTool(
  cwd: string,
  approval: BuiltinApprovalController | undefined,
  children: Set<import('child_process').ChildProcess>
): BuiltinToolRegistryEntry {
  return {
    name: 'bash',
    description: 'Execute a bash command in the working directory. Use timeout for long-running commands.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
        timeout: { type: 'number', description: 'Timeout in seconds. Defaults to 60.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      if (!existsSync(cwd)) {
        return { content: `Error: Working directory does not exist: ${cwd}`, isError: true, status: 'command_error' };
      }
      const command = asString(args.command).trim();
      if (!command) return { content: 'Error: command is required', isError: true, status: 'command_error' };
      const parsedSearch = parseSearchBashCommand(command);
      if (referencesSensitivePath(command)) {
        return {
          content: 'Error: Bash access to sensitive credential storage is blocked.',
          isError: true,
          status: 'blocked',
          metadata: { kind: 'security', reason: 'Sensitive credential storage is not accessible from general-purpose bash commands.' },
        };
      }
      const decision = await approval?.requestCommand({ id: ctx.toolCall.id, command, cwd });
      if (decision && decision.behavior !== 'allow') {
        return { content: decision.message || 'Command was denied by the user.', isError: true, status: 'blocked' };
      }
      const result = await runCommand({
        command: platform() === 'win32' ? 'cmd.exe' : 'bash',
        args: platform() === 'win32' ? ['/c', command] : ['-lc', command],
        cwd,
        timeoutMs: Math.max(1, Math.min(600, asNumber(args.timeout, 60))) * 1000,
        signal: ctx.abortSignal,
        children,
      });
      return {
        ...result,
        metadata: {
          ...result.metadata,
          kind: parsedSearch ? 'search' : 'shell',
          pattern: parsedSearch?.pattern,
          path: parsedSearch?.path,
        },
      };
    },
  };
}

