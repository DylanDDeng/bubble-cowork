import { spawn, type ChildProcess } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { access, appendFile, mkdir, readFile, readdir, writeFile } from 'fs/promises';
import { constants } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import type {
  AegisPermissionMode,
  Attachment,
  ContentBlock,
  PermissionResult,
  StreamEvent,
  StreamMessage,
  Usage,
} from '../../../shared/types';
import {
  AEGIS_BUILT_IN_DEFAULT_MODEL,
  getAegisBuiltInProvider,
  resolveAegisBuiltInModel,
} from '../../../shared/aegis-built-in-catalog';
import type { RunnerOptions } from '../../types';
import { loadAegisBuiltInAgentConfig } from '../aegis-built-in-config';
import { getAegisMemoryHome } from '../memory-paths';
import type { AgentRuntime } from './types';

type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatMessage {
  role: ChatRole;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ToolResult {
  content: string;
  isError?: boolean;
}

interface ToolEntry {
  definition: ToolDefinition;
  readOnly?: boolean;
  execute: (args: Record<string, unknown>) => Promise<ToolResult>;
}

type TodoStatus = 'pending' | 'in_progress' | 'completed';

interface TodoItem {
  content: string;
  activeForm: string;
  status: TodoStatus;
}

interface ModelTurn {
  content: string;
  reasoning: string;
  toolCalls: ChatToolCall[];
  usage?: Usage;
}

interface BuiltinModelSelection {
  providerId: string;
  modelId: string;
  encodedModel: string;
  baseUrl: string;
  apiKey: string;
  temperature: number;
  maxOutputTokens?: number;
}

const DEFAULT_MODEL = AEGIS_BUILT_IN_DEFAULT_MODEL;
const MAX_TOOL_TURNS = 24;
const MAX_OUTPUT_CHARS = 48_000;
const MAX_READ_CHARS = 40_000;
const MAX_GLOB_RESULTS = 400;
const MAX_GREP_RESULTS = 120;
const MAX_MEMORY_SECTION_CHARS = 8_000;
const MEMORY_SEARCH_LIMIT = 16;
const RESIDENT_HISTORY_MESSAGE_LIMIT = 160;
const RESIDENT_HISTORY_CHAR_LIMIT = 512 * 1024;
const MOONSHOT_PROVIDER_IDS = new Set(['moonshot-cn', 'moonshot-intl', 'kimi-for-coding']);
const KIMI_K25_FAMILY = new Set(['kimi-k2.5', 'k2.6-code-preview', 'kimi-k2.6']);
const KIMI_THINKING_FAMILY = new Set(['kimi-k2-thinking', 'kimi-k2-thinking-turbo']);

const PROVIDER_API_KEY_ENV: Record<string, string[]> = {
  openai: ['AEGIS_BUILTIN_OPENAI_API_KEY', 'OPENAI_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  zhipuai: ['ZHIPUAI_API_KEY', 'ZHIPU_API_KEY'],
  'zhipuai-coding-plan': ['ZHIPUAI_API_KEY', 'ZHIPU_API_KEY'],
  zai: ['ZAI_API_KEY'],
  'zai-coding-plan': ['ZAI_API_KEY'],
  'moonshot-cn': ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  'moonshot-intl': ['MOONSHOT_API_KEY', 'KIMI_API_KEY'],
  'kimi-for-coding': ['KIMI_API_KEY', 'MOONSHOT_API_KEY'],
  groq: ['GROQ_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  fireworks: ['FIREWORKS_API_KEY'],
};
const PROVIDER_BASE_URL_ENV: Record<string, string[]> = {
  openai: ['AEGIS_BUILTIN_OPENAI_BASE_URL', 'OPENAI_BASE_URL'],
  deepseek: ['DEEPSEEK_BASE_URL'],
  google: ['GOOGLE_BASE_URL', 'GEMINI_BASE_URL'],
  zhipuai: ['ZHIPUAI_BASE_URL', 'ZHIPU_BASE_URL'],
  'zhipuai-coding-plan': ['ZHIPUAI_BASE_URL', 'ZHIPU_BASE_URL'],
  zai: ['ZAI_BASE_URL'],
  'zai-coding-plan': ['ZAI_BASE_URL'],
  'moonshot-cn': ['MOONSHOT_BASE_URL', 'KIMI_BASE_URL'],
  'moonshot-intl': ['MOONSHOT_BASE_URL', 'KIMI_BASE_URL'],
  'kimi-for-coding': ['KIMI_BASE_URL', 'MOONSHOT_BASE_URL'],
  groq: ['GROQ_BASE_URL'],
  together: ['TOGETHER_BASE_URL'],
  fireworks: ['FIREWORKS_BASE_URL'],
  local: ['LOCAL_OPENAI_BASE_URL', 'OLLAMA_BASE_URL'],
};

function readFirstEnv(names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return '';
}

function getBuiltinBaseUrl(providerId?: string): string {
  const config = loadAegisBuiltInAgentConfig();
  const provider = providerId ? getAegisBuiltInProvider(providerId) : null;
  const envBaseUrl = readFirstEnv([
    ...((providerId && PROVIDER_BASE_URL_ENV[providerId]) || []),
    'AEGIS_BUILTIN_BASE_URL',
  ]);
  return (envBaseUrl || provider?.baseUrl || config.baseUrl || 'https://api.openai.com/v1')
    .trim()
    .replace(/\/+$/, '');
}

function getBuiltinApiKey(providerId: string): string {
  const config = loadAegisBuiltInAgentConfig();
  const envKey = readFirstEnv([
    ...(PROVIDER_API_KEY_ENV[providerId] || []),
    'AEGIS_BUILTIN_API_KEY',
  ]);
  return (config.apiKey || envKey).trim();
}

function buildProviderRequestExtras(selection: BuiltinModelSelection): {
  extraBody?: Record<string, unknown>;
  omitTemperature?: boolean;
} {
  if (MOONSHOT_PROVIDER_IDS.has(selection.providerId)) {
    if (KIMI_K25_FAMILY.has(selection.modelId)) {
      return {
        omitTemperature: true,
        extraBody: { thinking: { type: 'disabled' } },
      };
    }
    if (KIMI_THINKING_FAMILY.has(selection.modelId)) {
      return { omitTemperature: true };
    }
  }
  return {};
}

function resolveBuiltinSelection(model?: string | null): BuiltinModelSelection {
  const config = loadAegisBuiltInAgentConfig();
  const selection = resolveAegisBuiltInModel(
    model?.trim() ||
      process.env.AEGIS_BUILTIN_MODEL?.trim() ||
      config.model?.trim() ||
      process.env.OPENAI_MODEL?.trim() ||
      DEFAULT_MODEL,
    config.providerId
  );
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    encodedModel: selection.encoded,
    baseUrl: getBuiltinBaseUrl(selection.providerId),
    apiKey: getBuiltinApiKey(selection.providerId),
    temperature: config.temperature,
    maxOutputTokens: config.maxOutputTokens,
  };
}

function normalizePermissionMode(mode?: AegisPermissionMode): AegisPermissionMode {
  return mode === 'readOnly' || mode === 'fullAccess' ? mode : 'defaultPermissions';
}

function buildSystemPrompt(input: {
  cwd: string;
  model: string;
  permissionMode: AegisPermissionMode;
  toolNames: string[];
  memoryPrompt?: string;
  todos?: TodoItem[];
}): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    'You are Aegis Built-in Agent, a pragmatic coding agent running inside the Aegis desktop app.',
    'You can inspect and modify the current project through tools. Use tools when the answer depends on current files, command output, or verification.',
    'Keep edits scoped to the user request. Do not modify provider-native config for Claude Code, Codex, or opencode.',
    'Prefer glob for file discovery, grep for content search, and read for exact file inspection before using bash.',
    'Use edit for existing files and write for new files. Use todo_write for complex multi-step implementation work.',
    'Use ask_user only when a user decision or missing requirement blocks meaningful progress.',
    'When permission mode is readOnly, destructive tools are unavailable. Investigate, then call exit_plan_mode with a concrete plan for approval.',
    'Use built-in memory tools only for this built-in agent. Do not touch Claude Code, Codex, or OpenCode native memory/config.',
    '',
    `Current date: ${today}`,
    `Working directory: ${input.cwd}`,
    `Model: ${input.model}`,
    `Permission mode: ${input.permissionMode}`,
    `Available tools: ${input.toolNames.join(', ')}`,
    input.todos && input.todos.length > 0
      ? [
          '',
          'Current todo list:',
          ...input.todos.map((todo) => `- [${todo.status}] ${todo.content} (${todo.activeForm})`),
        ].join('\n')
      : '',
    input.memoryPrompt ? `\n${input.memoryPrompt}` : '',
  ].join('\n');
}

