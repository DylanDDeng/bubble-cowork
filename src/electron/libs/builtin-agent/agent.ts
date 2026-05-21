import type { ContentBlock } from '../../../shared/types';
import { compactResidentHistory, projectMessages } from './context/projector';
import { isContextOverflowError } from './context/overflow';
import {
  BuiltinExecutionGovernor,
  classifyBuiltinAgentTask,
  normalizeToolResultMetadata,
} from './governance/execution-governor';
import { filterToolsForSubtask, getSubtaskPolicy, type BuiltinSubtaskType } from './governance/subtask-policy';
import {
  type SubagentThreadRecord,
  type SubagentThreadSnapshot,
  type SpawnSubAgentParams,
  assignAgentNickname,
  isFinalSubagentStatus,
} from './governance/subagent-control';
import { buildSubagentLifecycleReminder } from './governance/subagent-lifecycle-reminder';
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

  /** Running and completed subagent threads, keyed by id. */
  private subagentThreads = new Map<string, SubagentThreadRecord>();

  /** Snapshots of completed subagents that the parent hasn't collected yet. */
  private pendingSubagentCompletions: SubagentThreadSnapshot[] = [];

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

    // Inject subagent lifecycle reminder so the parent agent is always aware of its children
    const subagentReminder = this.drainSubagentReminder();
    if (subagentReminder) {
      this.messages.push({ role: 'user', content: subagentReminder });
    }

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
        spawnSubAgent: (params) => this.spawnSubAgent(params),
        closeSubAgent: (agentId) => this.closeSubAgent(agentId),
        sendSubAgentInput: (agentId, message, interrupt) =>
          this.sendSubAgentInput(agentId, message, interrupt),
        waitForAgentStop: (agentId, timeoutMs) =>
          this.waitForAgentStop(agentId, timeoutMs),
        getSubagentSnapshots: () => this.getSubagentSnapshots(),
        activeSubagentNicknames: () => this.activeSubagentNicknames(),
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

  // -------------------------------------------------------------------------
  // Subagent lifecycle
  // -------------------------------------------------------------------------

  /**
   * Spawn an async subagent and return a snapshot immediately.
   * When blocking=true, waits for completion before returning.
   */
  async spawnSubAgent(params: SpawnSubAgentParams): Promise<SubagentThreadSnapshot> {
    const id = crypto.randomUUID();
    const nickname = assignAgentNickname(params.agentType, this.activeSubagentNicknames());

    const abortController = new AbortController();
    // Link child abort to parent signal
    this.options.signal.addEventListener('abort', () => {
      abortController.abort();
    });

    const record: SubagentThreadRecord = {
      id,
      parentToolCallId: params.toolCallId ?? '',
      nickname,
      task: params.message,
      profile: params.agentType,
      category: params.category,
      status: 'running',
      timeoutMs: params.timeoutMs,
      createdAt: Date.now(),
      abortController,
      asSnapshot(this: SubagentThreadRecord): SubagentThreadSnapshot {
        return {
          id: this.id,
          nickname: this.nickname,
          task: this.task,
          profile: this.profile,
          status: this.status,
          summary: this.summary,
          error: this.error,
          usage: this.usage,
          createdAt: this.createdAt,
          completedAt: this.completedAt,
        };
      },
    };

    this.subagentThreads.set(id, record);

    // Fire-and-forget the subagent thread
    const promise = this.runSubagentThread(record).finally(() => {
      // Move completed snapshot to pending collection for parent to pick up
      this.pendingSubagentCompletions.push(record.asSnapshot());
    });
    record._promise = promise;

    if (params.blocking) {
      await promise;
    }

    return record.asSnapshot();
  }

  /** Close (abort) a running subagent. */
  closeSubAgent(agentId: string): SubagentThreadSnapshot | null {
    const record = this.subagentThreads.get(agentId);
    if (!record) return null;

    if (record.status === 'running') {
      record.abortController.abort();
      record.status = 'closed';
      record.completedAt = Date.now();
      record.waiter?.();
    }
    return record.asSnapshot();
  }

  /**
   * Send a follow-up input to a subagent.
   * When interrupt=true the current run is cancelled and re-spawned with the new message.
   */
  sendSubAgentInput(
    agentId: string,
    message: string,
    interrupt?: boolean
  ): SubagentThreadSnapshot | null {
    const record = this.subagentThreads.get(agentId);
    if (!record) return null;

    if (interrupt && record.status === 'running') {
      record.abortController.abort();
      record.status = 'closed';
      record.completedAt = Date.now();
      record.waiter?.();
      this.subagentThreads.delete(agentId);

      // Re-spawn with the new message (fire-and-forget, tracked via subagentThreads)
      this.spawnSubAgent({
        agentType: record.profile,
        message,
        toolCallId: record.parentToolCallId,
        category: record.category,
      });
      // Return the old (now closed) record
      return record.asSnapshot();
    }

    // Non-interrupt path: wait for current run to finish, then spawn new one
    if (record.status === 'running') {
      // Queue the input for after completion — simplified: we'll just log status
      // In the current architecture subagents run to completion, so we
      // rely on the caller using interrupt:true for re-steering.
      return record.asSnapshot();
    }

    return record.asSnapshot();
  }

  /** Wait for one or all subagents to reach a final status. */
  async waitForAgentStop(
    agentId?: string,
    timeoutMs: number = 30000
  ): Promise<SubagentThreadSnapshot[]> {
    const start = Date.now();

    while (true) {
      // Collect current final snapshots
      const candidates: SubagentThreadSnapshot[] = [];

      if (agentId) {
        const record = this.subagentThreads.get(agentId);
        if (!record) return [];
        if (isFinalSubagentStatus(record.status)) {
          candidates.push(record.asSnapshot());
        }
      } else {
        for (const record of this.subagentThreads.values()) {
          if (isFinalSubagentStatus(record.status)) {
            candidates.push(record.asSnapshot());
          }
        }
      }

      if (candidates.length > 0) return candidates;

      if (Date.now() - start >= timeoutMs) {
        // Timeout — return all current snapshots
        if (agentId) {
          const rec = this.subagentThreads.get(agentId);
          return rec ? [rec.asSnapshot()] : [];
        }
        return [...this.subagentThreads.values()].map((r) => r.asSnapshot());
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  /** Snapshots of every tracked subagent. */
  getSubagentSnapshots(): SubagentThreadSnapshot[] {
    return [...this.subagentThreads.values()].map((r) => r.asSnapshot());
  }

  /** Nicknames of currently running subagents. */
  activeSubagentNicknames(): string[] {
    return [...this.subagentThreads.values()]
      .filter((r) => r.status === 'running')
      .map((r) => r.nickname);
  }

  /**
   * Run a subagent's turn loop in the background.
   * Creates a new agent-core instance with filtered tools and a subagent system prompt.
   */
  private async runSubagentThread(record: SubagentThreadRecord): Promise<void> {
    try {
      // Classify the subagent task for tool filtering
      const rawType = classifyBuiltinAgentTask(record.task);
      const subtaskType: BuiltinSubtaskType = mapTaskTypeToSubtaskType(rawType);

      const allTools = [...this.tools.values()];
      const filteredTools = filterToolsForSubtask(allTools, subtaskType, record.profile);

      if (filteredTools.length === 0) {
        record.status = 'failed';
        record.error = 'No tools available for subagent after filtering.';
        record.completedAt = Date.now();
        return;
      }

      // Create a sub-agent core with filtered tools
      const subAgent = new AegisBuiltinAgentCore({
        cwd: this.options.cwd,
        tools: filteredTools,
        complete: this.options.complete,
        callbacks: {
          onText: () => {},
          onReasoning: () => {},
          onAssistantMessage: () => {},
          onToolResult: (toolCallId, content, isError) => {
            // Forward tool results to parent so UI can show subagent progress
            this.options.callbacks.onToolResult?.(
              `subagent:${record.id}:${toolCallId}`,
              content,
              isError
            );
          },
          onStreamStop: () => {},
        },
        signal: record.abortController.signal,
        getSystemPrompt: (input: { toolNames: string[] }) => {
          const parentPrompt = this.options.getSystemPrompt(input);
          return `${parentPrompt}

<subagent-reminder>
You are a subagent named "${record.nickname}" (${record.profile}).
Work on the assigned task until it is complete, then return your final result.
Do not announce next steps or plans. Just do the work.
</subagent-reminder>`;
        },
        onToolMetadata: this.options.onToolMetadata,
        getPermissionMode: () => 'bypassPermissions',
      });

      // Run the subagent turn loop
      await subAgent.runTurn(record.task);

      // Extract the final assistant text as the summary
      const lastAssistantMsg = [...subAgent.history]
        .reverse()
        .find((m) => m.role === 'assistant');
      const lastContent = lastAssistantMsg?.content;
      record.summary = typeof lastContent === 'string' ? lastContent : '';

      if (record.abortController.signal.aborted) {
        record.status = 'cancelled';
      } else {
        record.status = 'completed';
      }
      record.completedAt = Date.now();
    } catch (err) {
      if (record.abortController.signal.aborted) {
        record.status = 'cancelled';
      } else {
        record.status = 'failed';
        record.error = err instanceof Error ? err.message : String(err);
      }
      record.completedAt = Date.now();
    } finally {
      record.waiter?.();
    }
  }

  /**
   * Drain completed subagent snapshots and build a system reminder.
   * Called at the start of each parent turn.
   */
  private drainSubagentReminder(): string {
    const completions = this.pendingSubagentCompletions.splice(0);
    // Merge completions into the snapshot list for the reminder
    const allSnapshots = [
      ...this.getSubagentSnapshots(),
      ...completions,
    ];
    return buildSubagentLifecycleReminder(allSnapshots);
  }
}

/** Map the broad BuiltinTaskType to the narrower BuiltinSubtaskType. */
function mapTaskTypeToSubtaskType(taskType: string): import('./governance/subtask-policy').BuiltinSubtaskType {
  const map: Record<string, import('./governance/subtask-policy').BuiltinSubtaskType> = {
    implementation: 'general_readonly',
    debugging: 'general_readonly',
    code_review: 'general_readonly',
    security_investigation: 'security_investigation',
    repo_orientation: 'general_readonly',
    product_discussion: 'general_readonly',
    general: 'general_readonly',
  };
  return map[taskType] ?? 'general_readonly';
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
