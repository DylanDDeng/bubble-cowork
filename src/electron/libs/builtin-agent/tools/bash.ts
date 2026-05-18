import { existsSync } from 'fs';
import { platform } from 'os';
import type { BuiltinApprovalController, BuiltinToolRegistryEntry } from '../types';
import { asNumber, asString, classifyDangerousBashCommand, parseReadBashCommand, parseSearchBashCommand, referencesSensitivePath } from './common';
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
      const parsedRead = parsedSearch ? null : parseReadBashCommand(command);
      const dangerousReason = classifyDangerousBashCommand(command);
      if (dangerousReason) {
        return {
          content: `Error: Bash command blocked: ${dangerousReason}.`,
          isError: true,
          status: 'blocked',
          metadata: { kind: 'security', reason: dangerousReason, command },
        };
      }
      if (referencesSensitivePath(command)) {
        return {
          content: 'Error: Bash access to sensitive credential storage is blocked.',
          isError: true,
          status: 'blocked',
          metadata: { kind: 'security', reason: 'Sensitive credential storage is not accessible from general-purpose bash commands.' },
        };
      }
      const decision = await approval?.requestCommand({
        id: ctx.toolCall.id,
        command,
        cwd,
        summary: [
          parsedSearch ? 'Search command' : parsedRead ? 'File read command' : 'Shell command',
          `Timeout: ${Math.max(1, Math.min(300, asNumber(args.timeout, 60)))}s`,
          parsedSearch?.path ? `Path: ${parsedSearch.path}` : parsedRead?.path ? `Path: ${parsedRead.path}` : '',
          parsedSearch?.pattern ? `Pattern: ${parsedSearch.pattern}` : '',
        ].filter(Boolean),
      });
      if (decision && decision.behavior !== 'allow') {
        return { content: decision.message || 'Command was denied by the user.', isError: true, status: 'blocked' };
      }
      const timeoutSec = Math.max(1, Math.min(300, asNumber(args.timeout, 60)));
      const result = await runCommand({
        command: platform() === 'win32' ? 'cmd.exe' : 'bash',
        args: platform() === 'win32' ? ['/c', command] : ['-lc', command],
        cwd,
        timeoutMs: timeoutSec * 1000,
        signal: ctx.abortSignal,
        children,
      });
      return {
        ...result,
        metadata: {
          ...result.metadata,
          kind: parsedSearch ? 'search' : parsedRead ? 'read' : 'shell',
          pattern: parsedSearch?.pattern,
          path: parsedSearch?.path ?? parsedRead?.path,
          command,
          timeoutSec,
          searchSignature: parsedSearch
            ? `bash-search:${parsedSearch.path || '.'}:${parsedSearch.pattern}:${parsedSearch.include || '*'}`
            : undefined,
          searchFamily: parsedSearch ? `bash-search:${parsedSearch.pattern}` : undefined,
          readSignature: parsedRead
            ? `bash-read:${parsedRead.path}:${parsedRead.offset ?? 1}:${parsedRead.limit ?? 'default'}`
            : undefined,
          readFamily: parsedRead ? `bash-read:${parsedRead.path}` : undefined,
        },
      };
    },
  };
}
