import type { ContentBlock } from '../../../shared/types';
import { compactResidentHistory, projectMessages } from './context/projector';
import { isContextOverflowError } from './context/overflow';
import {
  BuiltinExecutionGovernor,
  classifyBuiltinAgentTask,
  normalizeToolResultMetadata,
} from './governance/execution-governor';
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

const MAX_OVERFLOW_RECOVERIES = 3;

export interface AegisBuiltinAgentCoreOptions {
  cwd: string;
  tools: BuiltinToolRegistryEntry[];
  complete: BuiltinModelComplete;
  callbacks: BuiltinAgentCallbacks;
  signal: AbortSignal;
  getSystemPrompt: (input: { toolNames: string[] }) => string;
  getTransientMessages?: () => BuiltinChatMessage[];
  onToolMetadata?: (metadata: BuiltinToolResult['metadata'] | undefined) => void;
  getPermissionMode: () => 'default' | 'plan' | 'bypassPermissions';
  /**
   * Optional guard for constrained child tasks. The main built-in agent leaves
   * this unset so completion is driven by the model returning no tool calls.
   */
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
    const governor = new BuiltinExecutionGovernor(classifyBuiltinAgentTask(prompt));
    let recoveries = 0;
    let turnCount = 0;

    while (!this.options.signal.aborted) {
      turnCount += 1;
      const effectiveTools = governor.filterToolDefinitions(this.getEffectiveTools());
      this.messages[0] = {
        role: 'system',
        content: this.options.getSystemPrompt({ toolNames: effectiveTools.map((tool) => tool.name) }),
      };

      let modelTurn: BuiltinModelTurn;
      try {
        const projectedMessages = insertTransientMessages(
          projectMessages(this.messages),
          [
            ...(this.options.getTransientMessages?.() || []),
            ...governor.consumePendingReminders().map(toSystemReminderMessage),
          ]
        );
        modelTurn = await this.options.complete({
          messages: projectedMessages,
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
        this.messages.push({
          role: 'assistant',
          content: modelTurn.content || '',
          reasoning_content: modelTurn.reasoning,
        });
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
        reasoning_content: modelTurn.reasoning,
      });
      this.options.callbacks.onAssistantMessage(buildAssistantToolBlocks(modelTurn));

      const toolByName = new Map(effectiveTools.map((tool) => [tool.name, tool]));
      const hasDelegateCalls = modelTurn.toolCalls.some((call) => call.function.name === 'delegate');
      const toolResults = hasDelegateCalls
        ? await Promise.all(
            modelTurn.toolCalls.map(async (call) => {
              if (call.function.name !== 'delegate') {
                return {
                  call,
                  result: {
                    content:
                      'Skipped: delegate calls hard-return this leader turn. Resume after delegated members finish, then decide any next tools.',
                    isError: true,
                    status: 'blocked' as const,
                    metadata: { kind: 'delegate' as const, reason: 'delegate_hard_return' },
                  },
                };
              }
              return { call, result: await this.executeTool(call, toolByName, governor) };
            })
          )
        : [];

      if (hasDelegateCalls) {
        for (const { call, result } of toolResults) {
          this.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: result.content,
          });
          this.options.callbacks.onToolResult(call.id, result.content, result.isError, result.metadata);
        }
      }

