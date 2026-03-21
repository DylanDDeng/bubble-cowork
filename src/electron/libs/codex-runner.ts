import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import type { RunnerOptions, RunnerHandle, StreamMessage, Attachment } from '../types';
import { isDev } from '../util';
import { getMcpServers } from './claude-settings';

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type PromptContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string };

type PromptCapabilities = {
  image?: boolean;
};

type SessionUpdate =
  | { sessionUpdate: 'agent_message_chunk'; content?: unknown }
  | { sessionUpdate: string; [key: string]: unknown };

interface AcpAdapter {
  id: 'codex' | 'opencode';
  label: string;
  command: string;
  getArgs: (model?: string) => string[];
  protocolVersion: string | number;
}

const ACP_CLIENT_INFO = {
  name: 'aegis',
  title: 'Aegis',
  version: '0.0.10',
};

const CODEX_ADAPTER: AcpAdapter = {
  id: 'codex',
  label: 'Codex',
  command: 'codex-acp',
  getArgs: (model) => (model ? ['-c', `model=${JSON.stringify(model)}`] : []),
  protocolVersion: 1,
};

const OPENCODE_ADAPTER: AcpAdapter = {
  id: 'opencode',
  label: 'OpenCode',
  command: 'opencode',
  // OpenCode's ACP command does not accept the global --model flag here.
  // Passing it causes the CLI to print subcommand help to stdout and exit.
  getArgs: () => ['acp'],
  protocolVersion: 1,
};

function buildAcpProcessEnv(adapter: AcpAdapter, selectedModel?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  if (adapter.id !== 'opencode' || !selectedModel) {
    return env;
  }

  let inlineConfig: Record<string, unknown> = {};
  const existingInlineConfig = env.OPENCODE_CONFIG_CONTENT;
  if (existingInlineConfig) {
    try {
      const parsed = JSON.parse(existingInlineConfig);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        inlineConfig = parsed as Record<string, unknown>;
      }
    } catch {
      // Ignore invalid inline config and replace it with a minimal valid override.
    }
  }

  env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
    ...inlineConfig,
    model: selectedModel,
  });

  return env;
}

