/**
 * Agent lifecycle tools: spawn_agent, wait_agent, send_input, close_agent.
 *
 * These tools rely on `context.agent` implementing BuiltinSubagentHost (injected
 * by the agent core when building the execution context).
 */

import type { BuiltinToolRegistryEntry } from '../types';
import type { SubagentThreadSnapshot } from '../governance/subagent-control';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSnapshot(snapshots: SubagentThreadSnapshot[]): string {
  if (snapshots.length === 0) return 'No subagents.';
  return snapshots
    .map(
      (s) =>
        `- id=${s.id} nickname=${s.nickname} status=${s.status} task="${s.task.slice(0, 80)}…" created=${new Date(s.createdAt).toISOString()}`
    )
    .join('\n');
}

function formatLifecycleResult(
  operation: string,
  snapshots: SubagentThreadSnapshot[]
): string {
  if (snapshots.length === 0) return `[${operation}] No matching subagents.`;
  const lines = snapshots.map((s) => {
    const summary =
      s.status === 'completed'
        ? `completed, summary: ${s.summary ?? '(none)'}`
        : s.status === 'failed'
          ? `failed, error: ${s.error ?? '(none)'}`
          : s.status;
    return `- id=${s.id} nickname=${s.nickname} status=${s.status} ${summary}`;
  });
  return `[${operation}]\n${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// spawn_agent
// ---------------------------------------------------------------------------

const spawnAgentSchema = {
  type: 'object',
  properties: {
    agent_type: {
      type: 'string',
      description:
        'Agent type. One of: default, explorer, worker, inspector, scholar.',
    },
    message: {
      type: 'string',
      description: 'Task description for the subagent.',
    },
    category: {
      type: 'string',
      description: 'Optional semantic category (quick, deep, review, frontend, writing).',
    },
    blocking: {
      type: 'boolean',
      description:
        'If true, wait synchronously for the subagent to finish before returning (like a blocking delegate).',
    },
    timeout_ms: {
      type: 'number',
      description: 'Optional timeout in milliseconds.',
    },
    agent: {
      type: 'string',
      description: 'Alias for agent_type.',
    },
    task: {
      type: 'string',
      description: 'Alias for message.',
    },
  },
  required: ['message'],
};

function createSpawnAgentTool(): BuiltinToolRegistryEntry {
  return {
    name: 'spawn_agent',
    description:
      'Start a child subagent in the background and return its id plus random nickname. ' +
      'Use this for delegating work: whenever the user asks for a multi-step task, spawn a ' +
      'subagent instead of doing all the work yourself. After spawning, wait for the result ' +
      'before using it, or spawn multiple agents and wait for all of them.',
    parameters: spawnAgentSchema,
    readOnly: false,
    async execute(args, ctx) {
      const host = ctx.agent;
      if (!host?.spawnSubAgent) {
        return {
          content: 'Error: subagent host not available in this context.',
          isError: true,
        };
      }

      const agentType =
        args.agent_type ?? args.agent ?? 'default';
      const message =
        args.message ?? args.task ?? '';
      if (!message) {
        return {
          content: 'Error: message/task is required for spawn_agent.',
          isError: true,
        };
      }

      const snapshot = await host.spawnSubAgent({
        agentType: String(agentType),
        message: String(message),
        toolCallId: ctx.toolCall?.id,
        category: args.category != null ? String(args.category) : undefined,
        blocking: args.blocking != null ? Boolean(args.blocking) : false,
        timeoutMs: args.timeout_ms != null ? Number(args.timeout_ms) : undefined,
      });

      return {
        content: `Spawned subagent "${snapshot.nickname}" (id=${snapshot.id}) status=${snapshot.status}.\n` +
          `Use wait_agent(id="${snapshot.id}") to collect the result.`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// wait_agent
// ---------------------------------------------------------------------------

const waitAgentSchema = {
  type: 'object',
  properties: {
    agent_id: {
      type: 'string',
      description: 'Single subagent id to wait for.',
    },
    agent_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'Multiple subagent ids to wait for. If omitted, waits for all active subagents.',
    },
    timeout_ms: {
      type: 'number',
      description: 'Maximum wait time in milliseconds. Defaults to 30000.',
    },
  },
};

function createWaitAgentTool(): BuiltinToolRegistryEntry {
  return {
    name: 'wait_agent',
    description:
      'Wait for one or more spawned subagents to reach a final status and return snapshots. ' +
      'If the wait times out while children are still running, returns partial results. ' +
      'Call wait_agent before declaring a subagent has failed or before using its results.',
    parameters: waitAgentSchema,
    readOnly: false,
    async execute(args, ctx) {
      const host = ctx.agent;
      if (!host?.waitForAgentStop) {
        return {
          content: 'Error: subagent host not available in this context.',
          isError: true,
        };
      }

      let agentId: string | undefined;
      const rawAgentId = args.agent_id;
      const rawAgentIds = args.agent_ids;
      if (rawAgentId != null) {
        agentId = String(rawAgentId);
      } else if (Array.isArray(rawAgentIds) && rawAgentIds.length > 0) {
        // wait for multiple — we'll wait for first listed and collect all
        agentId = String(rawAgentIds[0]);
      }

      const timeoutMs =
        args.timeout_ms != null ? Number(args.timeout_ms) : 30000;

      const snapshots = await host.waitForAgentStop(agentId, timeoutMs);
      return {
        content: formatLifecycleResult('wait_agent', snapshots),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// send_input
// ---------------------------------------------------------------------------

const sendInputSchema = {
  type: 'object',
  properties: {
    agent_id: {
      type: 'string',
      description: 'Target subagent id.',
    },
    message: {
      type: 'string',
      description: 'Follow-up message to send to the subagent.',
    },
    interrupt: {
      type: 'boolean',
      description:
        'If true, cancel a running child before sending this input. The ' +
        'subagent will be re-spawned with the new message.',
    },
    task: {
      type: 'string',
      description: 'Alias for message.',
    },
  },
  required: ['agent_id', 'message'],
};

function createSendInputTool(): BuiltinToolRegistryEntry {
  return {
    name: 'send_input',
    description:
      'Send a follow-up message to an existing subagent thread. If it is still running, ' +
      'pass interrupt:true to cancel it and re-spawn with the new message.',
    parameters: sendInputSchema,
    readOnly: false,
    execute(args, ctx) {
      const host = ctx.agent;
      if (!host?.sendSubAgentInput) {
        return Promise.resolve({
          content: 'Error: subagent host not available in this context.',
          isError: true,
        });
      }

      const agentId = String(args.agent_id);
      const message =
        args.message ?? args.task ?? '';
      const interrupt = args.interrupt != null ? Boolean(args.interrupt) : false;

      const snapshot = host.sendSubAgentInput(agentId, String(message), interrupt);
      if (!snapshot) {
        return Promise.resolve({
          content: `No subagent found with id=${agentId}.`,
          isError: true,
        });
      }

      return Promise.resolve({
        content: formatLifecycleResult('send_input', [snapshot]),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// close_agent
// ---------------------------------------------------------------------------

const closeAgentSchema = {
  type: 'object',
  properties: {
    agent_id: {
      type: 'string',
      description:
        'Subagent id to close. Only close subagents whose delegated task is ' +
        'cancelled, stale, or no longer needed.',
    },
  },
  required: ['agent_id'],
};

function createCloseAgentTool(): BuiltinToolRegistryEntry {
  return {
    name: 'close_agent',
    description:
      'Close a spawned subagent. Use this only when the delegated task is cancelled, ' +
      'stale, or no longer needed. Do NOT close a subagent just because you started ' +
      'doing the same work locally.',
    parameters: closeAgentSchema,
    readOnly: false,
    execute(args, ctx) {
      const host = ctx.agent;
      if (!host?.closeSubAgent) {
        return Promise.resolve({
          content: 'Error: subagent host not available in this context.',
          isError: true,
        });
      }

      const agentId = String(args.agent_id);
      const snapshot = host.closeSubAgent(agentId);
      if (!snapshot) {
        return Promise.resolve({
          content: `No subagent found with id=${agentId}.`,
          isError: true,
        });
      }

      return Promise.resolve({
        content: formatLifecycleResult('close_agent', [snapshot]),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  createSpawnAgentTool,
  createWaitAgentTool,
  createSendInputTool,
  createCloseAgentTool,
  formatSnapshot,
  formatLifecycleResult,
};
