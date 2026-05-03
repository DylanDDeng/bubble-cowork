import type { BuiltinToolRegistryEntry, BuiltinToolResult } from '../types';

export function createTaskTool(): BuiltinToolRegistryEntry {
  return {
    name: 'task',
    readOnly: true,
    description: `Delegate a bounded investigative subtask to a read-only sub-agent and return a concise summary.

Use this when:
- a search or investigation can be scoped as a sub-problem
- you want a focused summary before continuing the main task
- you need to inspect a specific hypothesis or area without polluting the main loop with exploratory churn

Do not use this for edits or shell-heavy workflows. The subtask agent runs in read-only mode.`,
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The focused subtask prompt to investigate.' },
        description: { type: 'string', description: 'Short description of what this subtask is trying to verify.' },
        subtaskType: {
          type: 'string',
          enum: ['search', 'security_investigation', 'evidence_correlation', 'general_readonly'],
          description: 'The bounded subtask policy to apply.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    async execute(args, ctx): Promise<BuiltinToolResult> {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      const description = typeof args.description === 'string' ? args.description.trim() : '';
      const subtaskType = typeof args.subtaskType === 'string' ? args.subtaskType : undefined;
      if (!prompt) {
        return { content: 'Error: task prompt is required', isError: true, status: 'command_error' };
      }
      if (!ctx.agent?.runSubtask) {
        return { content: 'Error: task tool requires an agent runtime', isError: true, status: 'command_error' };
      }
      const composed = description
        ? `${description}\n\n${prompt}\n\nInvestigate this sub-problem in read-only mode and return a concise evidence-based summary.`
        : `${prompt}\n\nInvestigate this sub-problem in read-only mode and return a concise evidence-based summary.`;
      const result = await ctx.agent.runSubtask(composed, ctx.cwd, { subtaskType, description });
      return {
        ...result,
        metadata: {
          ...result.metadata,
          kind: 'subagent',
          reason: description || result.metadata?.reason,
        },
      };
    },
  };
}