function attachmentText(attachments?: Attachment[]): string {
  if (!attachments || attachments.length === 0) return '';
  const lines = attachments.map((attachment) => {
    const preview = attachment.previewText?.trim();
    return [
      `- ${attachment.name} (${attachment.kind}, ${attachment.path})`,
      preview ? `  preview: ${preview.slice(0, 1200)}` : '',
    ].filter(Boolean).join('\n');
  });
  return `\n\nAttachments:\n${lines.join('\n')}`;
}

function resolveInsideCwd(cwd: string, inputPath: unknown): { ok: true; path: string; rel: string } | { ok: false; error: string } {
  const raw = typeof inputPath === 'string' ? inputPath.trim() : '';
  if (!raw) return { ok: false, error: 'path is required' };
  const absolute = resolve(cwd, raw);
  const rel = relative(cwd, absolute);
  if (rel.startsWith('..') || rel === '..' || rel.split(sep).includes('..')) {
    return { ok: false, error: `Path is outside the project directory: ${raw}` };
  }
  return { ok: true, path: absolute, rel };
}

function truncate(value: string, maxChars = MAX_OUTPUT_CHARS): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars).trimEnd()}\n\n[truncated ${value.length - maxChars} chars]`;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function buildToolDefinitions(tools: ToolEntry[]): ToolDefinition[] {
  return tools.map((tool) => tool.definition);
}

function buildAssistantMessage(content: ContentBlock[], streaming = false): StreamMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    streaming,
    message: { content },
  };
}

function buildUserToolResult(toolCallId: string, content: string, isError?: boolean): StreamMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolCallId, content, is_error: isError || undefined }],
    },
  };
}

function buildStreamDelta(text: string): StreamMessage {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    } satisfies StreamEvent,
  };
}

function buildReasoningDelta(text: string): StreamMessage {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: text },
    } satisfies StreamEvent,
  };
}

function buildStreamStop(): StreamMessage {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_stop',
      index: 0,
    } satisfies StreamEvent,
  };
}

function makeUsage(raw: any): Usage {
  return {
    input_tokens: typeof raw?.prompt_tokens === 'number' ? raw.prompt_tokens : 0,
    output_tokens: typeof raw?.completion_tokens === 'number' ? raw.completion_tokens : 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: typeof raw?.prompt_cache_hit_tokens === 'number' ? raw.prompt_cache_hit_tokens : 0,
  };
}

function extractBalancedJson(value: string, start: number): string | null {
  if (value[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\' && inString) {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return null;
}

function normalizeToolArgs(raw: string): string {
  const value = (raw || '').trim();
  if (!value) return '{}';
  try {
    JSON.parse(value);
    return value;
  } catch {
    const firstObject = extractBalancedJson(value, 0);
    if (!firstObject) return '{}';
    try {
      JSON.parse(firstObject);
      return firstObject;
    } catch {
      return '{}';
    }
  }
}

function safeAgentMemoryKey(session: RunnerOptions['session']): string {
  const raw = session.agent_id?.trim() || 'default';
  const slug = raw.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 10);
  return `${slug || 'default'}-${hash}`;
}

function getAgentMemoryRoot(session: RunnerOptions['session']): string {
  return join(getAegisMemoryHome(), 'builtin-agents', safeAgentMemoryKey(session));
}

async function ensureAgentMemoryFiles(memoryRoot: string): Promise<void> {
  await mkdir(memoryRoot, { recursive: true });
  const memoryPath = join(memoryRoot, 'memory.md');
  const summaryPath = join(memoryRoot, 'memory_summary.md');
  if (!existsSync(memoryPath)) {
    await writeFile(memoryPath, [
      '# Aegis Built-in Agent Memory',
      '',
      'Durable memories for this specific Aegis built-in agent profile.',
      '',
      '## Manual Notes',
      '',
    ].join('\n'), 'utf-8');
  }
  if (!existsSync(summaryPath)) {
    await writeFile(summaryPath, [
      '# Aegis Built-in Agent Memory Summary',
      '',
      'Concise high-signal summary for this specific built-in agent.',
      '',
    ].join('\n'), 'utf-8');
  }
}

async function readOptionalText(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function trimMemorySection(value: string, maxChars = MAX_MEMORY_SECTION_CHARS): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const head = Math.floor(maxChars * 0.25);
  const tail = maxChars - head - 80;
  return `${trimmed.slice(0, head).trimEnd()}\n\n...[${trimmed.length - head - tail} chars omitted; use memory_search or memory_read_summary for targeted retrieval]...\n\n${trimmed.slice(-tail).trimStart()}`;
}

async function buildAgentMemoryPrompt(memoryRoot: string): Promise<string> {
  await ensureAgentMemoryFiles(memoryRoot);
  const summary = trimMemorySection(await readOptionalText(join(memoryRoot, 'memory_summary.md')), 4_000);
  const recent = trimMemorySection(await readOptionalText(join(memoryRoot, 'memory.md')), 4_000);
  return [
    '## Built-in Agent Memory',
    `Memory root: ${memoryRoot}`,
    summary ? `Loaded summary:\n${summary}` : 'No memory summary has been written yet.',
    recent ? `Recent durable memory entries:\n${recent}` : '',
    '',
    'Memory rules:',
    '- Search or read memory when the task mentions prior work, stable preferences, recurring workflows, or this agent profile.',
    '- Write memory only when the user explicitly asks you to remember something or when a durable preference/decision is clearly worth preserving.',
    '- Keep this memory scoped to this built-in agent profile.',
  ].join('\n');
}

async function searchAgentMemory(memoryRoot: string, query: string, limit = MEMORY_SEARCH_LIMIT): Promise<string> {
  await ensureAgentMemoryFiles(memoryRoot);
  const normalized = query.trim().toLowerCase();
  if (!normalized) return 'Error: query is required.';
  const files = [join(memoryRoot, 'memory_summary.md'), join(memoryRoot, 'memory.md')];
  const matches: string[] = [];
  for (const file of files) {
    const content = await readOptionalText(file);
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.toLowerCase().includes(normalized)) continue;
      matches.push(`- ${file}:${index + 1}\n  ${line.trim().slice(0, 260)}`);
      if (matches.length >= limit) break;
    }
    if (matches.length >= limit) break;
  }
  return matches.length > 0
    ? [`Memory search results for "${query}":`, ...matches].join('\n')
    : `No built-in agent memory matches for "${query}".`;
}

async function streamChatCompletion(input: {
  messages: ChatMessage[];
  selection: BuiltinModelSelection;
  tools: ToolDefinition[];
  signal: AbortSignal;
  onText: (text: string) => void;
  onReasoning?: (text: string) => void;
}): Promise<ModelTurn> {
  const apiKey = input.selection.apiKey;
  if (!apiKey && input.selection.providerId !== 'local') {
    throw new Error('Aegis Built-in Agent requires an API key. Configure Settings > Providers > Aegis Built-in Agent, or set a matching provider API key in the app environment.');
  }
  const maxOutputTokens = input.selection.maxOutputTokens;
  const providerExtras = buildProviderRequestExtras(input.selection);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const body: Record<string, unknown> = {
    model: input.selection.modelId,
    messages: input.messages,
    tools: input.tools.length > 0 ? input.tools : undefined,
    tool_choice: input.tools.length > 0 ? 'auto' : undefined,
    stream: true,
  };
  if (input.selection.providerId === 'deepseek') {
    body.stream_options = { include_usage: true };
  }
  if (!providerExtras.omitTemperature) {
    body.temperature = input.selection.temperature;
  }
  if (maxOutputTokens) {
    body.max_tokens = maxOutputTokens;
  }
  if (providerExtras.extraBody) {
    Object.assign(body, providerExtras.extraBody);
  }

  const response = await fetch(`${input.selection.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: input.signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Model request failed with ${response.status}${detail ? `: ${detail.slice(0, 1200)}` : ''}`);
  }
  if (!response.body) {
    throw new Error('Model response did not include a stream body.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const toolCalls = new Map<number, ChatToolCall>();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let usage: Usage | undefined;

  const handlePayload = (payload: string) => {
    if (payload === '[DONE]') return;
    const parsed = JSON.parse(payload);
    const rawUsage = parsed.usage;
    if (rawUsage) {
      usage = makeUsage(rawUsage);
    }
    const delta = parsed.choices?.[0]?.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      const thinkMatch = delta.content.match(/<think>([\s\S]*?)<\/think>/);
      if (thinkMatch) {
        const thinking = thinkMatch[1] || '';
        if (thinking) {
          reasoning += thinking;
          input.onReasoning?.(thinking);
        }
        const remaining = delta.content.replace(/<think>[\s\S]*?<\/think>/, '');
        if (remaining) {
          content += remaining;
          input.onText(remaining);
        }
      } else {
        content += delta.content;
        input.onText(delta.content);
      }
    }
    const reasoningDelta = delta.reasoning || delta.thinking || delta.reasoning_content;
    if (typeof reasoningDelta === 'string' && reasoningDelta) {
      reasoning += reasoningDelta;
      input.onReasoning?.(reasoningDelta);
    }
    const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const call of calls) {
      const index = typeof call.index === 'number' ? call.index : 0;
      const existing = toolCalls.get(index) || {
        id: call.id || `call_${randomUUID().replace(/-/g, '')}`,
        type: 'function' as const,
        function: { name: '', arguments: '' },
      };
      if (typeof call.id === 'string') existing.id = call.id;
      if (typeof call.function?.name === 'string') existing.function.name = call.function.name;
      if (typeof call.function?.arguments === 'string') {
        existing.function.arguments += call.function.arguments;
      }
      toolCalls.set(index, existing);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    for (const event of events) {
      const payloadLines = event
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trim())
        .filter(Boolean);
      for (const payload of payloadLines) {
        handlePayload(payload);
      }
    }
  }

  return {
    content,
    reasoning,
    toolCalls: Array.from(toolCalls.entries())
      .sort(([left], [right]) => left - right)
      .map(([, call]) => call)
      .filter((call) => call.function.name)
      .map((call) => ({
        ...call,
        function: {
          ...call.function,
          arguments: normalizeToolArgs(call.function.arguments),
        },
      })),
    usage,
  };
}

function createTools(input: {
  cwd: string;
  onPermissionRequest: RunnerOptions['onPermissionRequest'];
  signal: AbortSignal;
  children: Set<ChildProcess>;
  memoryRoot: string;
  getPermissionMode: () => AegisPermissionMode;
  setPermissionMode: (mode: AegisPermissionMode) => void;
  getTodos: () => TodoItem[];
  setTodos: (todos: TodoItem[]) => void;
  onTodosUpdate: (todos: TodoItem[]) => void;
}): ToolEntry[] {
  const ask = async (
    toolUseId: string,
    toolName: string,
    request: Parameters<RunnerOptions['onPermissionRequest']>[2]
  ): Promise<PermissionResult> => {
    const mode = input.getPermissionMode();
    if (mode === 'fullAccess') return { behavior: 'allow' };
    if (mode === 'readOnly') {
      return { behavior: 'deny', message: 'Aegis Built-in Agent is in read-only mode.' };
    }
    return input.onPermissionRequest(toolUseId, toolName, request);
  };

  const requireWritePermission = async (params: {
    id: string;
    toolName: string;
    title: string;
    question: string;
    filePath: string;
    summary: string[];
  }): Promise<ToolResult | null> => {
    const decision = await ask(params.id, params.toolName, {
      kind: 'codex-approval',
      approvalKind: 'file-change',
      method: `aegis.builtin.${params.toolName}`,
      title: params.title,
      question: params.question,
      toolName: params.toolName,
      cwd: input.cwd,
      filePath: params.filePath,
      files: [params.filePath],
      permissionSummary: params.summary,
      canAllowForSession: false,
    });
    if (decision.behavior === 'allow') return null;
    return {
      content: decision.message || `${params.toolName} was denied by the user.`,
      isError: true,
    };
  };

  const requireMemoryWritePermission = async (params: {
    id: string;
    toolName: string;
    summary: string[];
  }): Promise<ToolResult | null> => {
    const decision = await ask(params.id, params.toolName, {
      kind: 'codex-approval',
      approvalKind: 'file-change',
      method: `aegis.builtin.${params.toolName}`,
      title: 'Write built-in agent memory',
      question: 'Allow Aegis Built-in Agent to update its own memory?',
      toolName: params.toolName,
      cwd: input.cwd,
      filePath: join(input.memoryRoot, 'memory.md'),
      files: [join(input.memoryRoot, 'memory.md')],
      permissionSummary: params.summary,
      canAllowForSession: false,
    });
    if (decision.behavior === 'allow') return null;
    return {
      content: decision.message || `${params.toolName} was denied by the user.`,
      isError: true,
    };
  };

  const tools: ToolEntry[] = [
    {
      readOnly: true,
      definition: {
        type: 'function',
        function: {
          name: 'read',
          description: 'Read a UTF-8 text file inside the project directory.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path relative to the project root.' },
              offset: { type: 'number', description: 'One-based line offset.' },
              limit: { type: 'number', description: 'Maximum number of lines to read.' },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
      execute: async (args) => {
        const file = resolveInsideCwd(input.cwd, args.path);
        if (!file.ok) return { content: `Error: ${file.error}`, isError: true };
        try {
          const raw = await readFile(file.path, 'utf-8');
          const lines = raw.split('\n');
          const offset = Math.max(0, Math.floor(asNumber(args.offset, 1)) - 1);
          const limit = Math.max(1, Math.min(1000, Math.floor(asNumber(args.limit, 240))));
          const selected = lines.slice(offset, offset + limit);
          const numbered = selected.map((line, index) => `${offset + index + 1}: ${line}`).join('\n');
          return { content: truncate(`Path: ${file.rel}\n${numbered}`, MAX_READ_CHARS) };
        } catch (error) {
          return { content: `Error reading ${file.rel}: ${error instanceof Error ? error.message : String(error)}`, isError: true };
        }
      },
    },
    {
      readOnly: true,
      definition: {
        type: 'function',
        function: {
          name: 'glob',
          description: 'Find files inside the project directory using a glob-like pattern.',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'Glob pattern, for example src/**/*.ts.' },
              path: { type: 'string', description: 'Optional search root relative to the project root.' },
            },
            required: ['pattern'],
            additionalProperties: false,
          },
        },
      },
      execute: async (args) => {
        const root = resolveInsideCwd(input.cwd, args.path || '.');
        if (!root.ok) return { content: `Error: ${root.error}`, isError: true };
        const pattern = asString(args.pattern).trim();
        if (!pattern) return { content: 'Error: pattern is required', isError: true };
        const regex = globToRegExp(pattern);
        const files = await collectFiles(root.path, input.cwd, MAX_GLOB_RESULTS + 1);
        const matches = files.filter((file) => regex.test(file)).slice(0, MAX_GLOB_RESULTS);
        if (matches.length === 0) return { content: `No files matched ${pattern}.` };
        return {
          content: [
            `Matched ${matches.length}${files.length > MAX_GLOB_RESULTS ? '+' : ''} file(s):`,
            ...matches.map((file) => `- ${file}`),
          ].join('\n'),
        };
      },
    },
    {
      readOnly: true,
      definition: {
        type: 'function',
        function: {
          name: 'grep',
          description: 'Search text files inside the project directory.',
          parameters: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'Literal or regex search pattern.' },
              path: { type: 'string', description: 'Optional file or directory path.' },
              glob: { type: 'string', description: 'Optional file glob filter, for example **/*.ts.' },
            },
            required: ['pattern'],
            additionalProperties: false,
          },
        },
      },
      execute: async (args) => {
        const pattern = asString(args.pattern).trim();
        if (!pattern) return { content: 'Error: pattern is required', isError: true };
        const searchRoot = resolveInsideCwd(input.cwd, args.path || '.');
        if (!searchRoot.ok) return { content: `Error: ${searchRoot.error}`, isError: true };
        const glob = asString(args.glob).trim();
        return runCommand({
          command: 'rg',
          args: [
            '-n',
            '--color',
            'never',
            ...(glob ? ['-g', glob] : []),
            pattern,
            searchRoot.path,
          ],
          cwd: input.cwd,
          timeoutMs: 20_000,
          signal: input.signal,
          children: input.children,
          maxChars: MAX_OUTPUT_CHARS,
          noMatchOk: true,
        });
      },
    },
    {
      readOnly: true,
      definition: {
        type: 'function',
        function: {
          name: 'todo_write',
          description: 'Create or update the complete task list for complex multi-step work. Exactly one todo may be in_progress.',
          parameters: {
            type: 'object',
            properties: {
              todos: {
                type: 'array',
                description: 'Complete replacement list of todos.',
                items: {
                  type: 'object',
                  properties: {
                    content: { type: 'string', description: 'Imperative task description.' },
                    activeForm: { type: 'string', description: 'Present continuous form shown while active.' },
                    status: {
                      type: 'string',
                      enum: ['pending', 'in_progress', 'completed'],
                      description: 'Current todo status.',
                    },
                  },
                  required: ['content', 'activeForm', 'status'],
                  additionalProperties: false,
                },
              },
            },
            required: ['todos'],
            additionalProperties: false,
          },
        },
      },
      execute: async (args) => {
        const rawTodos = Array.isArray(args.todos) ? args.todos : null;
        if (!rawTodos) return { content: "Error: 'todos' must be an array", isError: true };
        const normalized: TodoItem[] = [];
        for (let index = 0; index < rawTodos.length; index += 1) {
          const raw = rawTodos[index] as Record<string, unknown>;
          const content = asString(raw?.content).trim();
          const activeForm = asString(raw?.activeForm).trim();
          const status = raw?.status;
          if (!content) return { content: `Error: todo ${index} has empty content`, isError: true };
          if (!activeForm) return { content: `Error: todo ${index} has empty activeForm`, isError: true };
          if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
            return { content: `Error: todo ${index} has invalid status`, isError: true };
          }
          normalized.push({ content, activeForm, status });
        }
        const inProgressCount = normalized.filter((todo) => todo.status === 'in_progress').length;
        if (inProgressCount > 1) {
          return { content: `Error: at most one todo may be in_progress; found ${inProgressCount}`, isError: true };
        }
        input.setTodos(normalized);
        input.onTodosUpdate(normalized);
        const completed = normalized.filter((todo) => todo.status === 'completed').length;
        const pending = normalized.filter((todo) => todo.status === 'pending').length;
        return {
          content: `Todo list updated: ${normalized.length} item(s), ${completed} completed, ${inProgressCount} in progress, ${pending} pending.`,
        };
      },
    },
    {
      readOnly: true,
      definition: {
        type: 'function',
        function: {
          name: 'memory_read_summary',
          description: 'Read the concise long-term memory summary for this specific Aegis built-in agent profile.',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      },
      execute: async () => {
        await ensureAgentMemoryFiles(input.memoryRoot);
        const summaryPath = join(input.memoryRoot, 'memory_summary.md');
        const content = trimMemorySection(await readOptionalText(summaryPath));
        return content
          ? { content: `# Built-in agent memory summary\nPath: ${summaryPath}\n\n${content}` }
          : { content: 'No built-in agent memory summary is available.' };
      },
    },
    {
      readOnly: true,
      definition: {
        type: 'function',
        function: {
          name: 'memory_search',
          description: 'Search long-term memory for this specific Aegis built-in agent profile.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Concrete search terms such as file names, decisions, preferences, or error text.' },
              limit: { type: 'number', description: 'Maximum results. Defaults to 16.' },
            },
            required: ['query'],
            additionalProperties: false,
          },
        },
      },
      execute: async (args) => {
        const query = asString(args.query).trim();
        if (!query) return { content: 'Error: query is required', isError: true };
        const limit = Math.max(1, Math.min(50, Math.floor(asNumber(args.limit, MEMORY_SEARCH_LIMIT))));
        return { content: await searchAgentMemory(input.memoryRoot, query, limit) };
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'memory_write',
          description: 'Append a durable memory for this specific Aegis built-in agent profile. Use only for stable preferences, decisions, workflows, or facts worth remembering.',
          parameters: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Concise durable memory to append.' },
              reason: { type: 'string', description: 'Why this is worth remembering.' },
            },
            required: ['text'],
            additionalProperties: false,
          },
        },
      },
      execute: async (args) => {
        const text = asString(args.text).trim();
        const reason = asString(args.reason).trim();
        if (!text) return { content: 'Error: text is required', isError: true };
        const denied = await requireMemoryWritePermission({
          id: `aegis-memory-${randomUUID()}`,
          toolName: 'memory_write',
          summary: [text.slice(0, 240), reason ? `Reason: ${reason.slice(0, 180)}` : 'Append built-in agent memory'],
        });
        if (denied) return denied;
        await ensureAgentMemoryFiles(input.memoryRoot);
        const memoryPath = join(input.memoryRoot, 'memory.md');
        const entry = [
          '',
          `## ${new Date().toISOString()}`,
          ...(reason ? ['', `Reason: ${reason}`] : []),
          '',
          text,
          '',
        ].join('\n');
        await appendFile(memoryPath, entry, 'utf-8');
        return { content: `Memory appended to ${memoryPath}.` };
      },
    },
    {
      readOnly: true,
      definition: {
        type: 'function',
        function: {
          name: 'exit_plan_mode',
          description: 'When read-only plan mode is active, present a concrete implementation plan and ask the user to approve execution.',
          parameters: {
            type: 'object',
            properties: {
              plan: { type: 'string', description: 'Concrete step-by-step plan to present for approval.' },
            },
            required: ['plan'],
            additionalProperties: false,
          },
        },
      },
      execute: async (args) => {
        if (input.getPermissionMode() !== 'readOnly') {
          return {
            content: 'Error: exit_plan_mode is only valid while Aegis Built-in Agent is in read-only mode.',
            isError: true,
          };
        }
        const plan = asString(args.plan).trim();
        if (!plan) return { content: 'Error: plan is required', isError: true };
        const decision = await input.onPermissionRequest(`aegis-plan-${randomUUID()}`, 'exit_plan_mode', {
          kind: 'codex-approval',
          approvalKind: 'permissions',
          method: 'aegis.builtin.exit_plan_mode',
          title: 'Approve plan',
          question: 'Approve this plan and let Aegis Built-in Agent execute it?',
          toolName: 'exit_plan_mode',
          cwd: input.cwd,
          permissionSummary: plan.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 12),
          canAllowForSession: false,
        });
        if (decision.behavior !== 'allow') {
          return {
            content: decision.message || 'User rejected the plan. Stay in read-only mode and revise the approach.',
          };
        }
        input.setPermissionMode('defaultPermissions');
        return {
          content: `User approved the plan. Permission mode switched to defaultPermissions; you may now execute the approved plan.\n\nApproved plan:\n${plan}`,
        };
      },
    },
    {
      readOnly: true,
      definition: {
        type: 'function',
        function: {
          name: 'ask_user',
          description: 'Ask the user a short blocking question. Prefer continuing autonomously when a reasonable assumption is safe.',
          parameters: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'Question to ask the user.' },
              header: { type: 'string', description: 'Optional short label.' },
              options: {
                type: 'array',
                description: 'Optional answer choices.',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['label'],
                  additionalProperties: false,
                },
              },
              multiSelect: { type: 'boolean', description: 'Whether multiple options can be selected.' },
            },
            required: ['question'],
            additionalProperties: false,
          },
        },
      },
      execute: async (args) => {
        const question = asString(args.question).trim();
        if (!question) return { content: 'Error: question is required', isError: true };
        const rawOptions = Array.isArray(args.options) ? args.options : [];
        const options = rawOptions
          .map((option) => {
            const record = option as Record<string, unknown>;
            const label = asString(record.label).trim();
            const description = asString(record.description).trim();
            return label ? { label, ...(description ? { description } : {}) } : null;
          })
          .filter((option): option is { label: string; description?: string } => Boolean(option));
        const decision = await input.onPermissionRequest(`aegis-question-${randomUUID()}`, 'AskUserQuestion', {
          questions: [
            {
              question,
              header: asString(args.header).trim() || undefined,
              options: options.length > 0 ? options : undefined,
              multiSelect: args.multiSelect === true || undefined,
            },
          ],
        });
        if (decision.behavior !== 'allow') {
          return {
            content: decision.message || 'User did not answer the question.',
            isError: true,
          };
        }
        return {
          content: JSON.stringify(decision.updatedInput || {}, null, 2),
        };
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'bash',
          description: 'Run a shell command in the project directory. Use only when structured tools are insufficient.',
          parameters: {
            type: 'object',
            properties: {
              command: { type: 'string', description: 'Shell command to run.' },
              timeout: { type: 'number', description: 'Timeout in seconds. Defaults to 60.' },
            },
            required: ['command'],
            additionalProperties: false,
          },
        },
      },
      execute: async (args) => {
        const command = asString(args.command).trim();
        if (!command) return { content: 'Error: command is required', isError: true };
        const id = `aegis-bash-${randomUUID()}`;
        const decision = await ask(id, 'bash', {
          kind: 'codex-approval',
          approvalKind: 'command',
          method: 'aegis.builtin.bash',
          title: 'Run command',
          question: `Allow Aegis Built-in Agent to run this command?\n\n${command}`,
          toolName: 'bash',
          command,
          cwd: input.cwd,
          canAllowForSession: true,
        });
        if (decision.behavior !== 'allow') {
          return { content: decision.message || 'Command was denied by the user.', isError: true };
        }
        return runCommand({
          command: process.platform === 'win32' ? 'cmd.exe' : 'bash',
          args: process.platform === 'win32' ? ['/c', command] : ['-lc', command],
          cwd: input.cwd,
          timeoutMs: Math.max(1, Math.min(600, asNumber(args.timeout, 60))) * 1000,
          signal: input.signal,
          children: input.children,
          maxChars: MAX_OUTPUT_CHARS,
        });
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'write',
          description: 'Create a new UTF-8 text file inside the project directory. Refuses to overwrite existing files.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path relative to the project root.' },
              content: { type: 'string', description: 'Full file content.' },
            },
            required: ['path', 'content'],
            additionalProperties: false,
          },
        },
      },
      execute: async (args) => {
        const file = resolveInsideCwd(input.cwd, args.path);
        if (!file.ok) return { content: `Error: ${file.error}`, isError: true };
        if (existsSync(file.path)) {
          return { content: `Error: File already exists: ${file.rel}. Use edit for existing files.`, isError: true };
        }
        const content = asString(args.content);
        const denied = await requireWritePermission({
          id: `aegis-write-${randomUUID()}`,
          toolName: 'write',
          title: 'Write file',
          question: `Allow Aegis Built-in Agent to create ${file.rel}?`,
          filePath: file.path,
          summary: [`Create ${file.rel}`, `${content.split('\n').length} lines`],
        });
        if (denied) return denied;
        await mkdir(dirname(file.path), { recursive: true });
        await writeFile(file.path, content, 'utf-8');
        return { content: `Wrote ${content.split('\n').length} lines to ${file.rel}.` };
      },
    },
    {
      definition: {
        type: 'function',
        function: {
          name: 'edit',
          description: 'Apply one or more exact string replacements to an existing UTF-8 file inside the project directory.',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path relative to the project root.' },
              edits: {
                type: 'array',
                description: 'List of replacements. Each oldText must occur exactly once.',
                items: {
                  type: 'object',
                  properties: {
                    oldText: { type: 'string', description: 'Exact text to replace.' },
                    newText: { type: 'string', description: 'Replacement text.' },
                  },
                  required: ['oldText', 'newText'],
                  additionalProperties: false,
                },
              },
              oldText: { type: 'string', description: 'Deprecated single replacement old text.' },
              newText: { type: 'string', description: 'Deprecated single replacement new text.' },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
      execute: async (args) => {
        const file = resolveInsideCwd(input.cwd, args.path);
        if (!file.ok) return { content: `Error: ${file.error}`, isError: true };
        try {
          await access(file.path, constants.R_OK | constants.W_OK);
        } catch {
          return { content: `Error: Cannot read/write file: ${file.rel}`, isError: true };
        }
        const edits = Array.isArray(args.edits)
          ? args.edits.map((edit) => ({
              oldText: asString((edit as Record<string, unknown>)?.oldText),
              newText: asString((edit as Record<string, unknown>)?.newText),
            }))
          : [{ oldText: asString(args.oldText), newText: asString(args.newText) }];
        if (edits.length === 0) return { content: 'Error: edits are required', isError: true };
        const original = await readFile(file.path, 'utf-8');
        let next = original;
        for (const edit of edits) {
          if (!edit.oldText) return { content: 'Error: every edit requires oldText', isError: true };
          const count = next.split(edit.oldText).length - 1;
          if (count !== 1) {
            return { content: `Error: oldText occurs ${count} time(s) in ${file.rel}; expected exactly once.`, isError: true };
          }
          next = next.replace(edit.oldText, edit.newText);
        }
        const removedChars = edits.reduce((sum, edit) => sum + edit.oldText.length, 0);
        const addedChars = edits.reduce((sum, edit) => sum + edit.newText.length, 0);
        const denied = await requireWritePermission({
          id: `aegis-edit-${randomUUID()}`,
          toolName: 'edit',
          title: 'Edit file',
          question: `Allow Aegis Built-in Agent to edit ${file.rel}?`,
          filePath: file.path,
          summary: [`Edit ${file.rel}`, `${edits.length} replacement(s)`, `Replace ${removedChars} chars with ${addedChars} chars`],
        });
        if (denied) return denied;
        await writeFile(file.path, next, 'utf-8');
        return { content: `Edited ${file.rel} with ${edits.length} replacement(s).` };
      },
    },
  ];

  if (input.getPermissionMode() === 'readOnly') {
    return tools.filter((tool) => tool.readOnly);
  }
  return tools;
}