class JsonRpcClient {
  private readonly pending = new Map<
    number,
    { method: string; resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private nextId = 1;
  private buffer = '';

  constructor(
    private readonly proc: ReturnType<typeof spawn>,
    private readonly onNotification: (method: string, params?: Record<string, unknown>) => void,
    private readonly onRequest: (id: number, method: string, params?: Record<string, unknown>) => void,
    private readonly onParseError: (line: string, err: Error) => void
  ) {
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk) => this.handleChunk(String(chunk)));
    proc.on('exit', () => this.rejectAllPending(new Error('ACP process exited')));
    proc.on('error', (err) => this.rejectAllPending(err instanceof Error ? err : new Error(String(err))));
  }

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    if (isDev()) {
      const keys = params ? Object.keys(params) : [];
      console.log('[ACP] ->', { id, method, keys });
    }
    this.send(payload);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const payload: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.send(payload);
  }

  respond(id: number, result?: Record<string, unknown>, error?: { code?: number; message?: string }): void {
    const payload: JsonRpcResponse = error
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result };
    this.send(payload);
  }

  private send(payload: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    if (this.proc.stdin?.writable) {
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    }
  }

  private handleChunk(chunk: string): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf('\n');
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) {
        this.handleLine(line);
      }
      idx = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let parsed: JsonRpcResponse & { method?: string; params?: Record<string, unknown> };
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.onParseError(line, error as Error);
      return;
    }

    if (parsed.method) {
      if (typeof parsed.id === 'number') {
        this.onRequest(parsed.id, parsed.method, parsed.params);
      } else {
        this.onNotification(parsed.method, parsed.params);
      }
      return;
    }

    if (typeof parsed.id === 'number') {
      const pending = this.pending.get(parsed.id);
      if (!pending) return;
      this.pending.delete(parsed.id);
      if (parsed.error) {
        const code = parsed.error.code;
        const message = parsed.error.message || 'JSON-RPC error';
        const data = parsed.error.data;
        const codePart = typeof code === 'number' ? ` (code ${code})` : '';
        const dataPart = data !== undefined ? `: ${safeStringify(data)}` : '';
        pending.reject(new Error(`${pending.method}: ${message}${codePart}${dataPart}`));
      } else {
        pending.resolve(parsed.result);
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

async function buildPromptContent(
  prompt: string,
  attachments: Attachment[] | undefined,
  capabilities: PromptCapabilities
): Promise<PromptContentBlock[]> {
  const allAttachments = attachments?.filter((a) => a && a.path) || [];
  const imageAttachments = allAttachments.filter((a) => a.kind === 'image');

  const lines: string[] = [prompt];
  if (allAttachments.length > 0) {
    lines.push('', 'Attachments:');
    for (const attachment of allAttachments) {
      lines.push(`- ${attachment.name}: ${attachment.path}`);
    }
  }

  const blocks: PromptContentBlock[] = [{ type: 'text', text: lines.join('\n') }];

  if (allAttachments.length === 0) {
    return blocks;
  }

  if (capabilities.image && imageAttachments.length > 0) {
    for (const image of imageAttachments) {
      try {
        const buffer = await readFile(image.path);
        blocks.push({
          type: 'image',
          mimeType: image.mimeType,
          data: buffer.toString('base64'),
        });
      } catch (error) {
        if (isDev()) {
          console.warn('[ACP Runner] Failed to read image attachment:', image.path, error);
        }
      }
    }
  }

  return blocks;
}

export function runCodex(options: RunnerOptions): RunnerHandle {
  return runAcp(options, CODEX_ADAPTER);
}

export function runOpenCode(options: RunnerOptions): RunnerHandle {
  return runAcp(options, OPENCODE_ADAPTER);
}

function runAcp(options: RunnerOptions, adapter: AcpAdapter): RunnerHandle {
  const { prompt, attachments, model, session, resumeSessionId, onMessage, onError, onPermissionRequest } = options;
  const abortController = new AbortController();
  const selectedModel = typeof model === 'string' && model.trim().length > 0 ? model.trim() : undefined;
  let currentSessionId = '';
  let streamingStarted = false;
  let assistantBuffer = '';
  let preTraceBuffer = '';
  let traceCandidateBuffer = '';
  let sawTraceActivity = false;
  let resultEmitted = false;
  let promptCapabilities: PromptCapabilities = {};
  const toolNameById = new Map<string, string>();
  const toolKindById = new Map<string, string>();
  let pendingFinalizeOnSessionInfo = false;

  const spawnArgs = adapter.getArgs(selectedModel);
  const env = buildAcpProcessEnv(adapter, selectedModel);
  const proc = spawn(adapter.command, spawnArgs, {
    cwd: session.cwd || process.cwd(),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (isDev()) {
    console.log(`[${adapter.label} Runner] spawned`, {
      command: adapter.command,
      cwd: session.cwd || process.cwd(),
      model: selectedModel,
      spawnArgs,
    });
  }

  proc.on('exit', (code, signal) => {
    if (!abortController.signal.aborted) {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      onError?.(new Error(`${adapter.label} ACP exited (${reason})`));
    }
  });

  proc.on('error', (error) => {
    if (!abortController.signal.aborted) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  });

  proc.stderr?.on('data', (chunk) => {
    const line = String(chunk).trim();
    if (line) {
      console.warn(`[${adapter.label} ACP]`, line);
    }
  });

  const client = new JsonRpcClient(
    proc,
    (method, params) => {
      if (method === 'session/update') {
        handleSessionUpdate(params);
      }
    },
    (id, method, params) => {
      const normalizedMethod = method.toLowerCase();
      if (
        normalizedMethod.includes('request_permission') ||
        normalizedMethod.includes('requestpermission') ||
        normalizedMethod.includes('permission/request')
      ) {
        void handlePermissionRequest(id, method, params);
        return;
      }

      if (isDev()) {
        console.warn(`[${adapter.label} ACP] Unhandled request from agent:`, { method });
      }
      client.respond(id, undefined, { code: -32601, message: `Method not supported: ${method}` });
    },
    (line, err) => {
      console.warn(`[${adapter.label} ACP] Failed to parse JSON:`, line.slice(0, 120), err);
    }
  );

  const ready = initializeAndCreateSession();
  let enqueueChain: Promise<void> = Promise.resolve();

  const enqueuePrompt = (text: string, promptAttachments?: Attachment[]) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    enqueueChain = enqueueChain
      .then(async () => {
        await ready;
        if (abortController.signal.aborted) return;
        await sendPrompt(trimmed, promptAttachments);
      })
      .catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error));
        onError?.(err);
      });
  };

  enqueuePrompt(prompt, attachments);

  const emitTraceNote = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    onMessage({
      type: 'assistant',
      uuid: uuidv4(),
      message: { content: [{ type: 'text', text: trimmed }] },
    });
  };

  const flushPreTraceToTrace = () => {
    if (!preTraceBuffer.trim()) {
      preTraceBuffer = '';
      return;
    }
    emitTraceNote(preTraceBuffer);
    preTraceBuffer = '';
  };

  const flushTraceCandidateToTrace = () => {
    if (!traceCandidateBuffer.trim()) {
      traceCandidateBuffer = '';
      return;
    }
    emitTraceNote(traceCandidateBuffer);
    traceCandidateBuffer = '';
  };

  const appendAssistantText = (text: string) => {
    if (!text) {
      return;
    }

    if (!sawTraceActivity) {
      preTraceBuffer += text;
      return;
    }

    traceCandidateBuffer += text;
  };

  const splitFinalCodexText = (
    text: string
  ): {
    traceText: string;
    finalText: string;
  } => {
    const trimmed = text.trim();
    if (!trimmed) {
      return { traceText: '', finalText: '' };
    }

    const metaLeadPattern =
      /^(我先|我看到|我找到|我读到|我再|我想|我把|我去|我会|我刚|如果我没理解错|let me|i'?ll|i will|i found|i checked|i reviewed|i traced|i looked|i read|i pulled|i'm going to)/i;
    const boundaryPatterns = [
      /\n\n(?=\*\*[^*\n]+\*\*)/,
      /\n\n(?=#+\s)/,
      /\n\n(?=-\s)/,
      /\n\n(?=\d+\.\s)/,
    ];

    let splitIndex = -1;
    for (const pattern of boundaryPatterns) {
      const match = pattern.exec(trimmed);
      if (match && (splitIndex === -1 || match.index < splitIndex)) {
        splitIndex = match.index;
      }
    }

    if (splitIndex <= 0) {
      return { traceText: '', finalText: trimmed };
    }

    const intro = trimmed.slice(0, splitIndex).trim();
    const remainder = trimmed.slice(splitIndex).trim();
    if (!intro || !remainder) {
      return { traceText: '', finalText: trimmed };
    }

    const introSentences = intro
      .split(/(?<=[。！？.!?])\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
    const metaSentenceCount = introSentences.filter((sentence) => metaLeadPattern.test(sentence)).length;
    const introLooksNarrative =
      metaLeadPattern.test(intro) ||
      (introSentences.length > 0 && metaSentenceCount >= Math.max(2, Math.ceil(introSentences.length / 2)));

    if (!introLooksNarrative || intro.length > 420) {
      return { traceText: '', finalText: trimmed };
    }

    return {
      traceText: intro,
      finalText: remainder,
    };
  };

  const beginTraceActivity = () => {
    if (!sawTraceActivity) {
      sawTraceActivity = true;
      flushPreTraceToTrace();
      return;
    }

    flushTraceCandidateToTrace();
  };

  const emitResult = (status: 'success' | 'cancelled' | 'error') => {
    if (resultEmitted || abortController.signal.aborted) {
      return;
    }
    resultEmitted = true;

    if (sawTraceActivity) {
      const split = splitFinalCodexText(traceCandidateBuffer);
      if (split.traceText) {
        emitTraceNote(split.traceText);
      }
      assistantBuffer = split.finalText;
      if (!assistantBuffer.trim() && !split.finalText.trim()) {
        flushTraceCandidateToTrace();
        assistantBuffer = '';
      }
    } else {
      assistantBuffer = preTraceBuffer;
    }

    if (assistantBuffer.trim()) {
      onMessage({
        type: 'assistant',
        uuid: uuidv4(),
        message: { content: [{ type: 'text', text: assistantBuffer }] },
      });
    }

    if (status === 'cancelled') {
      return;
    }

    onMessage({
      type: 'result',
      subtype: status === 'error' ? 'error' : 'success',
      duration_ms: 0,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  };

  async function initializeAndCreateSession(): Promise<void> {
    const initResult = (await client.request('initialize', {
      protocolVersion: adapter.protocolVersion,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: ACP_CLIENT_INFO,
    })) as Record<string, unknown> | undefined;

    const caps =
      (initResult?.agentCapabilities as Record<string, unknown>) ||
      (initResult?.capabilities as Record<string, unknown>) ||
      {};
    const promptCaps =
      (caps.promptCapabilities as Record<string, unknown>) ||
      (caps.prompt as Record<string, unknown>) ||
      {};
    promptCapabilities = { image: !!promptCaps.image };

    const cwd = session.cwd || process.cwd();
    const mcpServers =
      adapter.id === 'opencode'
        ? []
        : (getMcpServers(session.cwd ?? undefined) as Record<string, unknown>);
    let sessionResult: Record<string, unknown> | undefined;

    if (resumeSessionId) {
      try {
        sessionResult = (await client.request('session/load', {
          sessionId: resumeSessionId,
          id: resumeSessionId,
          cwd,
          mcpServers,
        })) as Record<string, unknown>;
      } catch (error) {
        if (isDev()) {
          console.warn(`[${adapter.label} ACP] Failed to load existing session, starting a new one.`, error);
        }
      }
    }

    if (!sessionResult) {
      sessionResult = (await client.request('session/new', {
        cwd,
        mcpServers,
      })) as Record<string, unknown>;
    }

    currentSessionId = String(sessionResult?.sessionId || sessionResult?.id || '');
    if (!currentSessionId) {
      throw new Error(`${adapter.label} ACP did not return a session id.`);
    }

    const initMessage: StreamMessage = {
      type: 'system',
      subtype: 'init',
      session_id: currentSessionId,
      model: selectedModel || '',
      permissionMode: '',
      cwd,
      tools: [],
    };
    onMessage(initMessage);
  }

  async function sendPrompt(text: string, promptAttachments?: Attachment[]): Promise<void> {
    const content = await buildPromptContent(text, promptAttachments, promptCapabilities);
    assistantBuffer = '';
    preTraceBuffer = '';
    traceCandidateBuffer = '';
    sawTraceActivity = false;
    streamingStarted = false;
    resultEmitted = false;
    toolNameById.clear();
    toolKindById.clear();
    pendingFinalizeOnSessionInfo = false;

    let result: Record<string, unknown> | undefined;
    try {
      result = (await client.request('session/prompt', {
        sessionId: currentSessionId,
        prompt: content,
      })) as Record<string, unknown>;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      onError?.(err);
      return;
    }

    if (abortController.signal.aborted) {
      return;
    }

    const stopReason = String(result?.stopReason || result?.stop_reason || '');
    const status = String(result?.status || '');
    const done = Boolean(result?.done || result?.completed);

    if (stopReason) {
      emitResult(stopReason === 'cancelled' ? 'cancelled' : 'success');
      return;
    }

    if (done || status) {
      emitResult(status === 'error' ? 'error' : 'success');
      return;
    }

    pendingFinalizeOnSessionInfo = true;
  }

  function handleSessionUpdate(params?: Record<string, unknown>): void {
    const update = (params?.update as SessionUpdate) || (params as SessionUpdate);
    if (!update) return;

    const updateType = typeof update.sessionUpdate === 'string' ? update.sessionUpdate.toLowerCase() : '';

    if (
      updateType === 'agent_message_chunk' ||
      updateType.includes('message_chunk') ||
      updateType.includes('message_delta')
    ) {
      let rawContent = update.content as { type?: string; text?: string; thinking?: string; content?: unknown } | undefined;
      if (rawContent?.type === 'content' && rawContent.content) {
        rawContent = rawContent.content as { type?: string; text?: string; thinking?: string };
      }
      const contentType = rawContent?.type;
      const text = rawContent?.text;
      const thinking = rawContent?.thinking;

      if (contentType === 'text' && typeof text === 'string') {
        appendAssistantText(text);
      }

      if (contentType === 'thinking' && typeof thinking === 'string') {
        beginTraceActivity();
      }
      return;
    }

    if (updateType === 'agent_message' || updateType.endsWith('agent_message')) {
      const text = extractText(update as Record<string, unknown>);
      if (text) {
        appendAssistantText(text);
      }
      return;
    }

    if (updateType === 'tool_call' || (updateType.includes('tool') && updateType.includes('call') && !updateType.includes('update'))) {
      beginTraceActivity();
      handleToolCall(update as Record<string, unknown>);
      return;
    }

    if (
      updateType === 'tool_call_update' ||
      (updateType.includes('tool') && (updateType.includes('update') || updateType.includes('result') || updateType.includes('complete')))
    ) {
      handleToolCallUpdate(update as Record<string, unknown>);
      return;
    }

    if (updateType === 'session_info_update' || updateType.includes('session_info')) {
      const completion = updateSignalsCompletion(update as Record<string, unknown>);
      if (completion) {
        pendingFinalizeOnSessionInfo = false;
        emitResult(completion === 'cancelled' ? 'cancelled' : 'success');
        return;
      }

      if (pendingFinalizeOnSessionInfo) {
        pendingFinalizeOnSessionInfo = false;
        emitResult('success');
      }
    }
  }

  function handleToolCall(update: Record<string, unknown>): void {
    const toolCallId = getToolCallId(update);
    if (!toolCallId) return;

    const rawKind = typeof update.kind === 'string' ? update.kind : '';
    const rawTitle = typeof update.title === 'string' ? update.title : '';
    const rawInput = update.rawInput ?? update.input ?? update.arguments ?? update.params;

    const { name, input } = mapToolCallToToolUse(rawKind, rawTitle, rawInput);
    toolNameById.set(toolCallId, name);
    toolKindById.set(toolCallId, rawKind);

    onMessage({
      type: 'assistant',
      uuid: uuidv4(),
      message: {
        content: [
          {
            type: 'tool_use',
            id: toolCallId,
            name,
            input,
          },
        ],
      },
    });
  }

  function handleToolCallUpdate(update: Record<string, unknown>): void {
    const toolCallId = getToolCallId(update);
    if (!toolCallId) return;

    const status = typeof update.status === 'string' ? update.status : '';
    const statusLower = status.toLowerCase();
    if (statusLower === 'in_progress' || statusLower === 'running' || statusLower === 'pending') {
      return;
    }

    const isError = statusLower.includes('fail') || statusLower.includes('error');
    const output =
      update.output ??
      update.rawOutput ??
      update.result ??
      update.message ??
      update.content ??
      (isError ? update.error : undefined);

    const content = formatToolOutput(output) || (isError ? 'Tool failed' : 'Done');

    onMessage({
      type: 'user',
      uuid: uuidv4(),
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolCallId,
            content,
            ...(isError ? { is_error: true } : {}),
          },
        ],
      },
    });

    toolNameById.delete(toolCallId);
    toolKindById.delete(toolCallId);
  }

  async function handlePermissionRequest(
    id: number,
    method: string,
    params?: Record<string, unknown>
  ): Promise<void> {
    const options = extractPermissionOptions(params);
    const question = buildPermissionQuestion(method, params, options);
    const toolUseId = uuidv4();

    try {
      const result = await onPermissionRequest(toolUseId, 'AskUserQuestion', {
        questions: [
          {
            header: adapter.label,
            question,
            options: options.map((option) => ({
              label: option.label,
              description: option.description,
            })),
          },
        ],
      });

      if (result.behavior !== 'allow') {
        client.respond(id, { outcome: { outcome: 'cancelled' } });
        return;
      }

      const answers = asRecord(result.updatedInput)?.answers as Record<string, string> | undefined;
      const selectedLabel = typeof answers?.[question] === 'string' ? answers[question] : undefined;
      const selectedOption =
        options.find((option) => option.label === selectedLabel) ||
        options.find((option) => /allow|yes/i.test(option.label)) ||
        options[0];

      if (!selectedOption?.optionId) {
        client.respond(id, { outcome: { outcome: 'cancelled' } });
        return;
      }

      client.respond(id, { outcome: { outcome: 'selected', optionId: selectedOption.optionId } });
    } catch (error) {
      if (isDev()) {
        console.warn(`[${adapter.label} ACP] Permission request failed`, error);
      }
      client.respond(id, { outcome: { outcome: 'cancelled' } });
    }
  }

  return {
    abort: () => {
      abortController.abort();
      if (currentSessionId) {
        client.notify('session/cancel', { sessionId: currentSessionId });
      }
      proc.kill();
    },
    send: (text, promptAttachments) => {
      enqueuePrompt(text, promptAttachments);
    },
  };
}

