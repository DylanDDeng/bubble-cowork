import type {
  McpServerConfig as SDKMcpServerConfig,
  PermissionMode as ClaudeSdkPermissionMode,
  Query as ClaudeQuery,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { readFile } from 'fs/promises';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { Base64ImageSource, ContentBlockParam } from '@anthropic-ai/sdk/resources/messages';
import type { RunnerOptions, RunnerHandle, StreamMessage, PermissionResult, Attachment } from '../types';
import type {
  ClaudeAccessMode,
  ClaudeExecutionMode,
  ClaudeModelUsage,
  ClaudeReasoningEffort,
} from '../../shared/types';
import { getClaudeEnv, getMcpServers, sanitizeOfficialClaudeEnv } from './claude-settings';
import { applyCompatibleProviderEnv } from './compatible-provider-config';
import {
  reconcileClaudeDisplayModel,
  toClaudeCodeRuntimeModel,
} from './claude-model-selection';
import { getRequiredClaudeCodeRuntime } from './claude-runtime';
import { createAegisMemoryMcpServer, buildMemoryContext, MEMORY_SYSTEM_PROMPT } from './memory-mcp';
import { shouldExtractMemory, hasMemoryWritesInTurn, extractMemories } from './memory-extractor';
import {
  AEGIS_BLOCKED_BROWSER_OPEN_MESSAGE,
  shouldBlockSystemBrowserPreviewOpen,
} from './browser-preview-policy';

type ClaudeSettingSource = 'user' | 'project' | 'local';
const CLAUDE_SETTING_SOURCES: ClaudeSettingSource[] = ['user', 'project', 'local'];
const OFFICIAL_CLAUDE_SETTING_SOURCES: ClaudeSettingSource[] = ['user', 'project', 'local'];
const ENABLE_AEGIS_MEMORY_FOR_NATIVE_PROVIDERS = false;

// Persistent store for memory extraction messages (survives across runClaude calls)
const _memoryMessageStore = new Map<string, Array<{ role: string; content: string }>>();

// MCP 服务器状态
interface McpServerStatus {
  name: string;
  status: 'connected' | 'failed' | 'pending';
  error?: string;
  tool?: 'claude' | 'codex' | 'opencode' | 'kimi' | 'grok' | 'pi';
}

// SDK 消息类型定义
interface SDKMessage {
  type: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  message?: {
    content: ContentBlock[];
  };
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    costUSD?: number;
    contextWindow?: number;
    maxOutputTokens?: number;
    webSearchRequests?: number;
  }>;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  tools?: string[];
  slash_commands?: string[];
  skills?: string[];
  mcp_servers?: McpServerStatus[];
  compact_metadata?: {
    trigger?: 'manual' | 'auto';
    pre_tokens?: number;
  };
  result?: string;
  event?: {
    type?: string;
    index?: number;
    delta?: {
      type?: string;
      text?: string;
      thinking?: string;
      signature?: string;
    };
  };
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
  signature?: string;
  durationMs?: number;
}

type StreamEventType =
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop';

const DEFAULT_MAX_THINKING_TOKENS = 64000;
const DEFAULT_CLAUDE_REASONING_EFFORT: ClaudeReasoningEffort = 'high';
type ClaudeAgentSdkModule = typeof import('@anthropic-ai/claude-agent-sdk');

const CLAUDE_PERMISSIONED_TOOLS = new Set([
  'Bash',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Delete',
]);
const CLAUDE_EDIT_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);
const CLAUDE_FILE_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Read',
]);

function normalizeClaudeSdkPermissionMode(
  accessMode?: ClaudeAccessMode,
  executionMode?: ClaudeExecutionMode
): ClaudeSdkPermissionMode {
  if (executionMode === 'plan') {
    return 'plan';
  }
  switch (accessMode) {
    case 'fullAccess':
    case 'bypassPermissions':
      return 'bypassPermissions';
    case 'acceptEdits':
    case 'plan':
    case 'dontAsk':
    case 'auto':
      return accessMode;
    default:
      return 'default';
  }
}

function executionModeForClaudePermissionMode(
  permissionMode: ClaudeSdkPermissionMode
): ClaudeExecutionMode {
  return permissionMode === 'plan' ? 'plan' : 'execute';
}

function shouldPromptForClaudeTool(
  toolName: string,
  permissionMode: ClaudeSdkPermissionMode
): boolean {
  if (!CLAUDE_PERMISSIONED_TOOLS.has(toolName)) {
    return false;
  }
  if (permissionMode === 'default') {
    return true;
  }
  if (permissionMode === 'acceptEdits') {
    return !CLAUDE_EDIT_TOOLS.has(toolName);
  }
  return false;
}