async function runCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  children: Set<ChildProcess>;
  maxChars: number;
  noMatchOk?: boolean;
}): Promise<ToolResult> {
  return new Promise((resolveResult) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    input.children.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
    }, input.timeoutMs);
    const abort = () => child.kill('SIGTERM');
    input.signal.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      input.signal.removeEventListener('abort', abort);
      input.children.delete(child);
      resolveResult({ content: `Error: ${error.message}`, isError: true });
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      input.signal.removeEventListener('abort', abort);
      input.children.delete(child);
      const output = [
        stdout ? `stdout:\n${stdout.trimEnd()}` : '',
        stderr ? `stderr:\n${stderr.trimEnd()}` : '',
      ].filter(Boolean).join('\n\n') || '(no output)';
      if (timedOut) {
        resolveResult({ content: truncate(`${output}\n\n[command timed out]`, input.maxChars), isError: true });
        return;
      }
      if (input.noMatchOk && code === 1 && !stderr.trim()) {
        resolveResult({ content: 'No matches.' });
        return;
      }
      resolveResult({
        content: truncate(output, input.maxChars),
        isError: code !== 0,
      });
    });
  });
}

async function collectFiles(root: string, cwd: string, limit: number): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string) => {
    if (out.length >= limit) return;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'dist-electron') {
        continue;
      }
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
      } else if (entry.isFile()) {
        out.push(relative(cwd, full));
      }
    }
  };
  await visit(root);
  return out.sort();
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}

