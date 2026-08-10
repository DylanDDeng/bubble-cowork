// In-process delegate MCP server for Claude leads (docs/delegate-mcp-plan.md).
//
// Claude runners get this injected via `createSdkMcpServer`, so the tool
// executes inside the Electron main process with the parent session id
// captured by closure — attribution is by construction, no HTTP round-trip.
// Follows the memory-mcp.ts dynamic-import pattern (CJS main, ESM SDK).

import {
  DELEGATE_MCP_SERVER_NAME,
  DELEGATE_TARGET_PROVIDERS,
  DELEGATE_TOOL_NAME,
  runDelegateTask,
} from './delegate-service';

type ClaudeAgentSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

let sdkModule: ClaudeAgentSdkModule | null = null;

async function loadSdk(): Promise<ClaudeAgentSdkModule> {
  if (!sdkModule) {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string
    ) => Promise<ClaudeAgentSdkModule>;
    sdkModule = await dynamicImport('@anthropic-ai/claude-agent-sdk');
  }
  return sdkModule;
}

type ZodModule = typeof import('zod');

let zodModule: ZodModule | null = null;

async function loadZod(): Promise<ZodModule> {
  if (!zodModule) {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string
    ) => Promise<ZodModule>;
    zodModule = await dynamicImport('zod');
  }
  return zodModule;
}

const DELEGATE_TOOL_DESCRIPTION = [
  'Delegate a self-contained task to a different coding agent and wait for its result.',
  'The delegated agent runs in this project with the same permission mode as the current session;',
  'its full trace is visible to the user in a side panel. Use for hand-offs the user asked for',
  '(e.g. "have codex review this") or when a second, independent perspective is genuinely useful.',
  'The call blocks until the delegated agent finishes and returns its final answer plus the list',
  'of files it changed. Delegated agents cannot delegate further.',
].join(' ');

export async function createDelegateMcpServer(parentSessionId: string) {
  const sdk = await loadSdk();
  const { z } = await loadZod();
  return sdk.createSdkMcpServer({
    name: DELEGATE_MCP_SERVER_NAME,
    version: '0.1.0',
    tools: [
      sdk.tool(
        DELEGATE_TOOL_NAME,
        DELEGATE_TOOL_DESCRIPTION,
        {
          agent: z
            .enum(DELEGATE_TARGET_PROVIDERS as [string, ...string[]])
            .describe('Which agent to delegate to.'),
          prompt: z
            .string()
            .describe(
              'Complete, self-contained instructions for the delegated agent. It sees none of this conversation — include all context it needs.'
            ),
          description: z
            .string()
            .optional()
            .describe('Short (3-6 word) task label shown to the user.'),
          model: z
            .string()
            .optional()
            .describe(
              "Model id for the delegated agent, in that agent's own naming (e.g. a codex or claude model id). Omit to use the agent's default."
            ),
          reasoning_effort: z
            .string()
            .optional()
            .describe(
              "Reasoning effort tier for the delegated agent (e.g. low/medium/high; the valid set is per agent/model). Omit to use the agent's default."
            ),
        },
        async ({ agent, prompt, description, model, reasoning_effort }) => {
          const result = await runDelegateTask({
            agent,
            prompt,
            description,
            model,
            reasoningEffort: reasoning_effort,
            callerSessionId: parentSessionId,
          });
          return {
            content: [{ type: 'text' as const, text: result.summary }],
            ...(result.ok ? {} : { isError: true }),
          };
        }
      ),
    ],
  });
}