      if (!hasDelegateCalls) {
        for (const call of modelTurn.toolCalls) {
          const result = await this.executeTool(call, toolByName, governor);
          this.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: result.content,
          });
          this.options.callbacks.onToolResult(call.id, result.content, result.isError, result.metadata);
        }
      }
      this.messages = compactResidentHistory(this.messages);

      if (this.options.maxTurns !== undefined && turnCount >= this.options.maxTurns) {
        throw new Error(
          `Aegis Built-in Agent child task reached its ${this.options.maxTurns}-turn guard without a final response.`
        );
      }
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
    let subtaskError: string | null = null;
    try {
      await subAgent.runTurn(input);
    } catch (error) {
      subtaskError = error instanceof Error ? error.message : String(error);
    }
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
    if (subtaskError) {
      lines.push('', 'Subtask stopped:', subtaskError);
    }
    return {
      content: lines.join('\n'),
      isError: Boolean(subtaskError),
      status: subtaskError ? 'timeout' : policy.resultStatus,
      metadata: {
        kind: 'subagent',
        reason: subtaskError
          ? `Subtask (${policy.type}) stopped before a final response.`
          : `Subtask (${policy.type}) investigation completed.`,
      },
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
    toolByName: Map<string, BuiltinToolRegistryEntry>,
    governor?: BuiltinExecutionGovernor
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
    if (call.argsCorrupt) {
      return {
        content:
          `Error: The arguments for "${call.function.name}" failed to parse as JSON, indicating the tool call was truncated or malformed mid-stream. ` +
          'Re-issue the call with valid JSON arguments; do not assume the previous attempt ran.',
        isError: true,
        status: 'blocked',
        metadata: { kind: 'security', reason: 'args_corrupt' },
      };
    }
    const parsedArgs = parseArgs(call.function.arguments);
    if (parsedArgs.corrupt) {
      return {
        content:
          `Error: Tool "${call.function.name}" was called with malformed JSON arguments. ` +
          'Re-issue the call with valid JSON arguments; do not assume the previous attempt ran.',
        isError: true,
        status: 'blocked',
        metadata: { kind: 'security', reason: 'args_corrupt' },
      };
    }
    const missingRequired = findMissingRequiredArgs(tool.parameters, parsedArgs.args);
    if (missingRequired.length > 0) {
      return {
        content:
          `Error: Tool "${call.function.name}" was called without required argument${missingRequired.length === 1 ? '' : 's'}: ` +
          `${missingRequired.map((name) => `"${name}"`).join(', ')}. Re-issue the call with all required fields filled. ` +
          'Do not assume the previous attempt ran with default values.',
        isError: true,
        status: 'blocked',
        metadata: { kind: 'security', reason: 'missing_required_args', missing: missingRequired },
      };
    }
    const governorDecision = governor?.beforeToolCall(call.function.name, parsedArgs.args);
    if (governorDecision?.blockedResult) {
      return governorDecision.blockedResult;
    }
    const rawResult = await tool.execute(parsedArgs.args, {
      cwd: this.options.cwd,
      abortSignal: this.options.signal,
      toolCall: {
        id: call.id,
        name: call.function.name,
      },
      agent: {
        runSubtask: (input, cwd, options) => this.runSubtask(input, cwd, options),
        runDelegate: (delegateCall) => this.runDelegate(delegateCall),
      },
    });
    const result = normalizeToolResultMetadata(call.function.name, parsedArgs.args, rawResult);
    governor?.afterToolResult(call.function.name, parsedArgs.args, result);
    this.options.onToolMetadata?.(result.metadata);
    return result;
  }

  private async runDelegate(call: import('../../../shared/types').DelegateCall) {
    const delegateRunner = this.options.callbacks.onDelegate;
    if (!delegateRunner) {
      return {
        delegateCallId: call.id,
        agentId: call.agentId,
        status: 'error' as const,
        errorKind: 'api_error' as const,
        summary: 'Delegate runtime is not available for this session.',
        rawRef: call.id,
      };
    }
    return delegateRunner(call);
  }
}

function insertTransientMessages(
  messages: BuiltinChatMessage[],
  transient: BuiltinChatMessage[]
): BuiltinChatMessage[] {
  if (transient.length === 0) return messages;
  const systemIndex = messages.findIndex((message) => message.role === 'system');
  if (systemIndex === -1) {
    return [...transient, ...messages];
  }
  return [
    ...messages.slice(0, systemIndex + 1),
    ...transient,
    ...messages.slice(systemIndex + 1),
  ];
}

function toSystemReminderMessage(content: string): BuiltinChatMessage {
  return { role: 'user', content };
}

function toToolDefinition(tool: BuiltinToolRegistryEntry): BuiltinToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

function parseArgs(raw: string): { args: Record<string, unknown>; corrupt: boolean } {
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    return { args: {}, corrupt: false };
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown>, corrupt: false };
    }
    return { args: {}, corrupt: true };
  } catch {
    return { args: {}, corrupt: true };
  }
}

function findMissingRequiredArgs(
  schema: Record<string, unknown> | undefined,
  args: Record<string, unknown>
): string[] {
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : [];
  return required.filter((name) => args[name] === undefined || args[name] === null);
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
      input: parseArgs(call.function.arguments).args,
    });
  }
  return blocks;
}