class AegisBuiltinAgentSession {
  private messages: ChatMessage[];
  private children = new Set<ChildProcess>();
  private permissionMode: AegisPermissionMode;
  private readonly memoryRoot: string;
  private todos: TodoItem[] = [];

  constructor(private readonly options: RunnerOptions, private readonly abortController: AbortController) {
    const cwd = options.session.cwd || process.cwd();
    const selection = resolveBuiltinSelection(options.model || options.session.model);
    this.permissionMode = normalizePermissionMode(options.aegisPermissionMode);
    this.memoryRoot = getAgentMemoryRoot(options.session);
    this.messages = [
      {
        role: 'system',
        content: buildSystemPrompt({
          cwd,
          model: selection.modelId,
          permissionMode: this.permissionMode,
          toolNames: [],
        }),
      },
    ];
  }

  private getPermissionMode = (): AegisPermissionMode => this.permissionMode;

  private setPermissionMode = (mode: AegisPermissionMode): void => {
    this.permissionMode = normalizePermissionMode(mode);
  };

  private getTodos = (): TodoItem[] => this.todos.map((todo) => ({ ...todo }));

  private setTodos = (todos: TodoItem[]): void => {
    this.todos = todos.map((todo) => ({ ...todo }));
  };

  private emitTodos(todos: TodoItem[]): void {
    this.options.onMessage({
      type: 'plan_update',
      uuid: randomUUID(),
      turnId: `aegis:${this.options.session.id}`,
      steps: todos.map((todo) => ({
        step: todo.content,
        status:
          todo.status === 'in_progress'
            ? 'inProgress'
            : todo.status === 'completed'
              ? 'completed'
              : 'pending',
      })),
    });
  }

