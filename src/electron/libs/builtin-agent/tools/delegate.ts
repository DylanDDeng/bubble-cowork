import { randomUUID } from 'crypto';
import type { DelegateCall } from '../../../../shared/types';
import type { BuiltinToolRegistryEntry, BuiltinToolResult } from '../types';

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => asString(item))
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function createDelegateTool(): BuiltinToolRegistryEntry {
  return {
    name: 'delegate',
    readOnly: true,
    description: `Delegate one focused task to a configured Channel Team member and wait for that member's structured result.

Use this only when a team member can make parallel progress on a clearly bounded subtask. Include the reason because the UI shows it to the user. Do not use this for background jobs or for sequential task graphs; after delegate results return, decide the next step in a new leader turn.`,
    parameters: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'The target team member agent id.',
        },
        task: {
          type: 'string',
          description: 'A self-contained task with necessary file paths, refs, and expected output.',
        },
        reason: {
          type: 'string',
          description: 'One short reason shown in collapsed activity, e.g. "code change touches auth flow".',
        },
        contextRefs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional explicit references such as file paths, URLs, or message IDs.',
        },
      },
      required: ['agentId', 'task', 'reason'],
      additionalProperties: false,
    },
    async execute(args, ctx): Promise<BuiltinToolResult> {
      const agentId = asString(args.agentId);
      const task = asString(args.task);
      const reason = asString(args.reason);
      if (!agentId || !task || !reason) {
        return {
          content: 'Error: delegate requires agentId, task, and reason.',
          isError: true,
          status: 'command_error',
          metadata: { kind: 'delegate', reason: 'missing_required_args' },
        };
      }
      if (!ctx.agent?.runDelegate) {
        return {
          content: 'Error: this session has no active Channel Team delegate runtime.',
          isError: true,
          status: 'blocked',
          metadata: { kind: 'delegate', reason: 'delegate_runtime_unavailable' },
        };
      }

      const call: DelegateCall = {
        id: ctx.toolCall.id || `delegate-${randomUUID()}`,
        agentId,
        task,
        reason,
        contextRefs: asStringArray(args.contextRefs),
      };
      const result = await ctx.agent.runDelegate(call);
      const content = [
        `Delegate result for ${result.agentId}: ${result.status}`,
        result.errorKind ? `Error kind: ${result.errorKind}` : '',
        '',
        result.summary,
        result.artifacts && result.artifacts.length > 0
          ? `\nArtifacts:\n${result.artifacts.map((artifact) => `- ${artifact.type}:${artifact.id} ${artifact.title}`).join('\n')}`
          : '',
        `\nRaw ref: ${result.rawRef}`,
      ].filter(Boolean).join('\n');

      return {
        content,
        isError: result.status === 'error',
        status: result.status === 'ok' ? 'success' : result.status === 'blocked' ? 'blocked' : 'partial',
        metadata: {
          kind: 'delegate',
          reason,
          delegateCall: call,
          delegateResult: result,
        },
      };
    },
  };
}