function safeStringify(value: unknown): string {
  try {
    if (typeof value === 'string') return value;
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getToolCallId(update: Record<string, unknown>): string | null {
  const candidate =
    update.toolCallId ??
    update.tool_call_id ??
    update.toolUseId ??
    update.tool_use_id;
  if (typeof candidate === 'string' && candidate.trim()) return candidate;
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function getFirstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function mapToolCallToToolUse(
  kind: string,
  title: string,
  rawInput: unknown
): { name: string; input: Record<string, unknown> } {
  const kindLower = kind.toLowerCase();
  const titleLower = title.toLowerCase();
  const inputRecord = asRecord(rawInput);

  const maybeCommand =
    inputRecord
      ? getFirstString(
          inputRecord.command,
          inputRecord.cmd,
          inputRecord.shellCommand,
          inputRecord.shell_command
        )
      : null;

  const maybePath =
    inputRecord
      ? getFirstString(
          inputRecord.file_path,
          inputRecord.path,
          inputRecord.file,
          inputRecord.filename,
          inputRecord.absolute_file_path
        )
      : null;

  if (
    kindLower.includes('execute') ||
    kindLower.includes('command') ||
    titleLower.includes('command') ||
    titleLower.includes('shell')
  ) {
    const command =
      maybeCommand ||
      (typeof rawInput === 'string' ? rawInput : null) ||
      (title ? title : '');
    const merged: Record<string, unknown> = inputRecord ? { ...inputRecord } : {};
    if (command) merged.command = command;
    return { name: 'Bash', input: merged };
  }

  if (kindLower.includes('read')) {
    const filePath = maybePath || (typeof rawInput === 'string' ? rawInput : null) || '';
    const merged: Record<string, unknown> = inputRecord ? { ...inputRecord } : {};
    if (filePath) merged.file_path = filePath;
    return { name: 'Read', input: merged };
  }

  if (kindLower.includes('write')) {
    const filePath = maybePath || '';
    const merged: Record<string, unknown> = inputRecord ? { ...inputRecord } : {};
    if (filePath) merged.file_path = filePath;
    return { name: 'Write', input: merged };
  }

  if (kindLower.includes('edit')) {
    const filePath = maybePath || '';
    const merged: Record<string, unknown> = inputRecord ? { ...inputRecord } : {};
    if (filePath) merged.file_path = filePath;
    return { name: 'Edit', input: merged };
  }

  if (kindLower.includes('delete') || kindLower.includes('remove')) {
    const filePath = maybePath || '';
    const merged: Record<string, unknown> = inputRecord ? { ...inputRecord } : {};
    if (filePath) merged.file_path = filePath;
    return { name: 'Delete', input: merged };
  }

  if (kindLower.includes('grep') || titleLower.includes('grep')) {
    const pattern =
      inputRecord ? getFirstString(inputRecord.pattern, inputRecord.query) : null;
    const merged: Record<string, unknown> = inputRecord ? { ...inputRecord } : {};
    if (pattern) merged.pattern = pattern;
    return { name: 'Grep', input: merged };
  }

  if (kindLower.includes('glob') || titleLower.includes('glob')) {
    const pattern =
      inputRecord ? getFirstString(inputRecord.pattern, inputRecord.glob) : null;
    const merged: Record<string, unknown> = inputRecord ? { ...inputRecord } : {};
    if (pattern) merged.pattern = pattern;
    return { name: 'Glob', input: merged };
  }

  const fallback: Record<string, unknown> = inputRecord ? { ...inputRecord } : {};
  if (!fallback.kind && kind) fallback.kind = kind;
  if (!fallback.title && title) fallback.title = title;
  if (!fallback.rawInput && rawInput !== undefined) fallback.rawInput = rawInput as never;
  return { name: kind || title || 'Tool', input: fallback };
}

function formatToolOutput(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) {
    const parts = value.map((item) => formatToolOutput(item)).filter(Boolean);
    return parts.join('\n');
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const stdout = typeof obj.stdout === 'string' ? obj.stdout : null;
    const stderr = typeof obj.stderr === 'string' ? obj.stderr : null;
    const exitCode = obj.exitCode ?? obj.exit_code ?? obj.code ?? obj.status;

    const lines: string[] = [];
    if (exitCode !== undefined && exitCode !== null) lines.push(`exitCode: ${String(exitCode)}`);
    if (stdout) lines.push(`stdout:\n${stdout}`);
    if (stderr) lines.push(`stderr:\n${stderr}`);
    if (lines.length > 0) return lines.join('\n');

    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

function extractText(update: Record<string, unknown>): string | null {
  const content = update.content ?? update.message ?? update.output;
  if (!content) return null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          if (typeof obj.text === 'string') return obj.text;
          if (typeof obj.content === 'string') return obj.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('');
    return parts || null;
  }
  if (typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (typeof obj.text === 'string') return obj.text;
    if (Array.isArray(obj.content)) {
      const parts = obj.content
        .map((item) => (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string' ? (item as { text: string }).text : ''))
        .filter(Boolean)
        .join('');
      return parts || null;
    }
  }
  return null;
}

function updateSignalsCompletion(update: Record<string, unknown>): 'success' | 'cancelled' | null {
  const rawType = String(update.sessionUpdate || update.type || update.kind || update.event || '').toLowerCase();
  if (rawType) {
    if (rawType.includes('cancel')) return 'cancelled';
    if (rawType.includes('complete') || rawType.includes('finish') || rawType.includes('done') || rawType.includes('end') || rawType.includes('stop')) {
      return 'success';
    }
  }

  const stopReason = String(update.stopReason || update.stop_reason || '');
  if (stopReason) {
    return stopReason === 'cancelled' ? 'cancelled' : 'success';
  }

  if (update.done === true || update.final === true || update.completed === true) {
    return 'success';
  }

  if (typeof update.status === 'string') {
    const status = update.status.toLowerCase();
    if (status.includes('cancel')) return 'cancelled';
    if (status.includes('complete') || status.includes('finish') || status.includes('done') || status.includes('end') || status.includes('success')) {
      return 'success';
    }
  }

  return null;
}

type PermissionChoice = {
  optionId: string;
  label: string;
  description?: string;
};

function extractPermissionOptions(params?: Record<string, unknown>): PermissionChoice[] {
  const raw =
    (params?.options as Array<Record<string, unknown>>) ||
    (params?.choices as Array<Record<string, unknown>>) ||
    [];

  return raw.reduce<PermissionChoice[]>((choices, option) => {
    const optionId = getFirstString(option.optionId, option.id, option.value);
    const label = getFirstString(option.label, option.name, option.title, option.optionId);
    const description = getFirstString(option.description, option.detail, option.message) || undefined;
    if (!optionId || !label) {
      return choices;
    }
    choices.push({ optionId, label, description });
    return choices;
  }, []);
}

function buildPermissionQuestion(
  method: string,
  params: Record<string, unknown> | undefined,
  options: PermissionChoice[]
): string {
  const directQuestion = getFirstString(
    params?.question,
    params?.prompt,
    params?.message,
    params?.title,
    params?.reason,
    params?.description
  );

  if (directQuestion) {
    return directQuestion;
  }

  if (options.length > 0) {
    return `Approve ${method}?`;
  }

  return `Respond to ${method}`;
}