  private buildTools(cwd: string): ToolEntry[] {
    return createTools({
      cwd,
      onPermissionRequest: this.options.onPermissionRequest,
      signal: this.abortController.signal,
      children: this.children,
      memoryRoot: this.memoryRoot,
      getPermissionMode: this.getPermissionMode,
      setPermissionMode: this.setPermissionMode,
      getTodos: this.getTodos,
      setTodos: this.setTodos,
      onTodosUpdate: (todos) => this.emitTodos(todos),
    });
  }

  private compactResidentHistory(): void {
    if (
      this.messages.length <= RESIDENT_HISTORY_MESSAGE_LIMIT &&
      JSON.stringify(this.messages).length <= RESIDENT_HISTORY_CHAR_LIMIT
    ) {
      return;
    }

    const system = this.messages[0];
    const recent = this.messages.slice(-Math.floor(RESIDENT_HISTORY_MESSAGE_LIMIT * 0.6));
    while (recent.length > 0 && recent[0].role === 'tool') {
      recent.shift();
    }
    this.messages = [
      system,
      {
        role: 'system',
        content: [
          'Older resident conversation history was pruned to keep the built-in agent context below the provider limit.',
          'Use read, grep, glob, or built-in memory tools to recover durable facts when needed.',
        ].join('\n'),
      },
      ...recent,
    ];
  }