function shouldDenyClaudeToolWithoutPrompt(
  toolName: string,
  permissionMode: ClaudeSdkPermissionMode
): boolean {
  return permissionMode === 'dontAsk' && CLAUDE_PERMISSIONED_TOOLS.has(toolName);
}

function buildClaudeToolApprovalKey(toolName: string, input: Record<string, unknown>): string {
  const command = typeof input.command === 'string' ? input.command : '';
  const filePath = typeof input.file_path === 'string' ? input.file_path : '';
  return `${toolName}:${command || filePath || '*'}`;
}

function buildClaudeToolApprovalInput(
  toolName: string,
  input: Record<string, unknown>,
  cwd?: string | null
): Record<string, unknown> {
  const command = typeof input.command === 'string' ? input.command : null;
  const filePath = typeof input.file_path === 'string' ? input.file_path : null;
  const approvalKind = toolName === 'Bash'
    ? 'command'
    : filePath
      ? 'file-change'
      : 'tool';
  return {
    kind: 'codex-approval',
    approvalKind,
    method: 'claude.canUseTool',
    question: command
      ? `Allow Claude to run this command?`
      : filePath
        ? `Allow Claude to use ${toolName} on this file?`
        : `Allow Claude to use ${toolName}?`,
    title: `Claude ${toolName} approval`,
    toolName,
    command,
    cwd: cwd || null,
    filePath,
    canAllowForSession: true,
  };
}

async function loadClaudeAgentSdk(): Promise<ClaudeAgentSdkModule> {
  const dynamicImport = new Function(
    'specifier',
    'return import(specifier);'
  ) as (specifier: string) => Promise<ClaudeAgentSdkModule>;
  return dynamicImport('@anthropic-ai/claude-agent-sdk');
}

function resolveMaxThinkingTokens(): number {
  const raw = process.env.CLAUDE_CODE_MAX_THINKING_TOKENS;
  if (!raw) {
    return DEFAULT_MAX_THINKING_TOKENS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_THINKING_TOKENS;
  }
  return Math.floor(parsed);
}

function resolveExplicitMaxThinkingTokens(): number | null {
  const raw = process.env.CLAUDE_CODE_MAX_THINKING_TOKENS;
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.floor(parsed);
}

function normalizeClaudeReasoningEffort(
  value?: string | null
): ClaudeReasoningEffort {
  switch ((value || '').trim().toLowerCase()) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return value!.trim().toLowerCase() as ClaudeReasoningEffort;
    default:
      return DEFAULT_CLAUDE_REASONING_EFFORT;
  }
}

function buildClaudeThinkingOptions(params: {
  effort?: ClaudeReasoningEffort;
  compatibleProviderMatched: boolean;
}): {
  queryOptions: {
    thinking?: { type: 'adaptive' | 'enabled'; budgetTokens?: number; display?: 'summarized' };
    effort?: ClaudeReasoningEffort;
    maxThinkingTokens?: number;
  };
  legacyMaxThinkingTokens?: number;
} {
  if (params.compatibleProviderMatched) {
    const legacyMaxThinkingTokens = resolveMaxThinkingTokens();
    return {
      queryOptions: { maxThinkingTokens: legacyMaxThinkingTokens },
      legacyMaxThinkingTokens,
    };
  }

  const explicitMaxThinkingTokens = resolveExplicitMaxThinkingTokens();
  if (explicitMaxThinkingTokens) {
    return {
      queryOptions: {
        thinking: {
          type: 'enabled',
          budgetTokens: explicitMaxThinkingTokens,
          display: 'summarized',
        },
      },
    };
  }

  return {
    queryOptions: {
      thinking: { type: 'adaptive', display: 'summarized' },
      effort: normalizeClaudeReasoningEffort(params.effort),
    },
  };
}

function normalizeToolFilePath(cwd: string, filePath: string): { resolved: string; isWithin: boolean } | null {
  const raw = filePath.trim();
  if (!raw) {
    return null;
  }

  let expanded = raw;
  if (raw.startsWith('~/')) {
    const home = process.env.HOME;
    if (home) {
      expanded = path.join(home, raw.slice(2));
    }
  }

  const resolvedPath = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(cwd, expanded);
  const resolvedCwd = path.resolve(cwd);
  const isWithin =
    resolvedPath === resolvedCwd || resolvedPath.startsWith(`${resolvedCwd}${path.sep}`);

  return { resolved: resolvedPath, isWithin };
}

function isStreamEventType(value: string): value is StreamEventType {
  return (
    value === 'content_block_start' ||
    value === 'content_block_delta' ||
    value === 'content_block_stop'
  );
}

