import type { ChildProcess } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import type {
  AegisPermissionMode,
  Attachment,
  ContentBlock,
  PermissionResult,
  ProviderInputReference,
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
import { AegisBuiltinAgentCore } from '../builtin-agent/agent';
import { createStaticLspAdapter } from '../builtin-agent/integrations/static-lsp';
import { createAegisSkillAdapter } from '../builtin-agent/integrations/skills';
import { buildSkillInjections, collectImplicitSkillReferences } from '../builtin-agent/skills/injection';
import { getAegisSkills } from '../builtin-agent/skills/manager';
import { renderAvailableSkills } from '../builtin-agent/skills/render';
import { createAllTools as createBuiltinTools } from '../builtin-agent/tools';
import type {
  BuiltinAgentCallbacks,
  BuiltinApprovalController,
  BuiltinMemoryAdapter,
  BuiltinPermissionMode,
  BuiltinPlanController,
  BuiltinQuestionController,
  BuiltinTodoItem,
  BuiltinToolDefinition,
  BuiltinToolResultMetadata,
  BuiltinToolRegistryEntry,
} from '../builtin-agent/types';
import { getAegisMemoryHome } from '../memory-paths';
import {
  beginBuiltinMemoryRollout,
  completeBuiltinMemoryConsolidation,
  completeBuiltinMemoryExtraction,
  enqueueBuiltinMemoryRollout,
  failBuiltinMemoryConsolidation,
  failBuiltinMemoryRollout,
  getSessionHistory,
  listUnconsolidatedBuiltinMemoryCandidates,
} from '../session-store';
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
  reasoning_content?: string;
}

interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ModelTurn {
  content: string;
  reasoning: string;
  toolCalls: ChatToolCall[];
  usage?: Usage;
}

interface AutoMemoryCandidate {
  text: string;
  reason?: string;
  confidence?: string;
}

interface AutoMemoryOutput {
  memories?: AutoMemoryCandidate[];
  rolloutSummary?: string;
  rolloutSlug?: string;
  summary?: string;
}

interface MemoryConsolidationOutput {
  memoryMd?: string;
  summaryMd?: string;
  summary?: string;
}

interface BuiltinModelSelection {
  providerId: string;
  modelId: string;
  encodedModel: string;
  baseUrl: string;
  apiKey: string;
  temperature: number;
  reasoningEffort?: 'high' | 'max';
  maxOutputTokens?: number;
}

const DEFAULT_MODEL = AEGIS_BUILT_IN_DEFAULT_MODEL;
const MAX_MEMORY_SECTION_CHARS = 8_000;
const AUTO_MEMORY_TRANSCRIPT_CHARS = 18_000;
const AUTO_MEMORY_SUMMARY_CHARS = 5_000;
const AUTO_MEMORY_TIMEOUT_MS = 45_000;
const AUTO_MEMORY_CONSOLIDATION_CANDIDATES = 24;
const MEMORY_SEARCH_LIMIT = 16;
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
  const storedKey = config.providerApiKeys?.[providerId]
    || (config.providerId === providerId ? config.apiKey : '');
  return (storedKey || envKey).trim();
}