  abort(): void {
    this.abortController.abort();
    for (const child of this.children) {
      child.kill('SIGTERM');
    }
    this.children.clear();
  }

  async runTurn(prompt: string, attachments?: Attachment[], modelOverride?: string, permissionModeOverride?: AegisPermissionMode): Promise<void> {
    const startedAt = Date.now();
    const cwd = this.options.session.cwd || process.cwd();
    const selection = resolveBuiltinSelection(modelOverride || this.options.model || this.options.session.model);
    this.permissionMode = normalizePermissionMode(permissionModeOverride || this.options.aegisPermissionMode || this.permissionMode);
    const userContent = `${prompt}${attachmentText(attachments)}`;
    this.messages.push({ role: 'user', content: userContent });
    const memoryPrompt = await buildAgentMemoryPrompt(this.memoryRoot);
    const initialTools = this.buildTools(cwd);

    this.options.onMessage({
      type: 'system',
      subtype: 'init',
      session_id: `aegis:${this.options.session.id}`,
      model: selection.encodedModel,
      permissionMode: this.permissionMode,
      cwd,
      tools: initialTools.map((tool) => tool.definition.function.name),
    });

    let usage: Usage | undefined;
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn += 1) {
      const tools = this.buildTools(cwd);
      this.messages[0] = {
        role: 'system',
        content: buildSystemPrompt({
          cwd,
          model: selection.modelId,
          permissionMode: this.permissionMode,
          toolNames: tools.map((tool) => tool.definition.function.name),
          memoryPrompt,
          todos: this.getTodos(),
        }),
      };
      const toolByName = new Map(tools.map((tool) => [tool.definition.function.name, tool]));

      const modelTurn = await streamChatCompletion({
        messages: this.messages,
        selection,
        tools: buildToolDefinitions(tools),
        signal: this.abortController.signal,
        onText: (text) => this.options.onMessage(buildStreamDelta(text)),
        onReasoning: (text) => this.options.onMessage(buildReasoningDelta(text)),
      });
      usage = modelTurn.usage || usage;

      if (modelTurn.toolCalls.length === 0) {
        this.options.onMessage(buildStreamStop());
        this.messages.push({ role: 'assistant', content: modelTurn.content || '' });
        const finalBlocks: ContentBlock[] = [];
        if (modelTurn.reasoning.trim()) {
          finalBlocks.push({ type: 'thinking', thinking: modelTurn.reasoning.trimEnd() });
        }
        if (modelTurn.content.trim()) {
          finalBlocks.push({ type: 'text', text: modelTurn.content.trimEnd() });
        }
        if (finalBlocks.length > 0) {
          this.options.onMessage(
            buildAssistantMessage(finalBlocks)
          );
        }
        this.compactResidentHistory();
        this.options.onMessage({
          type: 'result',
          subtype: 'success',
          duration_ms: Date.now() - startedAt,
          total_cost_usd: 0,
          usage: usage || {
            input_tokens: 0,
            output_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        });
        return;
      }

      this.options.onMessage(buildStreamStop());
      this.messages.push({
        role: 'assistant',
        content: modelTurn.content || null,
        tool_calls: modelTurn.toolCalls,
      });
      const toolBlocks: ContentBlock[] = [];
      if (modelTurn.reasoning.trim()) {
        toolBlocks.push({ type: 'thinking', thinking: modelTurn.reasoning.trimEnd() });
      }
      if (modelTurn.content.trim()) {
        toolBlocks.push({ type: 'text', text: modelTurn.content.trimEnd() });
      }
      for (const call of modelTurn.toolCalls) {
        toolBlocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: parseArgs(call.function.arguments),
        });
      }
      this.options.onMessage(buildAssistantMessage(toolBlocks));