function normalizeModelUsage(
  modelUsage?: SDKMessage['modelUsage']
): Record<string, ClaudeModelUsage> | undefined {
  if (!modelUsage) {
    return undefined;
  }

  const entries = Object.entries(modelUsage);
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    entries.map(([model, usage]) => [
      model,
      {
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        cacheReadInputTokens: usage.cacheReadInputTokens || 0,
        cacheCreationInputTokens: usage.cacheCreationInputTokens || 0,
        costUSD: usage.costUSD || 0,
        contextWindow: usage.contextWindow || 0,
        maxOutputTokens: usage.maxOutputTokens || 0,
        webSearchRequests: usage.webSearchRequests || 0,
      },
    ])
  );
}

class AsyncMessageQueue<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private readonly resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) {
      return;
    }

    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
      return;
    }

    this.queue.push(value);
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      if (resolver) {
        resolver({ value: undefined as unknown as T, done: true });
      }
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          const value = this.queue.shift() as T;
          return Promise.resolve({ value, done: false });
        }

        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }

        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

async function buildUserMessage(
  prompt: string,
  sessionId: string,
  attachments?: Attachment[]
): Promise<SDKUserMessage> {
  const allAttachments = attachments?.filter((a) => a && a.path) || [];
  const textLines = prompt ? [prompt] : [];
  if (allAttachments.length > 0) {
    if (textLines.length > 0) {
      textLines.push('');
    }
    textLines.push('Attachments:', ...allAttachments.map((a) => `- ${a.name}: ${a.path}`));
  }

  const content: ContentBlockParam[] = [
    {
      type: 'text',
      text: textLines.join('\n'),
    },
  ];

  const imageAttachments = allAttachments.filter((a) => a.kind === 'image');
  for (const image of imageAttachments) {
    try {
      const buffer = await readFile(image.path);
      const mediaType: Base64ImageSource['media_type'] =
        image.mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: buffer.toString('base64'),
        },
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error('Failed to read image attachment:', image.path, reason);
      throw new Error(`Failed to prepare image attachment "${image.name}": ${reason}`);
    }
  }

  return {
    type: 'user',
    // Mint the message uuid host-side: the CLI adopts it as the transcript id,
    // which is the anchor /rewind (Query.rewindFiles + history truncation)
    // needs. Streaming-input prompts are never echoed back by the SDK, so
    // without this the host would have no way to reference the message.
    uuid: uuidv4() as SDKUserMessage['uuid'],
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: 'user', content },
  };
}

