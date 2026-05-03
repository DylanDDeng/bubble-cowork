import type { ContentBlock } from '../../../shared/types';
import { compactResidentHistory, projectMessages } from './context/projector';
import { isContextOverflowError } from './context/overflow';
import { filterToolsForSubtask, getSubtaskPolicy, type BuiltinSubtaskType } from './governance/subtask-policy';
import type {
  BuiltinAgentCallbacks,
  BuiltinChatMessage,
  BuiltinModelComplete,
  BuiltinModelTurn,
  BuiltinToolCall,
  BuiltinToolDefinition,
  BuiltinToolRegistryEntry,
  BuiltinToolResult,
} from './types';

const MAX_TURNS = 40;
const MAX_OVERFLOW_RECOVERIES = 3;

export interface AegisBuiltinAgentCoreOptions {
  cwd: string;
  tools: BuiltinToolRegistryEntry[];
  complete: BuiltinModelComplete;
  callbacks: BuiltinAgentCallbacks;
  signal: AbortSignal;
  getSystemPrompt: (input: { toolNames: string[] }) => string;
  getPermissionMode: () => 'default' | 'plan' | 'bypassPermissions';
  maxTurns?: number;
  initialMessages?: BuiltinChatMessage[];
}

export class AegisBuiltinAgentCore {
  private messages: BuiltinChatMessage[];
  private tools = new Map<string, BuiltinToolRegistryEntry>();
  private unlockedDeferred = new Set<string>();

  constructor(private readonly options: AegisBuiltinAgentCoreOptions) {
    this.messages = options.initialMessages ? [...options.initialMessages] : [];
    for (const tool of options.tools) {
      this.tools.set(tool.name, tool);
    }
    if (this.messages.length === 0 || this.messages[0].role !== 'system') {
      this.messages.unshift({ role: 'system', content: '' });
    }
    const deferredNames = this.listDeferredTools().map((tool) => tool.name);
    if (deferredNames.length > 0) {
      this.messages.push({
        role: 'user',
        content: [
          '<system-reminder>',
          `Deferred tools are available but their schemas are not loaded yet: ${deferredNames.join(', ')}.`,
          'Call tool_search with query "select:<name>" to load a deferred tool before calling it.',
          '</system-reminder>',
        ].join('\n'),
      });
    }
  }

  get history(): BuiltinChatMessage[] {
    return this.messages;
  }

  set history(messages: BuiltinChatMessage[]) {
    this.messages = messages;
  }

  listDeferredTools(): BuiltinToolRegistryEntry[] {
    return [...this.tools.values()].filter((tool) => tool.deferred);
  }

  unlockDeferredTools(names: string[]): void {
    for (const name of names) {
      if (this.tools.has(name)) {
        this.unlockedDeferred.add(name);
      }
    }
  }