      for (const call of modelTurn.toolCalls) {
        const tool = toolByName.get(call.function.name);
        const result = tool
          ? await tool.execute(parseArgs(call.function.arguments))
          : { content: `Error: unknown tool ${call.function.name}`, isError: true };
        this.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result.content,
        });
        this.options.onMessage(buildUserToolResult(call.id, result.content, result.isError));
      }
      this.compactResidentHistory();
    }

    throw new Error(`Aegis Built-in Agent stopped after ${MAX_TOOL_TURNS} tool turns without a final response.`);
  }
}

export const aegisRuntime: AgentRuntime = {
  id: 'aegis',
  displayName: 'Aegis Built-in Agent',
  run: (options) => {
    const abortController = new AbortController();
    const session = new AegisBuiltinAgentSession(options, abortController);

    session.runTurn(options.prompt, options.attachments, options.model, options.aegisPermissionMode).catch((error) => {
      if (!abortController.signal.aborted) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    });

    return {
      abort: () => session.abort(),
      send: (prompt, attachments, model, _codexSkills, _codexMentions, sendOptions) => {
        if (abortController.signal.aborted) return;
        session.runTurn(prompt, attachments, model, sendOptions?.aegisPermissionMode).catch((error) => {
          if (!abortController.signal.aborted) {
            options.onError?.(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    };
  },
};