// 运行 Claude Agent
export function runClaude(options: RunnerOptions): RunnerHandle {
  const {
    prompt,
    attachments,
    session,
    resumeSessionId,
    model,
    compatibleProviderId,
    betas,
    claudeAccessMode,
    claudeExecutionMode,
    claudeReasoningEffort,
    onMessage,
    onPermissionRequest,
    onClaudeExecutionModeChange,
    onError,
  } = options;

  const abortController = new AbortController();
  const inputQueue = new AsyncMessageQueue<SDKUserMessage>();
  let currentSessionId = resumeSessionId || '';
  let enqueueChain: Promise<void> = Promise.resolve();
  let currentModel = typeof model === 'string' && model.trim().length > 0 ? model.trim() : undefined;
  let currentRuntimeModel = toClaudeCodeRuntimeModel(currentModel, betas);
  let compatibleProviderMatched = false;
  let activeQuery: ClaudeQuery | null = null;
  const sessionApprovedExternalAccess = new Set<string>();
  const sessionApprovedToolAccess = new Set<string>();
  let currentPermissionMode: ClaudeSdkPermissionMode = normalizeClaudeSdkPermissionMode(
    claudeAccessMode,
    claudeExecutionMode
  );

  const updatePermissionMode = async (
    nextMode: ClaudeSdkPermissionMode
  ): Promise<void> => {
    if (currentPermissionMode === nextMode) {
      return;
    }
    if (activeQuery) {
      await activeQuery.setPermissionMode(nextMode);
    }
    currentPermissionMode = nextMode;
    onClaudeExecutionModeChange?.(executionModeForClaudePermissionMode(nextMode), nextMode);
  };

  // Prompt sequencing for stop cancellation: preparing a prompt is async
  // (image attachments are read from disk), so the user can press stop while
  // a send is still ahead of the input queue. cancelPendingPrompts() marks
  // every enqueue issued so far as cancelled; the enqueue re-checks the mark
  // around its awaits so a cancelled prompt is never pushed to the CLI.
  let promptSeq = 0;
  let settledPromptSeq = 0;
  let cancelledPromptSeq = 0;

  const enqueuePrompt = (text: string, promptAttachments?: Attachment[], requestedModel?: string) => {
    const trimmed = text.trim();
    const hasAttachments = (promptAttachments?.filter((a) => a && a.path).length || 0) > 0;
    if (!trimmed && !hasAttachments) {
      return;
    }

    const normalizedModel =
      typeof requestedModel === 'string' && requestedModel.trim().length > 0
        ? requestedModel.trim()
        : undefined;

    const seq = ++promptSeq;
    enqueueChain = enqueueChain
      .then(async () => {
        if (abortController.signal.aborted || seq <= cancelledPromptSeq) {
          return;
        }
        if (activeQuery && normalizedModel !== currentModel) {
          const nextRuntimeModel = compatibleProviderMatched
            ? currentRuntimeModel
            : toClaudeCodeRuntimeModel(normalizedModel, betas);
          // Only touch the live query when the RESOLVED runtime model actually
          // changes — a display-model spelling (e.g. the reconciled name the
          // init handler stores) must not trigger a spurious switch on reuse.
          if (nextRuntimeModel !== currentRuntimeModel) {
            await activeQuery.setModel(nextRuntimeModel);
          }
          currentModel = normalizedModel;
          currentRuntimeModel = nextRuntimeModel;
        }
        const message = await buildUserMessage(trimmed, currentSessionId, promptAttachments);
        if (abortController.signal.aborted || seq <= cancelledPromptSeq) {
          return;
        }
        inputQueue.push(message);

        // The SDK does not echo streaming-input user prompts back on the
        // message stream, so emit the echo ourselves. Persisting it (keyed by
        // the minted uuid) is what lets /rewind anchor to this prompt later —
        // resume replays emit the same shape, so downstream handling is shared.
        onMessage?.({
          type: 'user',
          uuid: message.uuid as string,
          message: { content: [{ type: 'text', text: trimmed }] },
        } as StreamMessage);

        // Record the actual user prompt text here. Claude "user" stream events can
        // also represent tool results, so the stream alone is not a reliable source
        // for turn-level memory extraction history.
        const sessionKey = session.id || currentSessionId || 'default';
        if (!_memoryMessageStore.has(sessionKey)) {
          _memoryMessageStore.set(sessionKey, []);
        }
        const recentMessages = _memoryMessageStore.get(sessionKey)!;
        if (trimmed) {
          recentMessages.push({ role: 'user', content: trimmed });
          while (recentMessages.length > 10) recentMessages.shift();
        }
      })
      .catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        onError?.(err);
      })
      .finally(() => {
        // The enqueue settled (pushed, cancelled, aborted, or failed) — it is
        // no longer "pending" for cancelPendingPrompts accounting.
        settledPromptSeq = seq;
      });
  };

  // The runtime won't emit init until it has an initial prompt to process.
  // Queue the first prompt immediately so the session can start.
  enqueuePrompt(prompt, attachments, currentModel);

  // 异步执行
  (async () => {
    try {
      const sdk = await loadClaudeAgentSdk();
      let env = {
        ...process.env,
        ...getClaudeEnv(),
      };
      const providerOverride = applyCompatibleProviderEnv(
        env,
        currentModel,
        compatibleProviderId || session.compatible_provider_id || null
      );
      env = providerOverride.matchedProviderId
        ? providerOverride.env
        : sanitizeOfficialClaudeEnv(providerOverride.env);
      compatibleProviderMatched = Boolean(providerOverride.matchedProviderId);
      currentModel = providerOverride.forcedModel || currentModel;
      currentRuntimeModel = compatibleProviderMatched
        ? currentModel
        : toClaudeCodeRuntimeModel(currentModel, betas);
      const { executable, executableArgs, env: runtimeEnv, pathToClaudeCodeExecutable } = getRequiredClaudeCodeRuntime();
      Object.assign(env, runtimeEnv);

      // 调试日志
      console.log('[Runner Debug]', {
        executable,
        executableArgs,
        pathToClaudeCodeExecutable,
        hasApiKey: !!env.ANTHROPIC_API_KEY,
        apiKeyPrefix: env.ANTHROPIC_API_KEY?.substring(0, 10),
        hasAuthToken: !!env.ANTHROPIC_AUTH_TOKEN,
        baseUrl: env.ANTHROPIC_BASE_URL,
        compatibleProvider: providerOverride.matchedProviderId || null,
        requestedModel: currentModel,
        runtimeModel: currentRuntimeModel,
        cwd: session.cwd || process.cwd(),
        PATH: env.PATH?.split(':').slice(0, 5),
        isPackaged: !process.defaultApp,
        resourcesPath: process.resourcesPath,
      });

      const thinkingOptions = buildClaudeThinkingOptions({
        effort: claudeReasoningEffort,
        compatibleProviderMatched,
      });

      const sessionCwd = session.cwd || process.cwd();
      const memoryAppend = ENABLE_AEGIS_MEMORY_FOR_NATIVE_PROVIDERS
        ? [await buildMemoryContext(session.cwd ?? undefined), MEMORY_SYSTEM_PROMPT].filter(Boolean).join('\n\n')
        : '';
      const providerMcpServers = getMcpServers(session.cwd ?? undefined);
      const mcpServers = ENABLE_AEGIS_MEMORY_FOR_NATIVE_PROVIDERS
        ? {
            ...providerMcpServers,
            'aegis-memory': await createAegisMemoryMcpServer(session.cwd ?? undefined),
          }
        : providerMcpServers;

      const result = sdk.query({
        prompt: inputQueue,
        options: {
          systemPrompt: memoryAppend
            ? { type: 'preset', preset: 'claude_code', append: memoryAppend }
            : { type: 'preset', preset: 'claude_code' },
          cwd: sessionCwd,
          resume: resumeSessionId,
          abortController,
          includePartialMessages: true,
          // Without this the SDK only forwards subagent tool_use/tool_result
          // blocks; text and thinking stay inside the subagent. The nested
          // Task traces / parallel board render the full subagent transcript,
          // so ask for it explicitly. SDK limitation: once a Task backgrounds
          // itself, the CLI stops forwarding its messages entirely — traces
          // for backgrounded subagents freeze at that point.
          forwardSubagentText: true,
          // Snapshot files before edits so /rewind can restore them to their
          // state at any user message via RunnerHandle.rewindFiles.
          enableFileCheckpointing: true,
          ...thinkingOptions.queryOptions,
          betas: betas as Array<'context-1m-2025-08-07'> | undefined,
          permissionMode: currentPermissionMode,
          allowDangerouslySkipPermissions: currentPermissionMode === 'bypassPermissions',
          env,
          model: currentRuntimeModel,
          settings: currentRuntimeModel ? { model: currentRuntimeModel } : undefined,
          executable: executable as unknown as 'node',
          executableArgs,
          pathToClaudeCodeExecutable,
          settingSources: compatibleProviderMatched
            ? CLAUDE_SETTING_SOURCES
            : OFFICIAL_CLAUDE_SETTING_SOURCES,
          mcpServers: mcpServers as Record<string, SDKMcpServerConfig>,
          // 自定义工具权限处理
          canUseTool: async (toolName: string, input: Record<string, unknown>) => {
            const memoryTools = ['remember_search', 'remember_get', 'remember_write', 'remember_recent'];
            const isMemoryTool = memoryTools.some(t => toolName === t || toolName.endsWith(`__${t}`));

            if (toolName === 'ExitPlanMode') {
              const approvalToolUseId = uuidv4();
              const result = await onPermissionRequest(approvalToolUseId, 'ExitPlanMode', {
                questions: [
                  {
                    header: 'Plan approval',
                    question: 'Approve this plan and let Claude start implementing it?',
                    options: [
                      {
                        label: 'Approve and execute',
                        description: 'Exit plan mode and continue with implementation.',
                      },
                      {
                        label: 'Stay in plan mode',
                        description: 'Keep planning without executing tools yet.',
                      },
                    ],
                  },
                ],
              });

              if (result.behavior !== 'allow') {
                return {
                  behavior: 'deny' as const,
                  message: result.message || 'Plan approval was denied.',
                };
              }

              const selectedAnswer =
                typeof result.updatedInput?.answers === 'object' && result.updatedInput?.answers
                  ? Object.values(result.updatedInput.answers as Record<string, unknown>).find(
                      (value): value is string => typeof value === 'string' && value.trim().length > 0
                    ) || ''
                  : '';

              if (selectedAnswer !== 'Approve and execute') {
                return {
                  behavior: 'deny' as const,
                  message: 'User chose to stay in plan mode.',
                };
              }

              const nextAccessMode = claudeAccessMode === 'plan' ? 'default' : claudeAccessMode;
              const nextMode = normalizeClaudeSdkPermissionMode(nextAccessMode, 'execute');
              await updatePermissionMode(nextMode);
              return {
                behavior: 'allow' as const,
                updatedInput: input,
              };
            }

            if (
              currentPermissionMode === 'plan' &&
              (
                CLAUDE_PERMISSIONED_TOOLS.has(toolName) ||
                (
                  ENABLE_AEGIS_MEMORY_FOR_NATIVE_PROVIDERS &&
                  (toolName === 'remember_write' || toolName.endsWith('__remember_write'))
                )
              )
            ) {
              return {
                behavior: 'deny' as const,
                message: 'This session is in plan mode, so Claude cannot execute edits or commands.',
              };
            }

            if (ENABLE_AEGIS_MEMORY_FOR_NATIVE_PROVIDERS && isMemoryTool) {
              return { behavior: 'allow' as const, updatedInput: input };
            }

            if (toolName === 'Bash') {
              const command = input.command as string | undefined;
              if (command && shouldBlockSystemBrowserPreviewOpen(command)) {
                return {
                  behavior: 'deny' as const,
                  message: AEGIS_BLOCKED_BROWSER_OPEN_MESSAGE,
                };
              }
            }

            const isFullAccess = currentPermissionMode === 'bypassPermissions';
            let updatedInput = input;
            if (session.cwd) {
              // 文件操作工具的路径修正
              if (CLAUDE_FILE_TOOLS.has(toolName)) {
                const filePath = updatedInput.file_path as string | undefined;
                if (filePath) {
                  const normalized = normalizeToolFilePath(session.cwd, filePath);
                  if (normalized && !normalized.isWithin) {
                    if (isFullAccess) {
                      return {
                        behavior: 'allow' as const,
                        updatedInput: { ...updatedInput, file_path: normalized.resolved },
                      };
                    }

                    const accessKey = `${toolName}:${normalized.resolved}`;
                    if (sessionApprovedExternalAccess.has(accessKey)) {
                      return {
                        behavior: 'allow' as const,
                        updatedInput: { ...updatedInput, file_path: normalized.resolved },
                      };
                    }

                    if (currentPermissionMode === 'dontAsk') {
                      return {
                        behavior: 'deny' as const,
                        message: `${toolName} requested an external file, and this session is in Don't Ask mode.`,
                      };
                    }

                    const toolUseId = uuidv4();
                    const permResult = await onPermissionRequest(toolUseId, toolName, {
                      kind: 'external-file-access',
                      question: `${toolName} this external file?`,
                      filePath: normalized.resolved,
                      cwd: session.cwd,
                      toolName,
                    });

                    if (permResult.behavior === 'allow') {
                      if (permResult.scope === 'session') {
                        sessionApprovedExternalAccess.add(accessKey);
                      }
                      return {
                        behavior: 'allow' as const,
                        updatedInput: { ...updatedInput, file_path: normalized.resolved },
                      };
                    }

                    return {
                      behavior: 'deny' as const,
                      message: permResult.message || `File path must be inside the working directory: ${session.cwd}`,
                    };
                  }
                  if (normalized && normalized.resolved !== filePath) {
                    console.log(`[CWD Fix] ${toolName}: ${filePath} -> ${normalized.resolved}`);
                    updatedInput = { ...updatedInput, file_path: normalized.resolved };
                  }
                }
              }

              // Bash 命令前置 cd
              if (toolName === 'Bash') {
                const command = updatedInput.command as string | undefined;
                if (command) {
                  const cdPrefix = `cd "${session.cwd}" && `;
                  if (!command.startsWith(cdPrefix) && !command.startsWith('cd ')) {
                    console.log(`[CWD Fix] Bash: prepending cd to command`);
                    updatedInput = { ...updatedInput, command: cdPrefix + command };
                  }
                }
              }
            }

            // AskUserQuestion 用户交互处理
            if (toolName === 'AskUserQuestion') {
              const toolUseId = uuidv4();
              const permResult = await onPermissionRequest(toolUseId, toolName, updatedInput);

              if (permResult.behavior === 'allow') {
                return {
                  behavior: 'allow' as const,
                  updatedInput: (permResult.updatedInput || updatedInput) as Record<string, unknown>,
                };
              } else {
                return {
                  behavior: 'deny' as const,
                  message: permResult.message || 'User denied the request',
                };
              }
            }

            if (shouldDenyClaudeToolWithoutPrompt(toolName, currentPermissionMode)) {
              return {
                behavior: 'deny' as const,
                message: `${toolName} requires permission, and this session is in Don't Ask mode.`,
              };
            }

            const approvalKey = buildClaudeToolApprovalKey(toolName, updatedInput);
            if (sessionApprovedToolAccess.has(approvalKey)) {
              return {
                behavior: 'allow' as const,
                updatedInput,
              };
            }

            if (shouldPromptForClaudeTool(toolName, currentPermissionMode)) {
              const toolUseId = uuidv4();
              const permResult = await onPermissionRequest(
                toolUseId,
                toolName,
                buildClaudeToolApprovalInput(toolName, updatedInput, session.cwd)
              );

              if (permResult.behavior === 'allow') {
                if (permResult.scope === 'session') {
                  sessionApprovedToolAccess.add(approvalKey);
                }
                return {
                  behavior: 'allow' as const,
                  updatedInput: (permResult.updatedInput || updatedInput) as Record<string, unknown>,
                };
              }

              return {
                behavior: 'deny' as const,
                message: permResult.message || 'User declined tool execution.',
              };
            }

            // 其他工具默认允许
            return {
              behavior: 'allow' as const,
              updatedInput,
            };
          },
        },
      });
      activeQuery = result;

      if (typeof thinkingOptions.legacyMaxThinkingTokens === 'number') {
        try {
          await result.setMaxThinkingTokens(thinkingOptions.legacyMaxThinkingTokens);
        } catch (error) {
          console.warn('Failed to set maxThinkingTokens:', error);
        }
      }

      // Track recent messages and assistant text for memory extraction
      // Use a persistent map so messages accumulate across runClaude calls for the same session
      const sessionKey = session.id || currentSessionId || 'default';
      if (!_memoryMessageStore.has(sessionKey)) {
        _memoryMessageStore.set(sessionKey, []);
      }
      const recentMessages = _memoryMessageStore.get(sessionKey)!;
      let currentAssistantText = '';
      let currentTurnHasMemoryWrite = false;

      // Track per-content-block thinking duration so the UI can show
      // "Thinking · Ns" on the collapsed trace after the turn completes.
      // Keyed by the stream-event `index`, which matches the array position
      // of the block inside the `assistant` message's content[].
      const thinkingStartByIndex = new Map<number, number>();
      const thinkingDurationByIndex = new Map<number, number>();

      // 流式处理消息
      for await (const message of result) {
        if (abortController.signal.aborted) {
          break;
        }

        // 转换 SDK 消息为内部格式并发送
        const streamMessage = convertSDKMessage(message as SDKMessage);
        if (streamMessage) {
          // Subagent (Task) activity streams interleaved with the top-level
          // turn. Keep the thinking-duration bookkeeping scoped to the main
          // agent: subagent stream events share content-block indices with the
          // parent and would otherwise corrupt the per-index timers.
          const isSubagentMessage = Boolean(streamMessage.parentToolUseId);

          if (streamMessage.type === 'stream_event' && !isSubagentMessage) {
            const event = streamMessage.event;
            if (
              event.type === 'content_block_delta' &&
              event.delta?.type === 'thinking_delta' &&
              typeof event.index === 'number'
            ) {
              const i = event.index;
              // A brand-new block arriving at a previously-completed index
              // means we've rolled into a new turn (same stream, new Claude
              // message). Drop the old timing so we measure fresh.
              if (thinkingDurationByIndex.has(i)) {
                thinkingStartByIndex.delete(i);
                thinkingDurationByIndex.delete(i);
              }
              if (!thinkingStartByIndex.has(i)) {
                thinkingStartByIndex.set(i, Date.now());
              }
            } else if (
              event.type === 'content_block_stop' &&
              typeof event.index === 'number' &&
              thinkingStartByIndex.has(event.index) &&
              !thinkingDurationByIndex.has(event.index)
            ) {
              thinkingDurationByIndex.set(
                event.index,
                Date.now() - thinkingStartByIndex.get(event.index)!
              );
            }
          }

          if (streamMessage.type === 'assistant' && !isSubagentMessage && streamMessage.message?.content) {
            // Annotate thinking blocks in-place with the measured duration.
            // Partial assistant messages may arrive before the block's stop
            // event; in that case durationMs stays undefined and a later
            // re-emission of the same UUID will fill it in.
            const blocks = streamMessage.message.content as ContentBlock[];
            for (let i = 0; i < blocks.length; i++) {
              const block = blocks[i];
              if (block.type === 'thinking' && block.durationMs === undefined) {
                const duration = thinkingDurationByIndex.get(i);
                if (typeof duration === 'number' && duration >= 0) {
                  block.durationMs = duration;
                }
              }
            }
          }

          if (streamMessage.type === 'system' && streamMessage.subtype === 'init') {
            currentSessionId = streamMessage.session_id || currentSessionId;
            const initializedDisplayModel = reconcileClaudeDisplayModel(
              currentModel,
              streamMessage.model
            );
            if (currentRuntimeModel && streamMessage.model && initializedDisplayModel !== currentModel) {
              try {
                await result.setModel(currentRuntimeModel);
              } catch (error) {
                console.warn('Failed to re-apply requested model after init:', error);
              }
            }
          }

          if (
            ENABLE_AEGIS_MEMORY_FOR_NATIVE_PROVIDERS &&
            streamMessage.type === 'assistant' &&
            !isSubagentMessage &&
            streamMessage.message?.content
          ) {
            const textParts = (streamMessage.message.content as ContentBlock[])
              .filter(b => b.type === 'text' && b.text)
              .map(b => b.text!);
            if (textParts.length > 0) {
              currentAssistantText = textParts.join('');
            }
          }

          // Track if remember_write was called in this turn
          if (
            ENABLE_AEGIS_MEMORY_FOR_NATIVE_PROVIDERS &&
            streamMessage.type === 'assistant' &&
            streamMessage.message?.content
          ) {
            const raw = JSON.stringify(streamMessage.message.content);
            if (hasMemoryWritesInTurn(raw)) {
              currentTurnHasMemoryWrite = true;
            }
          }

          // On result (turn complete), trigger memory extraction
          if (ENABLE_AEGIS_MEMORY_FOR_NATIVE_PROVIDERS && streamMessage.type === 'result') {
            if (currentAssistantText) {
              recentMessages.push({ role: 'assistant', content: currentAssistantText });
              // Cap at last 10 messages to avoid unbounded growth
              while (recentMessages.length > 10) recentMessages.shift();
            }
            if (
              !currentTurnHasMemoryWrite &&
              shouldExtractMemory(sessionKey) &&
              recentMessages.length >= 2
            ) {
              // Fire-and-forget: don't block the stream
              extractMemories(recentMessages.slice(), sessionCwd).catch(err =>
                console.warn('[runner] Memory extraction failed:', err)
              );
            }
            currentAssistantText = '';
            currentTurnHasMemoryWrite = false;
          }

          onMessage(streamMessage);
        }
      }
    } catch (error: unknown) {
      // 忽略 abort 错误
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      onError?.(err);
    } finally {
      inputQueue.close();
    }
  })();

  return {
    abort: () => {
      abortController.abort();
      inputQueue.close();
    },
    send: (text, promptAttachments, requestedModel) =>
      enqueuePrompt(text, promptAttachments, requestedModel),
    interrupt: async () => {
      if (!activeQuery) {
        throw new Error('Session is not active.');
      }
      await activeQuery.interrupt();
    },
    cancelPendingPrompts: () => {
      // Everything issued so far that has not settled will be dropped before
      // it reaches the input queue; report how many so the caller can remove
      // them from its turn accounting (they will never produce a result).
      const pending = promptSeq - Math.max(settledPromptSeq, cancelledPromptSeq);
      cancelledPromptSeq = promptSeq;
      return Math.max(0, pending);
    },
    rewindFiles: async (userMessageId, options) => {
      if (!activeQuery) {
        return { canRewind: false, error: 'Session is not active.' };
      }
      return activeQuery.rewindFiles(userMessageId, { dryRun: options?.dryRun });
    },
  };
}