  async runTurn(prompt: string): Promise<void> {
    this.messages.push({ role: 'user', content: prompt });
    let recoveries = 0;
    let turnCount = 0;

    while (!this.options.signal.aborted && turnCount < (this.options.maxTurns ?? MAX_TURNS)) {
      turnCount += 1;
      const effectiveTools = this.getEffectiveTools();
      this.messages[0] = {
        role: 'system',
        content: this.options.getSystemPrompt({ toolNames: effectiveTools.map((tool) => tool.name) }),
      };

      let modelTurn: BuiltinModelTurn;
      try {
        modelTurn = await this.options.complete({
          messages: projectMessages(this.messages),
          tools: effectiveTools.map(toToolDefinition),
          signal: this.options.signal,
          onText: this.options.callbacks.onText,
          onReasoning: this.options.callbacks.onReasoning,
        });
      } catch (error) {
        if (!isContextOverflowError(error) || recoveries >= MAX_OVERFLOW_RECOVERIES) {
          throw error;
        }
        recoveries += 1;
        this.messages = compactResidentHistory(this.messages, {
          maxChars: Math.max(80_000, 420_000 - recoveries * 100_000),
          keepRecentTurns: Math.max(1, 4 - recoveries),
        });
        continue;
      }

      recoveries = 0;
      this.options.callbacks.onStreamStop();

      if (modelTurn.toolCalls.length === 0) {
        this.messages.push({ role: 'assistant', content: modelTurn.content || '' });
        const blocks = buildAssistantBlocks(modelTurn);
        if (blocks.length > 0) {
          this.options.callbacks.onAssistantMessage(blocks);
        }
        this.messages = compactResidentHistory(this.messages);
        return;
      }

      this.messages.push({
        role: 'assistant',
        content: modelTurn.content || null,
        tool_calls: modelTurn.toolCalls,
      });
      this.options.callbacks.onAssistantMessage(buildAssistantToolBlocks(modelTurn));

      const toolByName = new Map(effectiveTools.map((tool) => [tool.name, tool]));
      for (const call of modelTurn.toolCalls) {
        const result = await this.executeTool(call, toolByName);
        this.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result.content,
        });
        this.options.callbacks.onToolResult(call.id, result.content, result.isError);
      }
      this.messages = compactResidentHistory(this.messages);
    }
  }

  async runSubtask(
    input: string,
    cwd: string,
    options?: { subtaskType?: string; description?: string }
  ): Promise<BuiltinToolResult> {
    const subtaskType = options?.subtaskType as BuiltinSubtaskType | undefined;
    const policy = getSubtaskPolicy(subtaskType);
    const tools = filterToolsForSubtask([...this.tools.values()], subtaskType);
    const output: string[] = [];
    const notes: string[] = [];
    const subAgent = new AegisBuiltinAgentCore({
      ...this.options,
      cwd,
      tools,
      maxTurns: policy.maxTurns,
      getPermissionMode: () => 'plan',
      callbacks: {
        onText: (text) => output.push(text),
        onReasoning: () => undefined,
        onStreamStop: () => undefined,
        onAssistantMessage: () => undefined,
        onToolResult: (_id, content) => {
          const firstLine = content.split('\n').find((line) => line.trim())?.trim();
          if (firstLine) notes.push(firstLine);
        },
      },
      initialMessages: [
        this.messages[0],
        {
          role: 'user',
          content: `<system-reminder>\n${policy.reminder}\n</system-reminder>`,
        },
      ],
    });
    await subAgent.runTurn(input);
    const lines: string[] = [`Subtask type: ${policy.type}`];
    if (options?.description) lines.push(`Subtask description: ${options.description}`);
    const summary = output.join('').trim();
    if (summary) lines.push('', 'Subtask summary:', summary);
    if (notes.length > 0) {
      lines.push('', 'Subtask tools:');
      for (const note of notes.slice(0, 8)) {
        lines.push(`- ${note}`);
      }
    }
    return {
      content: lines.join('\n'),
      status: policy.resultStatus,
      metadata: { kind: 'subagent', reason: `Subtask (${policy.type}) investigation completed.` },
    };
  }

  private getEffectiveTools(): BuiltinToolRegistryEntry[] {
    const planMode = this.options.getPermissionMode() === 'plan';
    return [...this.tools.values()].filter((tool) => {
      if (planMode && !tool.readOnly) return false;
      if (tool.deferred && !this.unlockedDeferred.has(tool.name)) return false;
      return true;
    });
  }

  private async executeTool(
    call: BuiltinToolCall,
    toolByName: Map<string, BuiltinToolRegistryEntry>
  ): Promise<BuiltinToolResult> {
    const tool = toolByName.get(call.function.name);
    if (!tool) {
      const knownTool = this.tools.get(call.function.name);
      if (knownTool && this.options.getPermissionMode() === 'plan' && !knownTool.readOnly) {
        return {
          content:
            `Error: Tool "${call.function.name}" is not allowed in read-only plan mode. ` +
            'Use read-only tools to investigate, then call exit_plan_mode with a concrete plan for user approval.',
          isError: true,
          status: 'blocked',
        };
      }
      const knownDeferred = this.tools.get(call.function.name);
      if (knownDeferred?.deferred && !this.unlockedDeferred.has(call.function.name)) {
        return {
          content: `Error: Tool "${call.function.name}" is deferred. Call tool_search with query "select:${call.function.name}" to load its schema, then retry.`,
          isError: true,
          status: 'blocked',
        };
      }
      return { content: `Error: unknown tool ${call.function.name}`, isError: true, status: 'command_error' };
    }
    const args = parseArgs(call.function.arguments);
    return tool.execute(args, {
      cwd: this.options.cwd,
      abortSignal: this.options.signal,
      toolCall: {
        id: call.id,
        name: call.function.name,
      },
      agent: {
        runSubtask: (input, cwd, options) => this.runSubtask(input, cwd, options),
      },
    });
  }
}

function toToolDefinition(tool: BuiltinToolRegistryEntry): BuiltinToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function buildAssistantBlocks(turn: BuiltinModelTurn): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (turn.reasoning.trim()) {
    blocks.push({ type: 'thinking', thinking: turn.reasoning.trimEnd() });
  }
  if (turn.content.trim()) {
    blocks.push({ type: 'text', text: turn.content.trimEnd() });
  }
  return blocks;
}

function buildAssistantToolBlocks(turn: BuiltinModelTurn): ContentBlock[] {
  const blocks = buildAssistantBlocks(turn);
  for (const call of turn.toolCalls) {
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: parseArgs(call.function.arguments),
    });
  }
  return blocks;
}