function buildProviderRequestExtras(selection: BuiltinModelSelection): {
  extraBody?: Record<string, unknown>;
  omitTemperature?: boolean;
} {
  if (
    selection.providerId === 'deepseek' &&
    (selection.modelId === 'deepseek-v4-flash' || selection.modelId === 'deepseek-v4-pro')
  ) {
    return {
      extraBody: {
        thinking: { type: 'enabled' },
        reasoning_effort: selection.reasoningEffort || 'high',
      },
    };
  }
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

function serializeMessagesForProvider(
  messages: ChatMessage[],
  selection: BuiltinModelSelection
): ChatMessage[] {
  const echoDeepSeekReasoning =
    selection.providerId === 'deepseek' &&
    (selection.modelId === 'deepseek-v4-flash' || selection.modelId === 'deepseek-v4-pro');
  return messages.map((message) => {
    if (message.role !== 'assistant') {
      return { ...message };
    }
    const serialized: ChatMessage = {
      role: 'assistant',
      content: message.content ?? null,
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    };
    if (echoDeepSeekReasoning) {
      serialized.reasoning_content =
        typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
    }
    return serialized;
  });
}

function resolveBuiltinSelection(
  model?: string | null,
  reasoningEffort?: 'high' | 'max'
): BuiltinModelSelection {
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
    reasoningEffort: reasoningEffort || 'high',
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
  skillsPrompt?: string;
  todos?: BuiltinTodoItem[];
}): string {
  const today = new Date().toISOString().slice(0, 10);
  return [
    'You are Aegis Built-in Agent, a pragmatic coding agent running inside the Aegis desktop app.',
    'You can inspect and modify the current project through tools. Use tools when the answer depends on current files, command output, or verification.',
    'Keep edits scoped to the user request. Do not modify provider-native config for Claude Code, Codex, or opencode.',
    'Prefer glob for file discovery, grep for content search, lsp for code navigation, and read for exact file inspection before using bash.',
    'Use web_search and web_fetch when the task depends on current external information or a referenced URL.',
    'Use edit for existing files and write for new files. Use todo_write for complex multi-step implementation work.',
    'Use task for bounded read-only sub-investigations. Use skill_read and skill_read_resource for progressive skill loading. Use tool_search before calling deferred tools such as the legacy skill wrapper.',
    'Use question only when a user decision or missing requirement blocks meaningful progress.',
    'When permission mode is readOnly, destructive tools are unavailable. Investigate, then call exit_plan_mode with a concrete plan for approval.',
    'Built-in memory is read-only from this conversation. A background memory worker may update this built-in agent profile after turns complete.',
    'Do not touch Claude Code, Codex, or OpenCode native memory/config.',
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
    input.skillsPrompt ? `\n${input.skillsPrompt}` : '',
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

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function toOpenAiToolDefinition(tool: BuiltinToolDefinition): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function buildAssistantMessage(content: ContentBlock[], streaming = false): StreamMessage {
  return {
    type: 'assistant',
    uuid: randomUUID(),
    streaming,
    message: { content },
  };
}

function serializeToolResultContent(
  content: string,
  metadata?: BuiltinToolResultMetadata
): string {
  if (!metadata || Object.keys(metadata).length === 0) {
    return content;
  }

  return JSON.stringify({
    output: content,
    metadata,
  });
}

function getSerializedToolResultOutput(content: string): string {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as { output?: unknown }).output === 'string'
    ) {
      return (parsed as { output: string }).output;
    }
  } catch {
    // Plain text tool results are the common path.
  }

  return content;
}