// 转换 SDK 消息为内部 StreamMessage 格式
function convertSDKMessage(message: SDKMessage): StreamMessage | null {
  switch (message.type) {
    case 'system':
      if (message.subtype === 'init') {
        return {
          type: 'system',
          subtype: 'init',
          session_id: message.session_id || '',
          model: message.model || '',
          permissionMode: message.permissionMode || '',
          cwd: message.cwd || '',
          tools: message.tools || [],
          slash_commands: message.slash_commands,
          skills: message.skills,
          mcp_servers: message.mcp_servers,
        };
      }
      if (message.subtype === 'compact_boundary' && message.uuid && message.session_id) {
        return {
          type: 'system',
          subtype: 'compact_boundary',
          uuid: message.uuid,
          session_id: message.session_id,
          compactMetadata: {
            trigger: message.compact_metadata?.trigger === 'manual' ? 'manual' : 'auto',
            preTokens: message.compact_metadata?.pre_tokens || 0,
          },
        };
      }
      return null;

    case 'assistant':
      return {
        type: 'assistant',
        uuid: message.uuid || uuidv4(),
        parentToolUseId: getParentToolUseId(message),
        message: (message.message || { content: [] }) as any,
      };

    case 'user':
      return {
        type: 'user',
        uuid: message.uuid || uuidv4(),
        parentToolUseId: getParentToolUseId(message),
        message: (message.message || { content: [] }) as any,
      };

    case 'result':
      return {
        type: 'result',
        subtype: message.subtype || 'success',
        duration_ms: message.duration_ms || 0,
        total_cost_usd: message.total_cost_usd || 0,
        usage: message.usage || { input_tokens: 0, output_tokens: 0 },
        modelUsage: normalizeModelUsage(message.modelUsage),
      };

    case 'stream_event': {
      const rawEvent = message.event;
      if (!rawEvent || typeof rawEvent.type !== 'string') {
        return null;
      }

      if (!isStreamEventType(rawEvent.type)) {
        return null;
      }

      const eventType = rawEvent.type;
      const event = {
        type: eventType,
        index: typeof rawEvent.index === 'number' ? rawEvent.index : undefined,
        delta:
          eventType === 'content_block_delta' && rawEvent.delta
            ? {
                type: typeof rawEvent.delta.type === 'string' ? rawEvent.delta.type : '',
                text: typeof rawEvent.delta.text === 'string' ? rawEvent.delta.text : undefined,
                thinking:
                  typeof rawEvent.delta.thinking === 'string'
                    ? rawEvent.delta.thinking
                    : undefined,
                signature:
                  typeof rawEvent.delta.signature === 'string'
                    ? rawEvent.delta.signature
                    : undefined,
              }
            : undefined,
      };

      return {
        type: 'stream_event',
        parentToolUseId: getParentToolUseId(message),
        event,
      };
    }

    default:
      return null;
  }
}

// Subagent messages (emitted while a Task tool call runs) carry the parent
// Task's tool_use id. The UI uses this to nest them under the Task row and to
// keep subagent deltas out of the top-level streaming buffer.
function getParentToolUseId(message: SDKMessage): string | null {
  const raw = (message as { parent_tool_use_id?: unknown }).parent_tool_use_id;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}