function buildUserToolResult(
  toolCallId: string,
  content: string,
  isError?: boolean,
  metadata?: BuiltinToolResultMetadata
): StreamMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    message: {
      content: [{
        type: 'tool_result',
        tool_use_id: toolCallId,
        content: serializeToolResultContent(content, metadata),
        is_error: isError || undefined,
      }],
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
    '- Do not write memory from the conversation. A background worker extracts durable memories after completed turns.',
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

function isAutomaticMemoryEnabled(): boolean {
  const value = (process.env.AEGIS_BUILTIN_MEMORY_AUTO || '').trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off' && value !== 'no';
}

function redactMemorySecrets(value: string): string {
  return value
    .replace(/\b(sk|sk-proj|sk-ant|xai|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_SECRET]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]')
    .replace(/(api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^"'\s]+/gi, '$1=[REDACTED_SECRET]');
}

function truncateMiddle(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const head = Math.floor(maxChars * 0.45);
  const tail = maxChars - head - 80;
  return `${trimmed.slice(0, head).trimEnd()}\n\n...[${trimmed.length - head - tail} chars omitted for automatic memory extraction]...\n\n${trimmed.slice(-tail).trimStart()}`;
}

function extractJsonObject(raw: string): unknown | null {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parseAutoMemoryOutput(raw: string): AutoMemoryOutput {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') {
    return {};
  }
  const record = parsed as Record<string, unknown>;
  const memories: AutoMemoryCandidate[] = [];
  const rawMemories = Array.isArray(record.memories)
    ? record.memories
    : Array.isArray(record.raw_memories)
      ? record.raw_memories
      : [];
  if (Array.isArray(rawMemories)) {
    for (const item of rawMemories) {
      if (!item || typeof item !== 'object') continue;
      const candidate = item as Record<string, unknown>;
      const text = asString(candidate.text || candidate.memory).trim();
      if (!text) continue;
      memories.push({
        text,
        reason: asString(candidate.reason).trim(),
        confidence: asString(candidate.confidence).trim().toLowerCase(),
      });
    }
  }
  return {
    memories,
    rolloutSummary: asString(record.rolloutSummary || record.rollout_summary || record.summary).trim(),
    rolloutSlug: asString(record.rolloutSlug || record.rollout_slug || record.slug).trim(),
    summary: asString(record.summary).trim(),
  };
}

function parseMemoryConsolidationOutput(raw: string): MemoryConsolidationOutput {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') {
    return {};
  }
  const record = parsed as Record<string, unknown>;
  return {
    memoryMd: asString(record.memoryMd || record.memory_md || record.memory).trim(),
    summaryMd: asString(record.summaryMd || record.summary_md || record.memorySummary || record.memory_summary).trim(),
    summary: asString(record.summary).trim(),
  };
}

function normalizeMemorySummary(summary: string): string {
  const redacted = redactMemorySecrets(summary).trim();
  if (!redacted) return '';
  return redacted.startsWith('#')
    ? `${redacted}\n`
    : `# Aegis Built-in Agent Memory Summary\n\n${redacted}\n`;
}

function normalizeMemoryCandidate(candidate: AutoMemoryCandidate): AutoMemoryCandidate | null {
  const text = redactMemorySecrets(candidate.text || '').replace(/\s+/g, ' ').trim();
  if (text.length < 16) return null;
  const confidence = (candidate.confidence || 'medium').toLowerCase();
  if (confidence === 'low') return null;
  return {
    text: text.slice(0, 800),
    reason: redactMemorySecrets(candidate.reason || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    confidence: confidence === 'high' ? 'high' : 'medium',
  };
}

function memoryAlreadyExists(existing: string, text: string): boolean {
  const normalizedExisting = existing.toLowerCase();
  const normalizedText = text.toLowerCase();
  if (normalizedExisting.includes(normalizedText)) return true;
  return normalizedExisting.includes(normalizedText.slice(0, Math.min(140, normalizedText.length)));
}

function normalizeMemoryDocument(memoryMd: string): string {
  const redacted = redactMemorySecrets(memoryMd).trim();
  if (!redacted) return '';
  return redacted.startsWith('#')
    ? `${redacted}\n`
    : `# Aegis Built-in Agent Memory\n\n${redacted}\n`;
}

function contentBlocksToMemoryText(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'text') {
        return block.text;
      }
      if (block.type === 'tool_use') {
        let input = '';
        try {
          input = JSON.stringify(block.input);
        } catch {
          input = '';
        }
        return `Tool use: ${block.name}${input ? ` ${truncateMiddle(input, 900)}` : ''}`;
      }
      if (block.type === 'tool_result') {
        const output = getSerializedToolResultOutput(block.content);
        return `Tool result (${block.is_error ? 'error' : 'ok'}): ${truncateMiddle(output, 1600)}`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function streamMessageToMemoryText(message: StreamMessage): string {
  if (message.type === 'stream_event') {
    return '';
  }
  if (message.type === 'user_prompt') {
    return `User prompt:\n${message.prompt || ''}`.trim();
  }
  if (message.type === 'user') {
    return `User:\n${contentBlocksToMemoryText(message.message.content)}`.trim();
  }
  if (message.type === 'assistant') {
    return `Assistant:\n${contentBlocksToMemoryText(message.message.content)}`.trim();
  }
  if (message.type === 'system') {
    if (message.subtype === 'init') {
      return `Session init: model=${message.model || ''} cwd=${message.cwd || ''}`;
    }
    if (message.subtype === 'compact_boundary') {
      return 'System: conversation compacted';
    }
    return '';
  }
  if (message.type === 'result') {
    return `Result: ${message.subtype || 'unknown'}`;
  }
  return '';
}

function buildMemoryRolloutTranscript(input: {
  sessionId: string;
  agentId: string;
  cwd: string;
  history: StreamMessage[];
}): string {
  const body = input.history
    .map(streamMessageToMemoryText)
    .filter(Boolean)
    .join('\n\n---\n\n');
  return truncateMiddle(
    redactMemorySecrets([
      `session_id: ${input.sessionId}`,
      `agent_id: ${input.agentId}`,
      `cwd: ${input.cwd}`,
      '',
      body || '(empty session history)',
    ].join('\n')),
    AUTO_MEMORY_TRANSCRIPT_CHARS
  );
}

async function extractBuiltinMemoryCandidates(input: {
  sessionId: string;
  agentId: string;
  cwd: string;
  selection: BuiltinModelSelection;
}): Promise<AutoMemoryOutput> {
  const history = getSessionHistory(input.sessionId);
  if (history.length === 0) {
    return { memories: [], rolloutSummary: '', rolloutSlug: '' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTO_MEMORY_TIMEOUT_MS);
  try {
    const transcript = buildMemoryRolloutTranscript({
      sessionId: input.sessionId,
      agentId: input.agentId,
      cwd: input.cwd,
      history,
    });
    const raw = await completeChatText({
      selection: input.selection,
      signal: controller.signal,
      maxOutputTokens: 1400,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: [
            'You are stage one of Aegis Built-in Agent memory, modeled after Codex memory extraction.',
            'Read one completed rollout/session transcript and extract raw durable memory candidates only.',
            'The main agent cannot write memory. This background worker may only return candidates for later consolidation.',
            'Memory is scoped to the built-in agent profile, not to a project directory. If a fact only applies to one repository or path, include that repository/path explicitly in the memory text.',
            'Keep stable user preferences, durable product decisions, recurring workflows, repo-specific lessons, and bug/root-cause findings that will likely help a future session.',
            'Drop transient chatter, generic summaries, command output, secrets, tokens, passwords, API keys, and private personal data.',
            'Return strict JSON only: {"memories":[{"text":"...","reason":"...","confidence":"high|medium|low"}],"rolloutSummary":"one concise sentence or empty","rolloutSlug":"short-kebab-slug-or-empty"}.',
            'Use at most 8 memories. If nothing is worth remembering, return {"memories":[],"rolloutSummary":"","rolloutSlug":""}.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: transcript,
        },
      ],
    });
    return parseAutoMemoryOutput(raw);
  } finally {
    clearTimeout(timeout);
  }
}

async function consolidateBuiltinMemory(input: {
  memoryRoot: string;
  agentId: string;
  selection: BuiltinModelSelection;
}): Promise<void> {
  await ensureAgentMemoryFiles(input.memoryRoot);
  const memoryPath = join(input.memoryRoot, 'memory.md');
  const summaryPath = join(input.memoryRoot, 'memory_summary.md');
  const currentMemory = await readOptionalText(memoryPath);
  const currentSummary = await readOptionalText(summaryPath);
  const allCandidates = listUnconsolidatedBuiltinMemoryCandidates(
    input.agentId,
    AUTO_MEMORY_CONSOLIDATION_CANDIDATES
  );
  if (allCandidates.length === 0) return;

  const existingCorpus = `${currentSummary}\n\n${currentMemory}`;
  const candidates = allCandidates.filter((candidate) => !memoryAlreadyExists(existingCorpus, candidate.text));
  if (candidates.length === 0) {
    completeBuiltinMemoryConsolidation({
      agentId: input.agentId,
      candidateIds: allCandidates.map((candidate) => candidate.id),
      sessionIds: allCandidates.map((candidate) => candidate.session_id),
    });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTO_MEMORY_TIMEOUT_MS);
  try {
    const raw = await completeChatText({
      selection: input.selection,
      signal: controller.signal,
      maxOutputTokens: 3600,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: [
            'You are stage two of Aegis Built-in Agent memory, modeled after Codex memory consolidation.',
            'Merge raw memory candidates into the existing memory files for one built-in agent profile.',
            'The memory is agent-profile scoped, not project-scoped. Preserve project-specific qualifiers in the memory text instead of creating separate project memory.',
            'Return complete replacement contents for both files. Preserve useful existing memories, remove duplicates, fold new candidates into the right section, and keep the result concise.',
            'Do not store secrets, tokens, API keys, passwords, private personal data, generic one-off facts, or transient command output.',
            'Return strict JSON only: {"memoryMd":"complete memory.md markdown","summaryMd":"complete memory_summary.md markdown"}.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `Memory root: ${input.memoryRoot}`,
            `Agent id: ${input.agentId}`,
            '',
            'Current memory summary:',
            trimMemorySection(currentSummary, AUTO_MEMORY_SUMMARY_CHARS) || '(empty)',
            '',
            'Current memory document:',
            trimMemorySection(currentMemory, AUTO_MEMORY_SUMMARY_CHARS * 2) || '(empty)',
            '',
            'Unconsolidated raw memory candidates:',
            candidates.map((candidate, index) => [
              `${index + 1}. id=${candidate.id}`,
              `   text=${candidate.text}`,
              candidate.reason ? `   reason=${candidate.reason}` : '',
              candidate.confidence ? `   confidence=${candidate.confidence}` : '',
            ].filter(Boolean).join('\n')).join('\n\n'),
          ].join('\n'),
        },
      ],
    });

    const output = parseMemoryConsolidationOutput(raw);
    const nextMemory = normalizeMemoryDocument(output.memoryMd || '');
    const nextSummary = normalizeMemorySummary(output.summaryMd || output.summary || '');
    if (!nextMemory || !nextSummary) {
      throw new Error('Memory consolidation worker returned incomplete JSON.');
    }
    if (nextMemory.trim() !== currentMemory.trim()) {
      await writeFile(memoryPath, nextMemory, 'utf-8');
    }
    if (nextSummary && nextSummary.trim() !== currentSummary.trim()) {
      await writeFile(summaryPath, nextSummary, 'utf-8');
    }
    completeBuiltinMemoryConsolidation({
      agentId: input.agentId,
      candidateIds: allCandidates.map((candidate) => candidate.id),
      sessionIds: allCandidates.map((candidate) => candidate.session_id),
    });
  } catch (error) {
    if (!(error instanceof Error && error.name === 'AbortError')) {
      const message = error instanceof Error ? error.message : String(error);
      failBuiltinMemoryConsolidation({ agentId: input.agentId, error: message });
      console.warn('Aegis Built-in Agent memory consolidation failed:', error);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function runBuiltinMemoryPipelineForSession(input: {
  sessionId: string;
  agentId: string;
  memoryRoot: string;
  cwd: string;
  selection: BuiltinModelSelection;
}): Promise<void> {
  if (!isAutomaticMemoryEnabled()) return;
  const rollout = beginBuiltinMemoryRollout(input.sessionId);
  if (!rollout) return;

  try {
    const output = await extractBuiltinMemoryCandidates(input);
    const candidates = (output.memories || [])
      .map(normalizeMemoryCandidate)
      .filter((candidate): candidate is AutoMemoryCandidate => Boolean(candidate));
    completeBuiltinMemoryExtraction({
      sessionId: input.sessionId,
      agentId: input.agentId,
      rolloutSummary: output.rolloutSummary || output.summary || '',
      rolloutSlug: output.rolloutSlug || '',
      candidates,
    });
    await consolidateBuiltinMemory({
      memoryRoot: input.memoryRoot,
      agentId: input.agentId,
      selection: input.selection,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failBuiltinMemoryRollout(input.sessionId, message);
    if (!(error instanceof Error && error.name === 'AbortError')) {
      console.warn('Aegis Built-in Agent memory extraction failed:', error);
    }
  }
}

const activeMemoryPipelines = new Map<string, Promise<void>>();

function scheduleBuiltinMemoryPipeline(input: {
  sessionId: string;
  agentId: string;
  memoryRoot: string;
  cwd: string;
  selection: BuiltinModelSelection;
}): void {
  if (!isAutomaticMemoryEnabled()) return;
  try {
    enqueueBuiltinMemoryRollout({
      sessionId: input.sessionId,
      agentId: input.agentId,
      model: input.selection.encodedModel,
    });
  } catch (error) {
    console.warn('Aegis Built-in Agent memory enqueue failed:', error);
    return;
  }

  const previous = activeMemoryPipelines.get(input.agentId) || Promise.resolve();
  let pipeline: Promise<void>;
  pipeline = previous
    .catch(() => undefined)
    .then(async () => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
      await runBuiltinMemoryPipelineForSession(input);
    })
    .finally(() => {
      if (activeMemoryPipelines.get(input.agentId) === pipeline) {
        activeMemoryPipelines.delete(input.agentId);
      }
    });
  activeMemoryPipelines.set(input.agentId, pipeline);
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
    messages: serializeMessagesForProvider(input.messages, input.selection),
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

async function completeChatText(input: {
  messages: ChatMessage[];
  selection: BuiltinModelSelection;
  signal: AbortSignal;
  temperature?: number;
  maxOutputTokens?: number;
}): Promise<string> {
  const apiKey = input.selection.apiKey;
  if (!apiKey && input.selection.providerId !== 'local') {
    throw new Error('Aegis Built-in Agent memory worker requires an API key.');
  }
  const providerExtras = buildProviderRequestExtras(input.selection);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const body: Record<string, unknown> = {
    model: input.selection.modelId,
    messages: serializeMessagesForProvider(input.messages, input.selection),
    stream: false,
    max_tokens: input.maxOutputTokens || 900,
  };
  if (!providerExtras.omitTemperature) {
    body.temperature = input.temperature ?? 0.1;
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
    throw new Error(`Memory worker request failed with ${response.status}${detail ? `: ${detail.slice(0, 800)}` : ''}`);
  }
  const parsed = await response.json() as {
    choices?: Array<{
      message?: { content?: string | null };
      text?: string | null;
    }>;
  };
  const choice = parsed.choices?.[0];
  return (choice?.message?.content || choice?.text || '').trim();
}

class AegisBuiltinAgentSession {
  private children = new Set<ChildProcess>();
  private permissionMode: AegisPermissionMode;
  private readonly memoryRoot: string;
  private readonly memoryAgentId: string;
  private todos: BuiltinTodoItem[] = [];
  private core: AegisBuiltinAgentCore | null = null;
  private coreCwd: string | null = null;
  private tools: BuiltinToolRegistryEntry[] = [];
  private currentSelection: BuiltinModelSelection;
  private currentMemoryPrompt = '';
  private currentSkillsPrompt = '';
  private currentCwd: string;
  private lastUsage: Usage | undefined;
  private allowForSession = false;
  private dependencyEnv = new Map<string, string>();

  constructor(private readonly options: RunnerOptions, private readonly abortController: AbortController) {
    this.currentCwd = options.session.cwd || process.cwd();
    this.currentSelection = resolveBuiltinSelection(
      options.model || options.session.model,
      options.aegisReasoningEffort
    );
    this.permissionMode = normalizePermissionMode(options.aegisPermissionMode);
    this.memoryRoot = getAgentMemoryRoot(options.session);
    this.memoryAgentId = options.session.agent_id?.trim() || 'default';
  }

  private getPermissionMode = (): AegisPermissionMode => this.permissionMode;

  private setPermissionMode = (mode: AegisPermissionMode): void => {
    this.permissionMode = normalizePermissionMode(mode);
  };

  private getBuiltinPermissionMode = (): BuiltinPermissionMode => {
    if (this.permissionMode === 'readOnly') return 'plan';
    if (this.permissionMode === 'fullAccess' || this.allowForSession) return 'bypassPermissions';
    return 'default';
  };

  private setBuiltinPermissionMode = (mode: BuiltinPermissionMode): void => {
    this.permissionMode =
      mode === 'plan'
        ? 'readOnly'
        : mode === 'bypassPermissions'
          ? 'fullAccess'
          : 'defaultPermissions';
  };

  private recordPermissionDecision = (result: PermissionResult): PermissionResult => {
    if (result.behavior === 'allow' && result.scope === 'session') {
      this.allowForSession = true;
    }
    return result;
  };

  private getTodos = (): BuiltinTodoItem[] => this.todos.map((todo) => ({ ...todo }));

  private setTodos = (todos: BuiltinTodoItem[]): void => {
    this.todos = todos.map((todo) => ({ ...todo }));
    this.emitTodos(this.todos);
  };

  private emitTodos(todos: BuiltinTodoItem[]): void {
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

  private scheduleAutomaticMemoryUpdate(input: {
    cwd: string;
    selection: BuiltinModelSelection;
  }): void {
    if (this.abortController.signal.aborted) {
      return;
    }
    scheduleBuiltinMemoryPipeline({
      sessionId: this.options.session.id,
      agentId: this.memoryAgentId,
      memoryRoot: this.memoryRoot,
      cwd: input.cwd,
      selection: input.selection,
    });
  }

  abort(): void {
    this.abortController.abort();
    for (const child of this.children) {
      child.kill('SIGTERM');
    }
    this.children.clear();
  }

  private createMemoryAdapter(): BuiltinMemoryAdapter {
    return {
      readSummary: async () => {
        await ensureAgentMemoryFiles(this.memoryRoot);
        const summaryPath = join(this.memoryRoot, 'memory_summary.md');
        const content = trimMemorySection(await readOptionalText(summaryPath));
        return content
          ? `# Built-in agent memory summary\nPath: ${summaryPath}\n\n${content}`
          : 'No built-in agent memory summary is available.';
      },
      search: async (query, limit) => searchAgentMemory(this.memoryRoot, query, limit),
    };
  }

  private createApprovalController(): BuiltinApprovalController {
    return {
      requestCommand: async ({ id, command, cwd }) => {
        const mode = this.getBuiltinPermissionMode();
        if (mode === 'bypassPermissions') return { behavior: 'allow' };
        if (mode === 'plan') return { behavior: 'deny', message: 'Aegis Built-in Agent is in read-only mode.' };
        const result = await this.options.onPermissionRequest(id, 'bash', {
          kind: 'codex-approval',
          approvalKind: 'command',
          method: 'aegis.builtin.bash',
          title: 'Run command',
          question: `Allow Aegis Built-in Agent to run this command?\n\n${command}`,
          toolName: 'bash',
          command,
          cwd,
          canAllowForSession: true,
        });
        return this.recordPermissionDecision(result);
      },
      requestFileChange: async ({ id, toolName, title, question, filePath, summary }) => {
        const mode = this.getBuiltinPermissionMode();
        if (mode === 'bypassPermissions') return { behavior: 'allow' };
        if (mode === 'plan') return { behavior: 'deny', message: 'Aegis Built-in Agent is in read-only mode.' };
        const result = await this.options.onPermissionRequest(id, toolName, {
          kind: 'codex-approval',
          approvalKind: 'file-change',
          method: `aegis.builtin.${toolName}`,
          title,
          question,
          toolName,
          cwd: this.currentCwd,
          filePath,
          files: [filePath],
          permissionSummary: summary,
          canAllowForSession: true,
        });
        return this.recordPermissionDecision(result);
      },
    };
  }

  private createPlanController(): BuiltinPlanController {
    return {
      getMode: this.getBuiltinPermissionMode,
      setMode: this.setBuiltinPermissionMode,
      approvePlan: async (plan) => {
        const result = await this.options.onPermissionRequest(`aegis-plan-${randomUUID()}`, 'exit_plan_mode', {
          kind: 'codex-approval',
          approvalKind: 'permissions',
          method: 'aegis.builtin.exit_plan_mode',
          title: 'Approve plan',
          question: 'Approve this plan and let Aegis Built-in Agent execute it?',
          toolName: 'exit_plan_mode',
          cwd: this.currentCwd,
          permissionSummary: plan.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 12),
          canAllowForSession: true,
        });
        return this.recordPermissionDecision(result);
      },
    };
  }

  private createQuestionController(): BuiltinQuestionController {
    return {
      ask: async (input) => this.options.onPermissionRequest(`aegis-question-${randomUUID()}`, 'question', input),
    };
  }

  private async resolveSkillDependencies(
    skillOutcome: ReturnType<typeof getAegisSkills>['outcome'],
    selectedSkills?: ProviderInputReference[]
  ): Promise<string> {
    if (!selectedSkills?.length) return '';
    const missing: Array<{ skillName: string; name: string; description?: string }> = [];
    for (const reference of selectedSkills) {
      const skill = skillOutcome.skills.find((item) => item.path === reference.path || item.name === reference.name);
      if (!skill) continue;
      for (const dependency of skill.dependencies?.tools || []) {
        if (dependency.type !== 'env') continue;
        if (process.env[dependency.value] || this.dependencyEnv.has(dependency.value)) continue;
        missing.push({ skillName: skill.name, name: dependency.value, description: dependency.description });
      }
    }
    if (missing.length === 0) return '';

    const questions = missing.map((dependency) => ({
      header: 'Skill dependency',
      question: `The skill "${dependency.skillName}" requires environment variable "${dependency.name}"${dependency.description ? ` (${dependency.description})` : ''}. Enter a session-only value or cancel to continue without it.`,
      options: [],
    }));
    const result = await this.options.onPermissionRequest(`aegis-skill-deps-${randomUUID()}`, 'question', { questions });
    if (result.behavior !== 'allow') {
      return [
        '## Skill Dependencies',
        'The user declined to provide one or more skill dependencies. Continue without assuming those credentials are available.',
      ].join('\n');
    }
    const answers = (result.updatedInput as { answers?: Record<string, string> } | undefined)?.answers || {};
    for (const dependency of missing) {
      const question = questions.find((item) => item.question.includes(`"${dependency.name}"`));
      const answer = question ? answers[question.question]?.trim() : '';
      if (answer) this.dependencyEnv.set(dependency.name, answer);
    }
    const available = missing
      .filter((dependency) => process.env[dependency.name] || this.dependencyEnv.has(dependency.name))
      .map((dependency) => `- ${dependency.name}`);
    return available.length > 0
      ? ['## Skill Dependencies', 'The following skill dependency values are available for this session only:', ...available].join('\n')
      : '';
  }

  private createAgentCore(cwd: string): { core: AegisBuiltinAgentCore; tools: BuiltinToolRegistryEntry[] } {
    let tools: BuiltinToolRegistryEntry[] = [];
    const toolSearchController = {
      listDeferred: () => this.core?.listDeferredTools() ?? tools.filter((tool) => tool.deferred),
      unlock: (names: string[]) => this.core?.unlockDeferredTools(names),
    };
    tools = createBuiltinTools(cwd, {
      children: this.children,
      approvalController: this.createApprovalController(),
      memoryAdapter: this.createMemoryAdapter(),
      todoStore: {
        getTodos: this.getTodos,
        setTodos: this.setTodos,
      },
      planController: this.createPlanController(),
      questionController: this.createQuestionController(),
      toolSearchController,
      lspAdapter: createStaticLspAdapter(this.abortController.signal, this.children),
      skillAdapter: createAegisSkillAdapter(cwd),
    });

    const callbacks: BuiltinAgentCallbacks = {
      onText: (text) => this.options.onMessage(buildStreamDelta(text)),
      onReasoning: (text) => this.options.onMessage(buildReasoningDelta(text)),
      onStreamStop: () => this.options.onMessage(buildStreamStop()),
      onAssistantMessage: (blocks) => this.options.onMessage(buildAssistantMessage(blocks)),
      onToolResult: (toolCallId, content, isError, metadata) =>
        this.options.onMessage(buildUserToolResult(toolCallId, content, isError, metadata)),
    };

    const core = new AegisBuiltinAgentCore({
      cwd,
      tools,
      callbacks,
      signal: this.abortController.signal,
      getPermissionMode: this.getBuiltinPermissionMode,
      getSystemPrompt: ({ toolNames }) => buildSystemPrompt({
        cwd,
        model: this.currentSelection.modelId,
        permissionMode: this.permissionMode,
        toolNames,
        memoryPrompt: this.currentMemoryPrompt,
        skillsPrompt: this.currentSkillsPrompt,
        todos: this.getTodos(),
      }),
      complete: async (input) => {
        const result = await streamChatCompletion({
          messages: input.messages as ChatMessage[],
          selection: this.currentSelection,
          tools: input.tools.map(toOpenAiToolDefinition),
          signal: input.signal,
          onText: input.onText,
          onReasoning: input.onReasoning,
        });
        this.lastUsage = result.usage || this.lastUsage;
        return result;
      },
    });
    this.core = core;
    this.coreCwd = cwd;
    this.tools = tools;
    return { core, tools };
  }

  async runTurn(
    prompt: string,
    attachments?: Attachment[],
    modelOverride?: string,
    selectedSkills?: ProviderInputReference[],
    permissionModeOverride?: AegisPermissionMode,
    reasoningEffortOverride?: 'high' | 'max'
  ): Promise<void> {
    const startedAt = Date.now();
    const cwd = this.options.session.cwd || process.cwd();
    const selection = resolveBuiltinSelection(
      modelOverride || this.options.model || this.options.session.model,
      reasoningEffortOverride || this.options.aegisReasoningEffort
    );
    this.currentCwd = cwd;
    this.currentSelection = selection;
    if (permissionModeOverride) {
      this.allowForSession = false;
    }
    this.permissionMode = normalizePermissionMode(permissionModeOverride || this.options.aegisPermissionMode || this.permissionMode);
    const userContent = `${prompt}${attachmentText(attachments)}`;
    this.currentMemoryPrompt = await buildAgentMemoryPrompt(this.memoryRoot);
    const skillOutcome = getAegisSkills(cwd).outcome;
    const renderedSkills = renderAvailableSkills(skillOutcome);
    const effectiveSelectedSkills = [
      ...(selectedSkills || []),
      ...collectImplicitSkillReferences(skillOutcome, userContent),
    ];
    const skillInjections = buildSkillInjections(skillOutcome, effectiveSelectedSkills);
    const skillDependencyPrompt = await this.resolveSkillDependencies(skillOutcome, effectiveSelectedSkills);
    this.currentSkillsPrompt = renderedSkills?.prompt || '';
    if (!this.core || this.coreCwd !== cwd) {
      this.createAgentCore(cwd);
    }
    const core = this.core;
    if (!core) {
      throw new Error('Aegis built-in agent core failed to initialize.');
    }
    const visibleTools = this.tools;

    this.options.onMessage({
      type: 'system',
      subtype: 'init',
      session_id: `aegis:${this.options.session.id}`,
      model: selection.encodedModel,
      permissionMode: this.permissionMode,
      cwd,
      tools: visibleTools.map((tool) => tool.name),
    });

    const skillWarnings = [
      renderedSkills?.warning ? `Skills warning: ${renderedSkills.warning}` : '',
      ...skillInjections.warnings.map((warning) => `Skills warning: ${warning}`),
    ].filter(Boolean);
    const effectiveUserContent = [
      userContent,
      skillWarnings.length > 0 ? skillWarnings.join('\n') : '',
      skillDependencyPrompt,
      skillInjections.prompt,
    ].filter((part) => part.trim()).join('\n\n');
    await core.runTurn(effectiveUserContent);
    this.options.onMessage({
      type: 'result',
      subtype: 'success',
      duration_ms: Date.now() - startedAt,
      total_cost_usd: 0,
      usage: this.lastUsage || {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    this.scheduleAutomaticMemoryUpdate({
      cwd,
      selection,
    });
  }
}

export const aegisRuntime: AgentRuntime = {
  id: 'aegis',
  displayName: 'Aegis Built-in Agent',
  run: (options) => {
    const abortController = new AbortController();
    const session = new AegisBuiltinAgentSession(options, abortController);

    session.runTurn(
      options.prompt,
      options.attachments,
      options.model,
      options.aegisSkills,
      options.aegisPermissionMode,
      options.aegisReasoningEffort
    ).catch((error) => {
      if (!abortController.signal.aborted) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    });

    return {
      abort: () => session.abort(),
      send: (prompt, attachments, model, _codexSkills, _codexMentions, aegisSkills, _aegisMentions, sendOptions) => {
        if (abortController.signal.aborted) return;
        session.runTurn(
          prompt,
          attachments,
          model,
          aegisSkills,
          sendOptions?.aegisPermissionMode,
          sendOptions?.aegisReasoningEffort
        ).catch((error) => {
          if (!abortController.signal.aborted) {
            options.onError?.(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    };
  },
};
