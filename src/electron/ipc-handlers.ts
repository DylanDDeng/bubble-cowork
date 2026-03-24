import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { readFileSync, statSync, watch, type FSWatcher, promises as fsPromises } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { basename, extname, resolve, relative, isAbsolute, join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import * as sessions from './libs/session-store';
import { runClaude } from './libs/runner';
import { runCodex, runOpenCode } from './libs/codex-runner';
import { generateSessionTitle, runClaudeOneShot } from './libs/util';
import { readProjectTree } from './libs/project-tree';
import { normalizeClaudeRequestedModel, reconcileClaudeDisplayModel } from './libs/claude-model-selection';
import { loadClaudeSettings, getClaudeSettings, getClaudeModelConfig, getMcpServers, getGlobalMcpServers, getProjectMcpServers, saveMcpServers, saveProjectMcpServers, type McpServerConfig } from './libs/claude-settings';
import {
  loadCompatibleProviderConfig,
  saveCompatibleProviderConfig,
} from './libs/compatible-provider-config';
import {
  deleteImportedFont,
  getFontSettings,
  importFontFile,
  listSystemFonts,
  saveFontSelections,
} from './libs/font-settings';
import { getCodexModelConfig, saveCodexModelVisibility } from './libs/codex-settings';
import { getCodexRuntimeStatus } from './libs/codex-runtime-status';
import { getOpencodeModelConfig, saveOpencodeModelVisibility } from './libs/opencode-settings';
import { getOpencodeRuntimeStatus } from './libs/opencode-runtime-status';
import {
  deletePromptLibraryItem,
  exportPromptLibraryFile,
  importPromptLibraryFile,
  listPromptLibraryItems,
  savePromptLibraryItem,
} from './libs/prompt-library';
import { expandClaudeSkillPrompt, listClaudeSkills } from './libs/claude-skills';
import { loadFeishuBridgeConfig, saveFeishuBridgeConfig } from './libs/feishu-bridge-config';
import { feishuBridge } from './libs/feishu-bridge';
import { formatClaudeRuntimeBlockingMessage, getClaudeRuntimeStatus } from './libs/claude-runtime-status';
import {
  getSkillMarketDetail,
  getSkillMarketHot,
  installSkillFromMarket,
  searchSkillMarket,
} from './libs/skill-market';
import * as statusConfig from './libs/status-config';
import * as folderConfig from './libs/folder-config';
import { ipcMainHandle, isDev } from './util';
import type {
  ClientEvent,
  ServerEvent,
  SessionInfo,
  StreamMessage,
  RunnerHandle,
  SessionState,
  PermissionResult,
  SessionStartPayload,
  SessionContinuePayload,
  PermissionRequestInput,
  PermissionResponsePayload,
  Attachment,
  SessionStatus,
} from './types';
import type {
  CreateStatusInput,
  ClaudeCompatibleProvidersConfig,
  ClaudeCompatibleProviderId,
  ClaudeUsageRangeDays,
  UpdateStatusInput,
  TodoState,
  FolderConfig,
  FontSettingsPayload,
  FeishuBridgeConfig,
  UpsertPromptLibraryItemInput,
} from '../shared/types';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_FILE_PREVIEW_BYTES = 5 * 1024 * 1024; // 5MB
const DIRECT_EDIT_BOOTSTRAP_MAX_TRANSCRIPT_CHARS = 20_000;

const ATTACHMENT_MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.log': 'text/plain',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

const projectWatchers = new Map<
  string,
  { watcher: FSWatcher; timer?: NodeJS.Timeout }
>();

function normalizeShellPath(filePath: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) {
    return trimmed;
  }

  if (trimmed === '~') {
    return app.getPath('home');
  }

  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(app.getPath('home'), trimmed.slice(2));
  }

  return trimmed;
}

function normalizeCodexPermissionMode(
  value?: string | null
): import('../shared/types').CodexPermissionMode {
  return value === 'fullAccess' || value === 'fullAuto'
    ? 'fullAccess'
    : 'defaultPermissions';
}

function normalizeClaudeAccessMode(
  value?: string | null
): import('../shared/types').ClaudeAccessMode {
  return value === 'fullAccess' ? 'fullAccess' : 'default';
}

type ProjectFilePreview =
  | {
      kind: 'text' | 'markdown' | 'html';
      path: string;
      name: string;
      ext: string;
      size: number;
      text: string;
      editable: boolean;
    }
  | {
      kind: 'image';
      path: string;
      name: string;
      ext: string;
      size: number;
      dataUrl: string;
    }
  | {
      kind: 'pdf';
      path: string;
      name: string;
      ext: string;
      size: number;
      dataBase64?: string;
      dataUrl?: string;
    }
  | {
      kind: 'pptx';
      path: string;
      name: string;
      ext: string;
      size: number;
      dataBase64: string;
    }
  | {
      kind: 'binary' | 'unsupported';
      path: string;
      name: string;
      ext: string;
      size: number;
    }
  | {
      kind: 'too_large';
      path: string;
      name: string;
      ext: string;
      size: number;
      maxBytes: number;
    }
  | {
      kind: 'error';
      path: string;
      name: string;
      ext: string;
      message: string;
    };

function isPathWithinRoot(rootPath: string, filePath: string): boolean {
  const root = resolve(rootPath);
  const target = resolve(filePath);
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function validateProjectFilePath(
  cwd: string,
  filePath: string
): Promise<{ ok: true; rootReal: string; targetReal: string } | { ok: false; message: string }> {
  if (!cwd || !filePath) {
    return { ok: false, message: 'Missing cwd or file path' };
  }

  if (!isPathWithinRoot(cwd, filePath)) {
    return { ok: false, message: 'File is outside the selected project folder' };
  }

  try {
    const [rootReal, targetReal] = await Promise.all([
      fsPromises.realpath(cwd),
      fsPromises.realpath(filePath),
    ]);
    if (!isPathWithinRoot(rootReal, targetReal)) {
      return { ok: false, message: 'File is outside the selected project folder' };
    }
    return { ok: true, rootReal, targetReal };
  } catch (error) {
    // realpath fails if file is missing; still keep the basic path containment check above.
    return { ok: true, rootReal: resolve(cwd), targetReal: resolve(filePath) };
  }
}

function getAttachmentSpec(filePath: string): { kind: Attachment['kind']; mimeType: string } | null {
  const ext = extname(filePath).toLowerCase();
  const mimeType = ATTACHMENT_MIME_TYPES[ext];
  if (!mimeType) {
    return null;
  }

  const kind: Attachment['kind'] = ext === '.png' || ext === '.jpg' || ext === '.jpeg' ? 'image' : 'file';
  return { kind, mimeType };
}


function normalizeModel(model?: string | null): string | undefined {
  return normalizeClaudeRequestedModel(model);
}

function normalizeBetas(betas?: string[] | null): string[] | undefined {
  if (!Array.isArray(betas)) {
    return undefined;
  }

  const normalized = betas
    .map((beta) => (typeof beta === 'string' ? beta.trim() : ''))
    .filter(Boolean);

  return normalized.length > 0 ? Array.from(new Set(normalized)) : undefined;
}

function parseStoredBetas(raw?: string | null): string[] | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw);
    return normalizeBetas(Array.isArray(parsed) ? parsed : undefined);
  } catch {
    return undefined;
  }
}

function parseSlashCommand(prompt: string): { name: string; args: string } | null {
  const trimmed = prompt.trim();
  const match = trimmed.match(/^\/([^\s]+)(?:\s+(.+))?$/);
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    args: match[2]?.trim() || '',
  };
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatProviderLabel(provider: SessionInfo['provider']): string {
  if (provider === 'codex') return 'Codex';
  if (provider === 'opencode') return 'OpenCode';
  return 'Claude Code';
}

function buildLocalAssistantMessage(text: string): StreamMessage {
  return {
    type: 'assistant',
    uuid: uuidv4(),
    message: {
      content: [{ type: 'text', text }],
    },
  };
}

function buildSessionCostSummary(session: ReturnType<typeof sessions.getSession>): string {
  if (!session) {
    return 'No active session found.';
  }

  const history = sessions.getSessionHistory(session.id);
  const resultMessages = history.filter(
    (message): message is StreamMessage & { type: 'result' } => message.type === 'result'
  );

  if (resultMessages.length === 0) {
    return [
      '**Session usage**',
      '',
      `- Provider: ${formatProviderLabel(session.provider)}`,
      `- Model: ${session.model || 'Unknown'}`,
      '- No completed turns with usage data yet.',
    ].join('\n');
  }

  const totalInputTokens = resultMessages.reduce(
    (sum, message) => sum + (message.usage?.input_tokens || 0),
    0
  );
  const totalOutputTokens = resultMessages.reduce(
    (sum, message) => sum + (message.usage?.output_tokens || 0),
    0
  );
  const totalTokens = totalInputTokens + totalOutputTokens;
  const totalCostUsd = resultMessages.reduce(
    (sum, message) => sum + (message.total_cost_usd || 0),
    0
  );
  const totalDurationMs = resultMessages.reduce(
    (sum, message) => sum + (message.duration_ms || 0),
    0
  );

  return [
    '**Session usage**',
    '',
    `- Provider: ${formatProviderLabel(session.provider)}`,
    `- Model: ${session.model || 'Unknown'}`,
    `- Completed turns: ${formatInteger(resultMessages.length)}`,
    `- Input tokens: ${formatInteger(totalInputTokens)}`,
    `- Output tokens: ${formatInteger(totalOutputTokens)}`,
    `- Total tokens: ${formatInteger(totalTokens)}`,
    `- Total duration: ${(totalDurationMs / 1000).toFixed(1)}s`,
    `- Total cost: $${totalCostUsd.toFixed(4)}`,
  ].join('\n');
}

function buildUnsupportedSlashCommandMessage(commandName: string): string {
  return [
    `\`/${commandName}\` is not implemented in Aegis yet.`,
    '',
    'This command is advertised from Claude Code slash commands, but this desktop app does not execute that built-in command yet.',
  ].join('\n');
}

function normalizeSlashName(name: string): string {
  return name.replace(/^\//, '').trim().toLowerCase();
}

function isZeroTokenResult(message: Extract<StreamMessage, { type: 'result' }>): boolean {
  return (
    (message.usage?.input_tokens || 0) === 0 &&
    (message.usage?.output_tokens || 0) === 0 &&
    (message.usage?.cache_creation_input_tokens || 0) === 0 &&
    (message.usage?.cache_read_input_tokens || 0) === 0
  );
}

function buildUnavailableClaudeSkillMessage(
  skillName: string,
  source: 'user' | 'project'
): string {
  const sourceLabel = source === 'project' ? 'workspace' : 'user-level';

  return [
    `\`/${skillName}\` was entered as a Claude skill, but this session did not load that ${sourceLabel} skill.`,
    '',
    'Aegis sent the prompt, but Claude initialized without the matching skill, so the command exited without producing a reply.',
    'Retry in a fresh Claude session. If it happens again, the skill list and the Claude runtime settings are out of sync.',
  ].join('\n');
}

function buildUnavailableSessionSlashMessage(commandName: string): string {
  return [
    `\`/${commandName}\` was interpreted as a slash command, but Claude did not load a matching command or skill for this session.`,
    '',
    'Use plain language instead, or pick a command or skill from the current slash menu before sending.',
  ].join('\n');
}

function detectSilentSlashCommandFailure(
  prompt: string,
  initMessage: Extract<StreamMessage, { type: 'system'; subtype: 'init' }> | null,
  resultMessage: Extract<StreamMessage, { type: 'result' }>,
  sawTurnOutput: boolean,
  cwd?: string | null
): string | null {
  if (resultMessage.subtype !== 'success' || sawTurnOutput || !isZeroTokenResult(resultMessage)) {
    return null;
  }

  const parsed = parseSlashCommand(prompt);
  if (!parsed) {
    return null;
  }

  const loadedCommands = new Set((initMessage?.slash_commands || []).map(normalizeSlashName));
  const loadedSkills = new Set((initMessage?.skills || []).map(normalizeSlashName));
  if (loadedCommands.has(parsed.name) || loadedSkills.has(parsed.name)) {
    return null;
  }

  const { userSkills, projectSkills } = listClaudeSkills(cwd ?? undefined);
  const matchingSkill = [...projectSkills, ...userSkills].find(
    (skill) => normalizeSlashName(skill.name) === parsed.name
  );
  if (matchingSkill) {
    return buildUnavailableClaudeSkillMessage(matchingSkill.name, matchingSkill.source);
  }

  return buildUnavailableSessionSlashMessage(parsed.name);
}

function extractAssistantText(message: StreamMessage): string {
  if (message.type !== 'assistant' || !message.message || !Array.isArray(message.message.content)) {
    return '';
  }

  return message.message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

function isLocalUtilityAssistantText(text: string): boolean {
  return (
    text.startsWith('**Session usage**') ||
    text.startsWith('**Context compacted**') ||
    text.startsWith('Compacting conversation...') ||
    text.startsWith('Failed to compact conversation') ||
    text.includes('Aegis yet.')
  );
}

function isInvalidThinkingBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return false;
  }

  const candidate = block as { type?: unknown; signature?: unknown };
  return (
    candidate.type === 'thinking' &&
    (typeof candidate.signature !== 'string' || candidate.signature.trim().length === 0)
  );
}

function sanitizeClaudeAssistantMessage(message: StreamMessage): {
  message: StreamMessage | null;
  removedInvalidThinking: boolean;
} {
  if (message.type !== 'assistant') {
    return { message, removedInvalidThinking: false };
  }

  const content = (message.message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return { message, removedInvalidThinking: false };
  }

  let removedInvalidThinking = false;
  const nextContent = content.filter((block) => {
    const shouldKeep = !isInvalidThinkingBlock(block);
    if (!shouldKeep) {
      removedInvalidThinking = true;
    }
    return shouldKeep;
  });

  if (!removedInvalidThinking) {
    return { message, removedInvalidThinking: false };
  }

  if (nextContent.length === 0) {
    return { message: null, removedInvalidThinking: true };
  }

  return {
    message: {
      ...message,
      message: {
        ...message.message,
        content: nextContent as typeof message.message.content,
      },
    },
    removedInvalidThinking: true,
  };
}

function sanitizeClaudeHistory(messages: StreamMessage[]): {
  messages: StreamMessage[];
  hadInvalidThinking: boolean;
  changed: boolean;
} {
  let hadInvalidThinking = false;
  let changed = false;
  const nextMessages: StreamMessage[] = [];

  for (const message of messages) {
    const sanitized = sanitizeClaudeAssistantMessage(message);
    if (sanitized.removedInvalidThinking) {
      hadInvalidThinking = true;
      changed = true;
    }
    if (sanitized.message) {
      nextMessages.push(sanitized.message);
    }
  }

  return {
    messages: changed ? nextMessages : messages,
    hadInvalidThinking,
    changed,
  };
}

function sanitizeStoredClaudeHistory(sessionId: string, messages: StreamMessage[]): {
  messages: StreamMessage[];
  hadInvalidThinking: boolean;
} {
  const sanitized = sanitizeClaudeHistory(messages);
  if (sanitized.changed) {
    sessions.replaceSessionHistory(sessionId, sanitized.messages);
    sessions.setClaudeSessionId(sessionId, null);
  }

  return {
    messages: sanitized.messages,
    hadInvalidThinking: sanitized.hadInvalidThinking,
  };
}

function buildHistoryTranscript(history: StreamMessage[]): string {
  const entries: string[] = [];

  for (const message of history) {
    if (message.type === 'user_prompt') {
      const prompt = message.prompt.trim();
      if (prompt) {
        entries.push(`[user]\n${prompt}`);
      }
      continue;
    }

    const assistantText = extractAssistantText(message);
    if (assistantText && !isLocalUtilityAssistantText(assistantText)) {
      entries.push(`[assistant]\n${assistantText}`);
    }
  }

  return entries.join('\n\n').trim();
}

function buildLatestEditSummaryPrompt(history: StreamMessage[]): string {
  const transcript = buildHistoryTranscript(history);
  const lines = [
    'You are helping Aegis rebuild a Claude Code conversation before the latest edited user turn.',
    'Do not continue the task. Do not ask questions. Do not use tools.',
    'Summarize the conversation state so a fresh Claude session can continue from this exact point.',
    '',
    'Preserve:',
    '- the user goal and expected deliverable',
    '- completed work and intermediate findings',
    '- important decisions, preferences, and constraints',
    '- relevant files, commands, and technical details',
    '- unresolved questions and next steps',
    '',
    'Conversation transcript:',
    transcript || '[No prior conversation context]',
    '',
    'Return only a summary wrapped in <summary></summary>.',
    'Do not include any text outside the summary tags.',
  ];

  return lines.join('\n');
}

function buildDirectEditBootstrapPrompt(params: {
  transcript: string;
  cwd?: string | null;
}): string {
  const lines = [
    'You are resuming an Aegis Claude Code conversation after the latest user message was edited.',
    'Treat the following transcript as the conversation state immediately before the edited user turn.',
    'Absorb the context so future turns can continue naturally from this point.',
    'Do not continue the task yet. Do not ask questions. Do not use tools.',
  ];

  if (params.cwd) {
    lines.push(`Project working directory: ${params.cwd}`);
  }

  lines.push(
    '',
    'Conversation transcript:',
    params.transcript || '[No prior conversation context]',
    '',
    'Do not repeat the transcript or summarize it back.',
    'Reply with exactly READY.'
  );

  return lines.join('\n');
}

async function bootstrapClaudeSessionFromHistory(params: {
  history: StreamMessage[];
  cwd?: string | null;
  model?: string | null;
  compatibleProviderId?: ClaudeCompatibleProviderId;
  betas?: string[];
}): Promise<{ sessionId: string; model?: string | null }> {
  const transcript = buildHistoryTranscript(params.history);
  const canDirectBootstrap =
    transcript.length > 0 &&
    transcript.length <= DIRECT_EDIT_BOOTSTRAP_MAX_TRANSCRIPT_CHARS;

  const bootstrapResult = canDirectBootstrap
    ? await runClaudeOneShot({
        prompt: buildDirectEditBootstrapPrompt({
          transcript,
          cwd: params.cwd,
        }),
        cwd: params.cwd ?? undefined,
        model: params.model || undefined,
        compatibleProviderId: params.compatibleProviderId,
        betas: params.betas,
      })
    : await (async () => {
        const summaryResult = await runClaudeOneShot({
          prompt: buildLatestEditSummaryPrompt(params.history),
          cwd: params.cwd ?? undefined,
          model: params.model || undefined,
          compatibleProviderId: params.compatibleProviderId,
          betas: params.betas,
        });
        const summary = extractSummaryContent(summaryResult.text);
        if (!summary) {
          throw new Error('Claude returned an empty bootstrap summary.');
        }

        return runClaudeOneShot({
          prompt: buildCompactBootstrapPrompt({
            summary,
            cwd: params.cwd,
            recentConversation: buildRecentConversationContext(params.history),
          }),
          cwd: params.cwd ?? undefined,
          model: summaryResult.model || params.model || undefined,
          compatibleProviderId: params.compatibleProviderId,
          betas: params.betas,
        });
      })();

  if (!bootstrapResult.sessionId) {
    throw new Error('Claude did not return a bootstrap session id.');
  }

  return {
    sessionId: bootstrapResult.sessionId,
    model: normalizeModel(bootstrapResult.model || params.model || undefined),
  };
}

function extractSummaryContent(text: string): string {
  const match = text.match(/<summary>([\s\S]*?)<\/summary>/i);
  return (match ? match[1] : text).trim();
}

function buildRecentConversationContext(history: StreamMessage[]): string {
  const recentEntries: string[] = [];

  for (let index = history.length - 1; index >= 0 && recentEntries.length < 4; index -= 1) {
    const message = history[index];
    if (message.type === 'user_prompt') {
      const prompt = message.prompt.trim();
      if (prompt && !prompt.startsWith('/')) {
        recentEntries.unshift(`[user]\n${prompt}`);
      }
      continue;
    }

    const assistantText = extractAssistantText(message);
    if (assistantText && !isLocalUtilityAssistantText(assistantText)) {
      recentEntries.unshift(`[assistant]\n${assistantText}`);
    }
  }

  return recentEntries.join('\n\n').trim();
}

function buildCompactBootstrapPrompt(params: {
  summary: string;
  cwd?: string | null;
  recentConversation?: string;
}): string {
  const lines = [
    'You are resuming an Aegis Claude Code conversation after local compaction.',
    'Adopt the following summary as the current session context and continue from it on future turns.',
  ];

  if (params.cwd) {
    lines.push(`Project working directory: ${params.cwd}`);
  }

  lines.push('', '<summary>', params.summary, '</summary>');

  if (params.recentConversation) {
    lines.push(
      '',
      'Recent verbatim turns to preserve if useful:',
      params.recentConversation
    );
  }

  lines.push(
    '',
    'Do not repeat the summary back to the user.',
    'Do not start working yet.',
    'Reply with exactly READY.'
  );

  return lines.join('\n');
}


async function handleEditLatestPrompt(
  mainWindow: BrowserWindow,
  payload: SessionContinuePayload
): Promise<void> {
  const { sessionId, prompt, attachments, model, compatibleProviderId, betas, claudeAccessMode } = payload;
  const session = sessions.getSession(sessionId);
  if (!session) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'Unknown session', sessionId },
    });
    return;
  }

  if (session.provider !== 'claude') {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'Editing the latest sent message is currently available only for Claude sessions.', sessionId },
    });
    return;
  }

  const existingEntry = runnerHandles.get(sessionId);
  if (existingEntry && session.status === 'running') {
    existingEntry.handle.abort();
    runnerHandles.delete(sessionId);
  }

  const history = sanitizeStoredClaudeHistory(sessionId, sessions.getSessionHistory(sessionId)).messages;
  const previousStatus = (session.status as SessionStatus) || 'completed';
  const previousClaudeSessionId = session.claude_session_id || null;
  const previousModel = session.model || null;
  const previousCompatibleProviderId = session.compatible_provider_id || null;
  const previousBetas = parseStoredBetas(session.betas);
  const previousClaudeAccessMode = normalizeClaudeAccessMode(session.claude_access_mode);
  let latestUserPromptIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.type === 'user_prompt') {
      latestUserPromptIndex = index;
      break;
    }
  }

  if (latestUserPromptIndex === -1) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'No editable user prompt found for this session.', sessionId },
    });
    return;
  }
  const previousEditablePrompt = history[latestUserPromptIndex];
  if (!previousEditablePrompt || previousEditablePrompt.type !== 'user_prompt') {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'Failed to resolve the editable user prompt for this session.', sessionId },
    });
    return;
  }

  const preservedHistory = history.slice(0, latestUserPromptIndex);
  const requestedModel = normalizeModel(model ?? session.model ?? undefined);
  const requestedCompatibleProviderId =
    compatibleProviderId ?? session.compatible_provider_id ?? undefined;
  const requestedBetas = normalizeBetas(betas ?? parseStoredBetas(session.betas));
  const nextPrompt = prompt.trim();
  const nextClaudeAccessMode = normalizeClaudeAccessMode(claudeAccessMode);
  const createdAt = Date.now();
  const editedUserPrompt: StreamMessage = {
    type: 'user_prompt',
    prompt: nextPrompt,
    attachments,
    createdAt,
  };
  const rewrittenHistory = [...preservedHistory, editedUserPrompt];
  let nextClaudeSessionId: string | undefined;
  let resolvedModel = requestedModel;

  // Optimistically update the visible history before the expensive
  // summary/bootstrap round-trip so the edited prompt changes immediately.
  sessions.replaceSessionHistory(sessionId, rewrittenHistory);
  sessions.updateSessionStatus(sessionId, 'running');
  sessions.updateLastPrompt(sessionId, nextPrompt);
  sessions.setClaudeSessionId(sessionId, null);
  sessions.updateSessionModel(sessionId, requestedModel || null);
  sessions.updateSessionCompatibleProviderId(sessionId, requestedCompatibleProviderId || null);
  sessions.updateSessionBetas(sessionId, requestedBetas || null);
  sessions.updateSessionClaudeAccessMode(sessionId, nextClaudeAccessMode);

  broadcast(mainWindow, {
    type: 'session.history',
    payload: {
      sessionId,
      status: 'running',
      messages: rewrittenHistory,
    },
  });

  broadcast(mainWindow, {
    type: 'session.status',
    payload: {
      sessionId,
      status: 'running',
      provider: session.provider || 'claude',
      model: requestedModel || undefined,
      compatibleProviderId: requestedCompatibleProviderId,
      betas: requestedBetas,
      claudeAccessMode: nextClaudeAccessMode,
      hiddenFromThreads: session.hidden_from_threads === 1,
    },
  });

  try {
    if (preservedHistory.length > 0) {
      const bootstrap = await bootstrapClaudeSessionFromHistory({
        history: preservedHistory,
        cwd: session.cwd,
        model: requestedModel,
        compatibleProviderId: requestedCompatibleProviderId,
        betas: requestedBetas,
      });
      nextClaudeSessionId = bootstrap.sessionId;
      resolvedModel = normalizeModel(bootstrap.model || requestedModel || undefined);
    }
  } catch (error) {
    sessions.replaceSessionHistory(sessionId, history);
    sessions.updateSessionStatus(sessionId, previousStatus);
    sessions.updateLastPrompt(sessionId, previousEditablePrompt.prompt);
    sessions.setClaudeSessionId(sessionId, previousClaudeSessionId);
    sessions.updateSessionModel(sessionId, previousModel);
    sessions.updateSessionCompatibleProviderId(sessionId, previousCompatibleProviderId);
    sessions.updateSessionBetas(sessionId, previousBetas || null);
    sessions.updateSessionClaudeAccessMode(sessionId, previousClaudeAccessMode);

    broadcast(mainWindow, {
      type: 'session.history',
      payload: {
        sessionId,
        status: previousStatus,
        messages: history,
      },
    });

    broadcast(mainWindow, {
      type: 'session.status',
      payload: {
        sessionId,
        status: previousStatus,
        provider: session.provider || 'claude',
        model: previousModel || undefined,
        compatibleProviderId: previousCompatibleProviderId || undefined,
        betas: previousBetas,
        claudeAccessMode: previousClaudeAccessMode,
        hiddenFromThreads: session.hidden_from_threads === 1,
      },
    });

    const message = error instanceof Error ? error.message : String(error);
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: `Failed to edit latest message: ${message}`, sessionId },
    });
    return;
  }
  sessions.setClaudeSessionId(sessionId, nextClaudeSessionId || null);
  sessions.updateSessionModel(sessionId, resolvedModel || null);
  sessions.updateSessionCompatibleProviderId(sessionId, requestedCompatibleProviderId || null);
  sessions.updateSessionBetas(sessionId, requestedBetas || null);
  sessions.updateSessionClaudeAccessMode(sessionId, nextClaudeAccessMode);

  const refreshedSession = sessions.getSession(sessionId);
  if (!refreshedSession) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'Failed to refresh session after editing the latest message.', sessionId },
    });
    return;
  }

  broadcast(mainWindow, {
    type: 'session.status',
    payload: {
      sessionId,
      status: 'running',
      provider: refreshedSession.provider,
      model: resolvedModel || undefined,
      compatibleProviderId: refreshedSession.compatible_provider_id || undefined,
      betas: requestedBetas,
      claudeAccessMode: nextClaudeAccessMode,
      hiddenFromThreads: refreshedSession.hidden_from_threads === 1,
    },
  });

  startRunner(
    mainWindow,
    refreshedSession,
    nextPrompt,
    nextClaudeSessionId,
    attachments,
    'claude',
    resolvedModel || undefined,
    requestedCompatibleProviderId,
    requestedBetas,
    nextClaudeAccessMode
  );
}

async function maybeHandleLocalSlashCommand(
  mainWindow: BrowserWindow,
  session: ReturnType<typeof sessions.getSession>,
  prompt: string,
  attachments?: Attachment[]
): Promise<boolean> {
  if (!session) return false;

  const parsed = parseSlashCommand(prompt);
  if (!parsed) return false;

  let responseText: string | null = null;

  if (parsed.name === 'cost') {
    responseText = buildSessionCostSummary(session);
  } else if (parsed.name === 'plan') {
    responseText = buildUnsupportedSlashCommandMessage(parsed.name);
  }

  if (!responseText) {
    return false;
  }

  const createdAt = Date.now();
  sessions.updateLastPrompt(session.id, prompt);

  broadcast(mainWindow, {
    type: 'stream.user_prompt',
    payload: { sessionId: session.id, prompt, attachments, createdAt },
  });
  sessions.addMessage(session.id, { type: 'user_prompt', prompt, attachments, createdAt });

  const assistantMessage = buildLocalAssistantMessage(responseText);
  sessions.addMessage(session.id, assistantMessage);
  broadcast(mainWindow, {
    type: 'stream.message',
    payload: { sessionId: session.id, message: assistantMessage },
  });

  return true;
}

function toAttachment(filePath: string): Attachment | null {
  const spec = getAttachmentSpec(filePath);
  if (!spec) {
    return null;
  }

  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return null;
    }
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      return null;
    }

    return {
      id: uuidv4(),
      path: filePath,
      name: basename(filePath),
      size: stat.size,
      mimeType: spec.mimeType,
      kind: spec.kind,
    };
  } catch {
    return null;
  }
}

// Runner 句柄映射（带 Provider）
const runnerHandles = new Map<
  string,
  {
    handle: RunnerHandle;
    provider: 'claude' | 'codex' | 'opencode';
    compatibleProviderId?: import('../shared/types').ClaudeCompatibleProviderId;
    claudeAccessMode?: import('../shared/types').ClaudeAccessMode;
    codexPermissionMode?: import('../shared/types').CodexPermissionMode;
  }
>();

// 会话状态映射（包含 pending permissions）
const sessionStates = new Map<string, SessionState>();

// 获取或创建会话状态
function getSessionState(sessionId: string): SessionState {
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = { pendingPermissions: new Map() };
    sessionStates.set(sessionId, state);
  }
  return state;
}

// 广播事件到渲染进程
function broadcast(mainWindow: BrowserWindow, event: ServerEvent): void {
  // 检查窗口和 webContents 是否已销毁
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('server-event', JSON.stringify(event));
}

async function emitProjectTree(mainWindow: BrowserWindow, cwd: string): Promise<void> {
  try {
    const tree = await readProjectTree(cwd);
    broadcast(mainWindow, { type: 'project.tree', payload: { cwd, tree } });
  } catch (error) {
    console.error('Failed to read project tree:', error);
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: `Failed to read project tree: ${String(error)}` },
    });
  }
}

function scheduleProjectTree(mainWindow: BrowserWindow, cwd: string): void {
  const entry = projectWatchers.get(cwd);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
  }
  entry.timer = setTimeout(() => {
    emitProjectTree(mainWindow, cwd);
  }, 200);
}

function mapGitChangeStatus(indexStatus: string, workStatus: string): {
  status: 'M' | 'A' | 'D' | 'R' | '?';
  staged: boolean;
} {
  if (indexStatus === '?' && workStatus === '?') {
    return { status: '?', staged: false };
  }

  // Prefer the worktree state when present so mixed porcelain states like AM/RM
  // still surface as modified in the Changes panel.
  if (workStatus === 'D') {
    return { status: 'D', staged: false };
  }
  if (workStatus === 'R') {
    return { status: 'R', staged: false };
  }
  if (workStatus === 'M') {
    return { status: 'M', staged: false };
  }

  if (indexStatus === 'D') {
    return { status: 'D', staged: workStatus === ' ' };
  }
  if (indexStatus === 'R') {
    return { status: 'R', staged: workStatus === ' ' };
  }
  if (indexStatus === 'M') {
    return { status: 'M', staged: workStatus === ' ' };
  }
  if (indexStatus === 'A') {
    return { status: 'A', staged: workStatus === ' ' };
  }

  return { status: 'M', staged: false };
}

// 初始化 IPC 处理器
export function setupIPCHandlers(mainWindow: BrowserWindow): void {
  // 初始化数据库
  sessions.initialize();

  // 加载 Claude 配置
  loadClaudeSettings();

  feishuBridge.setHandlers({
    startSession: async ({ title, prompt, cwd, provider, model }) => {
      return handleSessionStart(mainWindow, { title, prompt, cwd, provider, model });
    },
    continueSession: async ({ sessionId, prompt, provider, model }) => {
      return handleSessionContinue(mainWindow, { sessionId, prompt, provider, model });
    },
    resolvePermission: ({ sessionId, toolUseId, result }) => {
      return handlePermissionResponse({ sessionId, toolUseId, result });
    },
  });
  void feishuBridge.maybeAutoStart();

  // 处理客户端事件
  ipcMain.removeAllListeners('client-event');
  ipcMain.on('client-event', async (_, eventJson: string) => {
    try {
      const event: ClientEvent = JSON.parse(eventJson);
      await handleClientEvent(mainWindow, event);
    } catch (error) {
      console.error('Error handling client event:', error);
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: { message: String(error) },
      });
    }
  });

  // RPC: 生成会话标题
  ipcMainHandle('generate-session-title', async (_, prompt: string) => {
    return generateSessionTitle(prompt);
  });

  // RPC: 获取最近工作目录
  ipcMainHandle('get-recent-cwds', async (_, limit?: number) => {
    return sessions.listRecentCwds(limit);
  });

  ipcMainHandle('set-window-min-size', async (_event, width: number, height: number) => {
    const safeWidth = Number.isFinite(width) ? Math.max(400, Math.round(width)) : 800;
    const safeHeight = Number.isFinite(height) ? Math.max(400, Math.round(height)) : 600;

    mainWindow.setMinimumSize(safeWidth, safeHeight);

    const [currentWidth, currentHeight] = mainWindow.getSize();
    const nextWidth = Math.max(currentWidth, safeWidth);
    const nextHeight = Math.max(currentHeight, safeHeight);
    if (nextWidth !== currentWidth || nextHeight !== currentHeight) {
      mainWindow.setSize(nextWidth, nextHeight);
    }

    return { ok: true };
  });

  ipcMainHandle('search-chat-messages', async (_event, query: string, limit?: number) => {
    return sessions.searchChatMessages(query, limit);
  });

  // RPC: 获取 Claude 模型配置
  ipcMainHandle('get-claude-model-config', async () => {
    return getClaudeModelConfig();
  });

  // RPC: 获取 Claude-compatible provider 配置
  ipcMainHandle('get-claude-compatible-provider-config', async () => {
    return loadCompatibleProviderConfig();
  });

  // RPC: 保存 Claude-compatible provider 配置
  ipcMainHandle('save-claude-compatible-provider-config', async (_, config: ClaudeCompatibleProvidersConfig) => {
    saveCompatibleProviderConfig(config);
    return loadCompatibleProviderConfig();
  });

  // RPC: 获取 Claude usage 报表
  ipcMainHandle('get-claude-usage-report', async (_, days?: ClaudeUsageRangeDays) => {
    return sessions.getClaudeUsageReport(days);
  });

  ipcMainHandle('get-codex-usage-report', async (_, days?: ClaudeUsageRangeDays) => {
    return sessions.getCodexUsageReport(days);
  });

  ipcMainHandle('get-opencode-usage-report', async (_, days?: ClaudeUsageRangeDays) => {
    return sessions.getOpencodeUsageReport(days);
  });

  ipcMainHandle('get-prompt-library', async () => {
    return listPromptLibraryItems();
  });

  ipcMainHandle('save-prompt-library-item', async (_event, input: UpsertPromptLibraryItemInput) => {
    return savePromptLibraryItem(input);
  });

  ipcMainHandle('delete-prompt-library-item', async (_event, id: string) => {
    return deletePromptLibraryItem(id);
  });

  ipcMainHandle('import-prompt-library', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        {
          name: 'JSON',
          extensions: ['json'],
        },
      ],
    });

    if (result.canceled || !result.filePaths[0]) {
      return {
        items: listPromptLibraryItems(),
        importedCount: 0,
        skippedCount: 0,
        filePath: null,
      };
    }

    return importPromptLibraryFile(result.filePaths[0]);
  });

  ipcMainHandle('export-prompt-library', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: 'prompt-library.json',
      filters: [
        {
          name: 'JSON',
          extensions: ['json'],
        },
      ],
    });

    if (result.canceled || !result.filePath) {
      return {
        canceled: true,
        filePath: null,
        count: listPromptLibraryItems().length,
      };
    }

    return exportPromptLibraryFile(result.filePath);
  });

  // RPC: 获取 Codex 模型配置
  ipcMainHandle('get-codex-model-config', async () => {
    return getCodexModelConfig();
  });

  ipcMainHandle('save-codex-model-visibility', async (_event, enabledModels: string[]) => {
    return saveCodexModelVisibility(enabledModels);
  });

  ipcMainHandle('get-codex-runtime-status', async () => {
    return getCodexRuntimeStatus();
  });

  ipcMainHandle('get-opencode-model-config', async () => {
    return getOpencodeModelConfig();
  });

  ipcMainHandle('save-opencode-model-visibility', async (_event, enabledModels: string[]) => {
    return saveOpencodeModelVisibility(enabledModels);
  });

  ipcMainHandle('get-opencode-runtime-status', async () => {
    return getOpencodeRuntimeStatus();
  });

  ipcMainHandle('get-claude-runtime-status', async (_event, model?: string | null) => {
    return getClaudeRuntimeStatus(model);
  });

  ipcMainHandle('get-skill-market-hot', async (_event, limit?: number) => {
    return getSkillMarketHot(limit);
  });

  ipcMainHandle('search-skill-market', async (_event, query: string, limit?: number) => {
    return searchSkillMarket(query, limit);
  });

  ipcMainHandle('get-skill-market-detail', async (_event, id: string) => {
    return getSkillMarketDetail(id);
  });

  ipcMainHandle('install-skill-from-market', async (_event, id: string) => {
    return installSkillFromMarket(id);
  });

  ipcMainHandle(
    'expand-claude-skill-prompt',
    async (_event, skillFilePath: string, skillName: string, userPrompt: string) => {
      try {
        return {
          ok: true,
          prompt: expandClaudeSkillPrompt({
            skillFilePath,
            skillName,
            userPrompt,
          }),
        };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );

  ipcMainHandle('get-feishu-bridge-config', async () => {
    return loadFeishuBridgeConfig();
  });

  ipcMainHandle('save-feishu-bridge-config', async (_event, config: FeishuBridgeConfig) => {
    return saveFeishuBridgeConfig(config);
  });

  ipcMainHandle('get-feishu-bridge-status', async () => {
    return feishuBridge.getStatus();
  });

  ipcMainHandle('start-feishu-bridge', async () => {
    return feishuBridge.start();
  });

  ipcMainHandle('stop-feishu-bridge', async () => {
    return feishuBridge.stop();
  });

  // RPC: 获取字体设置
  ipcMainHandle('get-font-settings', async () => {
    return getFontSettings();
  });

  // RPC: 保存字体选择
  ipcMainHandle('save-font-selections', async (_event, selections: FontSettingsPayload['selections']) => {
    return saveFontSelections(selections);
  });

  // RPC: 列出系统字体
  ipcMainHandle('list-system-fonts', async () => {
    return listSystemFonts();
  });

  // RPC: 导入字体文件
  ipcMainHandle('import-font-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        {
          name: 'Fonts',
          extensions: ['ttf', 'otf', 'woff', 'woff2'],
        },
      ],
    });

    if (result.canceled || !result.filePaths[0]) {
      return null;
    }

    return importFontFile(result.filePaths[0]);
  });

  // RPC: 删除导入字体
  ipcMainHandle('delete-imported-font', async (_event, fontId: string) => {
    return deleteImportedFont(fontId);
  });

  // RPC: 选择目录
  ipcMainHandle('select-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // RPC: 选择附件（文件/图片）
  ipcMainHandle('select-attachments', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Supported',
          extensions: ['txt', 'md', 'json', 'log', 'pdf', 'docx', 'png', 'jpg', 'jpeg'],
        },
      ],
    });

    if (result.canceled) {
      return [] as Attachment[];
    }

    const attachments: Attachment[] = [];
    let skipped = 0;

    for (const filePath of result.filePaths) {
      const attachment = toAttachment(filePath);
      if (attachment) {
        attachments.push(attachment);
      } else {
        skipped += 1;
      }
    }

    if (skipped > 0) {
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: {
          message: `Skipped ${skipped} file(s): only .txt/.md/.json/.log/.pdf/.docx/.png/.jpg are supported (<=10MB).`,
        },
      });
    }

    return attachments;
  });

  // RPC: 读取图片预览（data URL）
  ipcMainHandle('read-attachment-preview', async (_event, filePath: string) => {
    const spec = getAttachmentSpec(filePath);
    if (!spec || spec.kind !== 'image') {
      return null;
    }

    try {
      const stat = statSync(filePath);
      if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) {
        return null;
      }
      const buffer = readFileSync(filePath);
      return `data:${spec.mimeType};base64,${buffer.toString('base64')}`;
    } catch {
      return null;
    }
  });

  // RPC: 获取项目文件树
  ipcMainHandle('get-project-tree', async (_event, cwd: string) => {
    if (!cwd) {
      return null;
    }
    return readProjectTree(cwd);
  });

  // RPC: 读取项目文件预览（安全：仅允许 cwd 内的文件，<=5MB）
  ipcMainHandle(
    'read-project-file-preview',
    async (_event, cwd: string, filePath: string): Promise<ProjectFilePreview> => {
      const resolved = resolve(cwd || '.', filePath || '');
      const name = basename(resolved) || resolved;
      const ext = extname(resolved).toLowerCase();

      const validation = await validateProjectFilePath(cwd, resolved);
      if (!validation.ok) {
        return { kind: 'error', path: resolved, name, ext, message: validation.message };
      }

      let stat;
      try {
        stat = await fsPromises.stat(validation.targetReal);
      } catch (error) {
        return { kind: 'error', path: validation.targetReal, name, ext, message: 'File not found' };
      }

      if (!stat.isFile()) {
        return { kind: 'error', path: validation.targetReal, name, ext, message: 'Not a file' };
      }

      if (stat.size > MAX_FILE_PREVIEW_BYTES) {
        return {
          kind: 'too_large',
          path: validation.targetReal,
          name,
          ext,
          size: stat.size,
          maxBytes: MAX_FILE_PREVIEW_BYTES,
        };
      }

      // Images
      if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
        try {
          const buffer = await fsPromises.readFile(validation.targetReal);
          const mimeType = ATTACHMENT_MIME_TYPES[ext] || 'application/octet-stream';
          return {
            kind: 'image',
            path: validation.targetReal,
            name,
            ext,
            size: stat.size,
            dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
          };
        } catch (error) {
          return {
            kind: 'error',
            path: validation.targetReal,
            name,
            ext,
            message: `Failed to read image: ${String(error)}`,
          };
        }
      }

      // Markdown + text-like preview
      if (ext === '.md' || ext === '.txt' || ext === '.json' || ext === '.log' || ext === '.html' || ext === '.htm') {
        try {
          const text = await fsPromises.readFile(validation.targetReal, 'utf8');
          return {
            kind: ext === '.md' ? 'markdown' : ext === '.html' || ext === '.htm' ? 'html' : 'text',
            path: validation.targetReal,
            name,
            ext,
            size: stat.size,
            text,
            editable: ext === '.txt',
          };
        } catch (error) {
          return {
            kind: 'error',
            path: validation.targetReal,
            name,
            ext,
            message: `Failed to read file: ${String(error)}`,
          };
        }
      }

      if (ext === '.pdf') {
        try {
          const buffer = await fsPromises.readFile(validation.targetReal);
          const dataBase64 = buffer.toString('base64');
          return {
            kind: 'pdf',
            path: validation.targetReal,
            name,
            ext,
            size: stat.size,
            dataBase64,
            dataUrl: `data:application/pdf;base64,${dataBase64}`,
          };
        } catch (error) {
          return {
            kind: 'error',
            path: validation.targetReal,
            name,
            ext,
            message: `Failed to read PDF: ${String(error)}`,
          };
        }
      }

      if (ext === '.ppt' || ext === '.pptx' || ext === '.key') {
        try {
          const buffer = await fsPromises.readFile(validation.targetReal);
          return {
            kind: 'pptx',
            path: validation.targetReal,
            name,
            ext,
            size: stat.size,
            dataBase64: buffer.toString('base64'),
          };
        } catch (error) {
          return {
            kind: 'error',
            path: validation.targetReal,
            name,
            ext,
            message: `Failed to read presentation: ${String(error)}`,
          };
        }
      }

      // Binary files (open only)
      if (ext === '.docx') {
        return { kind: 'binary', path: validation.targetReal, name, ext, size: stat.size };
      }

      return { kind: 'unsupported', path: validation.targetReal, name, ext, size: stat.size };
    }
  );

  // RPC: 写入项目文本文件（仅允许写 .txt，安全：cwd 内，<=5MB）
  ipcMainHandle(
    'write-project-text-file',
    async (
      _event,
      cwd: string,
      filePath: string,
      content: string
    ): Promise<{ ok: true } | { ok: false; message: string }> => {
      const resolved = resolve(cwd || '.', filePath || '');
      const ext = extname(resolved).toLowerCase();

      if (ext !== '.txt') {
        return { ok: false, message: 'Only .txt files are editable right now.' };
      }

      const validation = await validateProjectFilePath(cwd, resolved);
      if (!validation.ok) {
        return { ok: false, message: validation.message };
      }

      let stat;
      try {
        stat = await fsPromises.stat(validation.targetReal);
      } catch {
        return { ok: false, message: 'File not found' };
      }

      if (!stat.isFile()) {
        return { ok: false, message: 'Not a file' };
      }

      const bytes = Buffer.byteLength(content ?? '', 'utf8');
      if (bytes > MAX_FILE_PREVIEW_BYTES) {
        return { ok: false, message: 'File content is too large to save (max 5MB).' };
      }

      try {
        await fsPromises.writeFile(validation.targetReal, content ?? '', 'utf8');
        return { ok: true };
      } catch (error) {
        return { ok: false, message: `Failed to save file: ${String(error)}` };
      }
    }
  );

  // RPC: 用系统默认应用打开文件
  ipcMainHandle('open-path', async (_event, filePath: string) => {
    try {
      const errMsg = await shell.openPath(normalizeShellPath(filePath));
      return errMsg ? { ok: false, message: errMsg } : { ok: true };
    } catch (error) {
      return { ok: false, message: String(error) };
    }
  });

  // RPC: 在文件管理器中展示文件
  ipcMainHandle('reveal-path', async (_event, filePath: string) => {
    try {
      shell.showItemInFolder(normalizeShellPath(filePath));
      return { ok: true };
    } catch (error) {
      return { ok: false, message: String(error) };
    }
  });

  // RPC: 订阅项目文件树更新
  ipcMainHandle('watch-project-tree', async (_event, cwd: string) => {
    if (!cwd) {
      return false;
    }
    if (projectWatchers.has(cwd)) {
      scheduleProjectTree(mainWindow, cwd);
      return true;
    }
    try {
      const watcher = watch(
        cwd,
        { recursive: true },
        () => scheduleProjectTree(mainWindow, cwd)
      );
      projectWatchers.set(cwd, { watcher });
      scheduleProjectTree(mainWindow, cwd);
      return true;
    } catch (error) {
      console.error('Failed to watch project tree:', error);
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: { message: `Failed to watch project tree: ${String(error)}` },
      });
      return false;
    }
  });

  // RPC: 取消订阅项目文件树更新
  ipcMainHandle('unwatch-project-tree', async (_event, cwd: string) => {
    const entry = projectWatchers.get(cwd);
    if (entry) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      entry.watcher.close();
      projectWatchers.delete(cwd);
    }
    return true;
  });

  // ── Git Changes ──

  const execFileAsync = promisify(execFile);

  ipcMainHandle('get-git-changes', async (_event, cwd: string) => {
    if (!cwd) return { ok: false, error: 'no-cwd', entries: [] };

    // Check if inside a git repo first
    try {
      await execFileAsync('git', ['rev-parse', '--git-dir'], { cwd, timeout: 5000 });
    } catch {
      return { ok: false, error: 'not-a-repo', entries: [] };
    }

    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-uall'], {
        cwd,
        maxBuffer: 1024 * 1024,
        timeout: 10000,
      });

      const entries: Array<{ filePath: string; status: string; staged: boolean }> = [];
      for (const line of stdout.split('\n')) {
        if (!line) continue;
        const indexStatus = line[0];
        const workStatus = line[1];
        let filePath = line.slice(3);
        if (filePath.includes(' -> ')) {
          filePath = filePath.split(' -> ')[1];
        }
        filePath = filePath.trim();
        if (!filePath) continue;

        const { status, staged } = mapGitChangeStatus(indexStatus, workStatus);

        entries.push({ filePath, status, staged });
      }
      return { ok: true, error: null, entries };
    } catch {
      return { ok: false, error: 'git-error', entries: [] };
    }
  });

  ipcMainHandle('get-git-diff', async (_event, cwd: string, filePath: string) => {
    if (!cwd || !filePath) return '';
    try {
      // Unstaged
      const unstaged = await execFileAsync('git', ['diff', '--unified=3', '--', filePath], {
        cwd, maxBuffer: 2 * 1024 * 1024, timeout: 10000,
      });
      if (unstaged.stdout.trim()) return unstaged.stdout;

      // Staged
      const staged = await execFileAsync('git', ['diff', '--cached', '--unified=3', '--', filePath], {
        cwd, maxBuffer: 2 * 1024 * 1024, timeout: 10000,
      });
      if (staged.stdout.trim()) return staged.stdout;

      // Untracked (diff against /dev/null)
      try {
        const untracked = await execFileAsync('git', ['diff', '--no-index', '--unified=3', '/dev/null', filePath], {
          cwd, maxBuffer: 2 * 1024 * 1024, timeout: 10000,
        });
        return untracked.stdout;
      } catch (err: unknown) {
        // git diff --no-index exits 1 when differences exist
        if (err && typeof err === 'object' && 'stdout' in err) return (err as { stdout: string }).stdout;
      }
      return '';
    } catch {
      return '';
    }
  });
}

// 处理客户端事件
async function handleClientEvent(
  mainWindow: BrowserWindow,
  event: ClientEvent
): Promise<void> {
  switch (event.type) {
    case 'session.list':
      handleSessionList(mainWindow);
      break;

    case 'session.start':
      await handleSessionStart(mainWindow, event.payload);
      break;

    case 'session.continue':
      await handleSessionContinue(mainWindow, event.payload);
      break;

    case 'session.editLatestPrompt':
      await handleEditLatestPrompt(mainWindow, event.payload);
      break;

    case 'session.history':
      handleSessionHistory(mainWindow, event.payload.sessionId);
      break;

    case 'session.stop':
      handleSessionStop(mainWindow, event.payload.sessionId);
      break;

    case 'session.delete':
      handleSessionDelete(mainWindow, event.payload.sessionId);
      break;

    case 'permission.response':
      handlePermissionResponse(event.payload);
      break;

    case 'mcp.get-config':
      handleMcpGetConfig(mainWindow, event.payload?.projectPath);
      break;

    case 'mcp.save-config':
      handleMcpSaveConfig(mainWindow, event.payload);
      break;

    case 'skills.list':
      handleSkillsList(mainWindow, event.payload?.projectPath);
      break;

    case 'session.setTodoState':
      handleSessionSetTodoState(mainWindow, event.payload);
      break;

    case 'session.togglePin':
      handleSessionTogglePin(mainWindow, event.payload);
      break;

    case 'status.list':
      handleStatusList(mainWindow);
      break;

    case 'status.create':
      handleStatusCreate(mainWindow, event.payload);
      break;

    case 'status.update':
      handleStatusUpdate(mainWindow, event.payload);
      break;

    case 'status.delete':
      handleStatusDelete(mainWindow, event.payload);
      break;

    case 'status.reorder':
      handleStatusReorder(mainWindow, event.payload);
      break;

    case 'folder.list':
      handleFolderList(mainWindow);
      break;

    case 'folder.create':
      handleFolderCreate(mainWindow, event.payload);
      break;

    case 'folder.update':
      handleFolderUpdate(mainWindow, event.payload);
      break;

    case 'folder.delete':
      handleFolderDelete(mainWindow, event.payload);
      break;

    case 'folder.move':
      handleFolderMove(mainWindow, event.payload);
      break;

    case 'session.setFolder':
      handleSessionSetFolder(mainWindow, event.payload);
      break;
  }
}

// 会话列表
function handleSessionList(mainWindow: BrowserWindow): void {
  const rows = sessions.listSessions();
  const latestClaudeModelUsageBySession = sessions.getLatestClaudeModelUsageBySession();
  const sessionInfos: SessionInfo[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status as SessionInfo['status'],
    cwd: row.cwd || undefined,
    claudeSessionId: row.claude_session_id || undefined,
    provider: row.provider || 'claude',
    model: row.model || undefined,
    compatibleProviderId: row.compatible_provider_id || undefined,
    betas: parseStoredBetas(row.betas),
    claudeAccessMode: normalizeClaudeAccessMode(row.claude_access_mode),
    codexPermissionMode: normalizeCodexPermissionMode(row.codex_permission_mode),
    todoState: row.todo_state || 'todo',
    pinned: row.pinned === 1,
    folderPath: row.folder_path || null,
    hiddenFromThreads: row.hidden_from_threads === 1,
    latestClaudeModelUsage: latestClaudeModelUsageBySession[row.id],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  broadcast(mainWindow, {
    type: 'session.list',
    payload: { sessions: sessionInfos },
  });

  // 同时发送状态配置列表
  const statuses = statusConfig.listStatuses();
  broadcast(mainWindow, {
    type: 'status.list',
    payload: { statuses },
  });

  // 同时发送文件夹列表
  const folders = folderConfig.listFolders();
  broadcast(mainWindow, {
    type: 'folder.list',
    payload: { folders },
  });
}

// 新建会话
async function handleSessionStart(
  mainWindow: BrowserWindow,
  payload: SessionStartPayload
): Promise<string | null> {
  const {
    title,
    prompt,
    effectivePrompt,
    cwd,
    allowedTools,
    attachments,
    provider,
    model,
    compatibleProviderId,
    betas,
    claudeAccessMode,
    codexPermissionMode,
    hiddenFromThreads,
  } = payload;
  const runnerPrompt = (effectivePrompt || prompt).trim();
  if (!cwd?.trim()) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'Select a project folder before starting a task.' },
    });
    return null;
  }
  const chosenProvider = provider || 'claude';
  const selectedModel = normalizeModel(model);
  const selectedBetas = chosenProvider === 'claude' ? normalizeBetas(betas) : undefined;

  if (chosenProvider === 'claude') {
    const runtimeStatus = await getClaudeRuntimeStatus(selectedModel || null);
    if (!runtimeStatus.ready) {
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: {
          message: formatClaudeRuntimeBlockingMessage(runtimeStatus),
        },
      });
      return null;
    }
  } else if (chosenProvider === 'opencode') {
    const runtimeStatus = await getOpencodeRuntimeStatus();
    if (!runtimeStatus.ready) {
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: {
          message: 'OpenCode ACP is not ready. Check Settings > Providers.',
        },
      });
      return null;
    }
  }

  if (isDev()) {
    console.log('[Session Start]', {
      provider: chosenProvider,
      model: selectedModel,
      compatibleProviderId: chosenProvider === 'claude' ? compatibleProviderId : undefined,
      cwd: cwd || undefined,
    });
  }

  // 创建会话（用临时标题）
  const session = sessions.createSession({
    title,
    cwd,
    allowedTools,
    prompt,
    provider: chosenProvider,
    model: selectedModel,
    compatibleProviderId: chosenProvider === 'claude' ? compatibleProviderId : undefined,
    betas: selectedBetas,
    claudeAccessMode: chosenProvider === 'claude' ? normalizeClaudeAccessMode(claudeAccessMode) : undefined,
    codexPermissionMode: chosenProvider === 'codex' ? normalizeCodexPermissionMode(codexPermissionMode) : undefined,
    hiddenFromThreads: hiddenFromThreads === true,
  });

  // 更新状态为 running
  sessions.updateSessionStatus(session.id, 'running');

  // 立即广播状态 -> 界面跳转
  broadcast(mainWindow, {
    type: 'session.status',
    payload: {
      sessionId: session.id,
      status: 'running',
      title: session.title,
      cwd: session.cwd || undefined,
      provider: chosenProvider,
      model: selectedModel,
      compatibleProviderId: chosenProvider === 'claude' ? compatibleProviderId : undefined,
      betas: selectedBetas,
      claudeAccessMode: chosenProvider === 'claude' ? normalizeClaudeAccessMode(claudeAccessMode) : undefined,
      codexPermissionMode: chosenProvider === 'codex' ? normalizeCodexPermissionMode(codexPermissionMode) : undefined,
      hiddenFromThreads: session.hidden_from_threads === 1,
    },
  });

  if (chosenProvider === 'claude') {
    // 异步生成更好的标题（不阻塞）
    generateSessionTitle(
      prompt,
      cwd,
      selectedModel,
      compatibleProviderId,
      selectedBetas
    ).then((newTitle) => {
      const trimmedTitle = newTitle.trim();
      if (!trimmedTitle) {
        return;
      }

      sessions.updateSessionTitle(session.id, trimmedTitle);
      const latest = sessions.getSession(session.id);
      const currentStatus = latest?.status || session.status || 'running';
      broadcast(mainWindow, {
        type: 'session.status',
        payload: {
          sessionId: session.id,
          status: currentStatus as SessionStatus,
          title: trimmedTitle,
          hiddenFromThreads: latest?.hidden_from_threads === 1,
        },
      });
    }).catch((err) => {
      console.error('Failed to generate title:', err);
    });
  }

  // 广播用户 prompt
  const createdAt = Date.now();
  broadcast(mainWindow, {
    type: 'stream.user_prompt',
    payload: { sessionId: session.id, prompt, attachments, createdAt },
  });

  // 保存 user_prompt 到消息历史
  sessions.addMessage(session.id, { type: 'user_prompt', prompt, attachments, createdAt });

  // 启动 Runner
  startRunner(
    mainWindow,
    session,
    runnerPrompt,
    undefined,
    attachments,
    chosenProvider,
    selectedModel,
    chosenProvider === 'claude' ? compatibleProviderId : undefined,
    selectedBetas,
    claudeAccessMode,
    chosenProvider === 'codex' ? normalizeCodexPermissionMode(codexPermissionMode) : undefined
  );
  return session.id;
}

// 继续会话
async function handleSessionContinue(
  mainWindow: BrowserWindow,
  payload: SessionContinuePayload
): Promise<boolean> {
  const { sessionId, prompt, effectivePrompt, attachments, provider, model, compatibleProviderId, betas, claudeAccessMode, codexPermissionMode } = payload;
  const runnerPrompt = (effectivePrompt || prompt).trim();

  const session = sessions.getSession(sessionId);
  if (!session) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'Unknown session', sessionId },
    });
    return false;
  }

  if (await maybeHandleLocalSlashCommand(mainWindow, session, prompt, attachments)) {
    return true;
  }

  const sanitizedHistoryResult =
    session.provider === 'claude'
      ? sanitizeStoredClaudeHistory(sessionId, sessions.getSessionHistory(sessionId))
      : { messages: sessions.getSessionHistory(sessionId), hadInvalidThinking: false };
  const historyBeforeContinue = sanitizedHistoryResult.messages;

  const existingEntry = runnerHandles.get(sessionId);
  const previousProvider = session.provider || 'claude';
  const nextProvider = provider || previousProvider;
  const nextModel = normalizeModel(model ?? session.model ?? undefined);
  const previousCompatibleProviderId = session.compatible_provider_id || undefined;
  const nextCompatibleProviderId =
    nextProvider === 'claude'
      ? compatibleProviderId ?? previousCompatibleProviderId
      : undefined;
  const previousBetas = parseStoredBetas(session.betas);
  const nextBetas = nextProvider === 'claude'
    ? normalizeBetas(betas ?? previousBetas)
    : undefined;
  const previousModel = normalizeModel(session.model ?? undefined);
  const providerChanged = nextProvider !== previousProvider;
  const compatibleProviderChanged = nextCompatibleProviderId !== previousCompatibleProviderId;
  const modelChanged = nextModel !== previousModel;
  const betasChanged = JSON.stringify(nextBetas || []) !== JSON.stringify(previousBetas || []);
  const nextClaudeAccessMode =
    nextProvider === 'claude' ? normalizeClaudeAccessMode(claudeAccessMode) : undefined;
  const previousCodexPermissionMode = normalizeCodexPermissionMode(session.codex_permission_mode);
  const nextCodexPermissionMode = nextProvider === 'codex'
    ? normalizeCodexPermissionMode(codexPermissionMode || previousCodexPermissionMode)
    : undefined;
  const accessModeChanged =
    nextProvider === 'claude' &&
    (runnerHandles.get(sessionId)?.claudeAccessMode || 'default') !== nextClaudeAccessMode;
  const codexPermissionModeChanged =
    nextProvider === 'codex' &&
    normalizeCodexPermissionMode(runnerHandles.get(sessionId)?.codexPermissionMode || previousCodexPermissionMode) !== nextCodexPermissionMode;

  if (nextProvider === 'claude') {
    const runtimeStatus = await getClaudeRuntimeStatus(nextModel || null);
    if (!runtimeStatus.ready) {
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: {
          message: formatClaudeRuntimeBlockingMessage(runtimeStatus),
          sessionId,
        },
      });
      return false;
    }
  } else if (nextProvider === 'opencode') {
    const runtimeStatus = await getOpencodeRuntimeStatus();
    if (!runtimeStatus.ready) {
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: {
          message: 'OpenCode ACP is not ready. Check Settings > Providers.',
          sessionId,
        },
      });
      return false;
    }
  }

  if (isDev()) {
    console.log('[Session Continue]', {
      sessionId,
      payloadProvider: provider,
      previousProvider,
      nextProvider,
      nextModel,
      nextCompatibleProviderId,
      nextBetas,
      providerChanged,
      compatibleProviderChanged,
      betasChanged,
      accessModeChanged,
      codexPermissionModeChanged,
      hasExistingRunner: !!existingEntry,
    });
  }

  if (providerChanged) {
    sessions.updateSessionProvider(sessionId, nextProvider);
  }
  sessions.updateSessionModel(sessionId, nextModel || null);
  sessions.updateSessionCompatibleProviderId(
    sessionId,
    nextProvider === 'claude' ? nextCompatibleProviderId || null : null
  );
  sessions.updateSessionBetas(sessionId, nextBetas || null);
  if (nextProvider === 'claude') {
    sessions.updateSessionClaudeAccessMode(sessionId, claudeAccessMode || 'default');
  }
  if (nextProvider === 'codex') {
    sessions.updateSessionCodexPermissionMode(sessionId, nextCodexPermissionMode || 'defaultPermissions');
  }

  // 更新状态
  sessions.updateSessionStatus(sessionId, 'running');
  sessions.updateLastPrompt(sessionId, prompt);

  // 广播状态
  broadcast(mainWindow, {
    type: 'session.status',
    payload: {
      sessionId,
      status: 'running',
      provider: nextProvider,
      model: nextModel ?? '',
      compatibleProviderId: nextProvider === 'claude' ? nextCompatibleProviderId : undefined,
      betas: nextBetas,
      claudeAccessMode: nextProvider === 'claude' ? normalizeClaudeAccessMode(claudeAccessMode) : undefined,
      codexPermissionMode: nextProvider === 'codex' ? (nextCodexPermissionMode || 'defaultPermissions') : undefined,
      hiddenFromThreads: session.hidden_from_threads === 1,
    },
  });

  // 广播用户 prompt
  const createdAt = Date.now();
  broadcast(mainWindow, {
    type: 'stream.user_prompt',
    payload: { sessionId, prompt, attachments, createdAt },
  });

  // 保存 user_prompt
  sessions.addMessage(sessionId, { type: 'user_prompt', prompt, attachments, createdAt });

  if (existingEntry && !providerChanged && existingEntry.provider === nextProvider) {
    if (
      ((nextProvider === 'codex' || nextProvider === 'opencode') && modelChanged) ||
      (nextProvider === 'codex' && codexPermissionModeChanged) ||
      (nextProvider === 'claude' &&
        (modelChanged || compatibleProviderChanged || betasChanged || accessModeChanged))
    ) {
      existingEntry.handle.abort();
      runnerHandles.delete(sessionId);
    } else {
      existingEntry.handle.send(runnerPrompt, attachments, nextModel);
      return true;
    }
  }

  if (existingEntry && providerChanged) {
    existingEntry.handle.abort();
    runnerHandles.delete(sessionId);
  }

  let startModel = nextModel;

  // 启动 Runner（带 resume）
  const resumeSessionId =
    providerChanged
      ? undefined
      : nextProvider === 'claude'
        ? sessions.getSession(sessionId)?.claude_session_id ?? undefined
        : nextProvider === 'codex'
        ? session.codex_session_id ?? undefined
        : session.opencode_session_id ?? undefined;
  let nextResumeSessionId = resumeSessionId;

  if (
    nextProvider === 'claude' &&
    !providerChanged &&
    !nextResumeSessionId &&
    historyBeforeContinue.length > 0
  ) {
    try {
      const bootstrap = await bootstrapClaudeSessionFromHistory({
        history: historyBeforeContinue,
        cwd: session.cwd,
        model: nextModel,
        compatibleProviderId: nextCompatibleProviderId,
        betas: nextBetas,
      });
      nextResumeSessionId = bootstrap.sessionId;
      startModel = normalizeModel(bootstrap.model || nextModel || undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sessions.updateSessionStatus(sessionId, 'error');
      broadcast(mainWindow, {
        type: 'session.status',
        payload: {
          sessionId,
          status: 'error',
          provider: nextProvider,
          hiddenFromThreads: session.hidden_from_threads === 1,
        },
      });
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: {
          message: `Failed to rebuild Claude conversation context: ${message}`,
          sessionId,
        },
      });
      return false;
    }
  }

  startRunner(
    mainWindow,
    sessions.getSession(sessionId),
    runnerPrompt,
    nextResumeSessionId,
    attachments,
    nextProvider,
    startModel,
    nextProvider === 'claude' ? nextCompatibleProviderId : undefined,
    nextBetas,
    claudeAccessMode,
    nextProvider === 'codex' ? (nextCodexPermissionMode || 'defaultPermissions') : undefined
  );
  return true;
}

// 启动 Runner
function startRunner(
  mainWindow: BrowserWindow,
  session: ReturnType<typeof sessions.getSession>,
  prompt: string,
  resumeSessionId?: string,
  attachments?: Attachment[],
  providerOverride?: 'claude' | 'codex' | 'opencode',
  modelOverride?: string,
  compatibleProviderOverride?: import('../shared/types').ClaudeCompatibleProviderId,
  betasOverride?: string[],
  claudeAccessMode?: import('../shared/types').ClaudeAccessMode,
  codexPermissionMode?: import('../shared/types').CodexPermissionMode
): void {
  if (!session) return;

  const sessionState = getSessionState(session.id);
  const provider = providerOverride || session.provider || 'claude';
  const compatibleProviderId =
    provider === 'claude'
      ? compatibleProviderOverride || session.compatible_provider_id || undefined
      : undefined;

  const runner = provider === 'claude' ? runClaude : provider === 'codex' ? runCodex : runOpenCode;
  if (isDev()) {
    console.log('[Runner Select]', {
      sessionId: session.id,
      provider,
      runner: provider === 'claude' ? 'claude-agent-sdk' : provider === 'codex' ? 'codex-acp' : 'opencode acp',
      model: modelOverride,
      compatibleProviderId,
      cwd: session.cwd || process.cwd(),
      hasResume: !!resumeSessionId,
    });
  }

  let initMessage: Extract<StreamMessage, { type: 'system'; subtype: 'init' }> | null = null;
  let sawTurnOutput = false;

  const handle = runner({
    prompt,
    attachments,
    session,
    resumeSessionId,
    model: modelOverride,
    compatibleProviderId,
    betas: provider === 'claude' ? betasOverride || parseStoredBetas(session.betas) : undefined,
    claudeAccessMode,
    codexPermissionMode,
    onMessage: (message) => {
      // 提取并保存 claude session id
      if (message.type === 'system' && message.subtype === 'init') {
        initMessage = message;
        if (provider === 'codex') {
          sessions.updateCodexSessionId(session.id, message.session_id);
          if (message.model) {
            sessions.updateSessionModel(session.id, message.model);
          }
        } else if (provider === 'opencode') {
          sessions.updateOpencodeSessionId(session.id, message.session_id);
          if (message.model) {
            sessions.updateSessionModel(session.id, message.model);
          }
        } else {
          sessions.updateClaudeSessionId(session.id, message.session_id);
          const resolvedDisplayModel = reconcileClaudeDisplayModel(
            modelOverride || session.model,
            message.model
          );
          if (resolvedDisplayModel) {
            sessions.updateSessionModel(session.id, resolvedDisplayModel);
          }
        }

        broadcast(mainWindow, {
          type: 'session.status',
          payload: {
            sessionId: session.id,
            status: (sessions.getSession(session.id)?.status || 'running') as SessionStatus,
            provider,
            model:
              provider === 'claude'
                ? reconcileClaudeDisplayModel(modelOverride || session.model, message.model)
                : message.model || modelOverride || undefined,
            compatibleProviderId:
              provider === 'claude'
                ? sessions.getSession(session.id)?.compatible_provider_id || compatibleProviderId
                : undefined,
            betas:
              provider === 'claude'
                ? betasOverride || parseStoredBetas(sessions.getSession(session.id)?.betas)
                : undefined,
            claudeAccessMode:
              provider === 'claude'
                ? normalizeClaudeAccessMode(sessions.getSession(session.id)?.claude_access_mode || claudeAccessMode)
                : undefined,
            codexPermissionMode:
              provider === 'codex'
                ? normalizeCodexPermissionMode(sessions.getSession(session.id)?.codex_permission_mode || codexPermissionMode)
                : undefined,
            hiddenFromThreads: sessions.getSession(session.id)?.hidden_from_threads === 1,
          },
        });
      }

      if (message.type !== 'system' && message.type !== 'result') {
        sawTurnOutput = true;
      }

      const sanitizedStreamMessage =
        provider === 'claude' ? sanitizeClaudeAssistantMessage(message) : { message, removedInvalidThinking: false };
      if (provider === 'claude' && sanitizedStreamMessage.removedInvalidThinking) {
        sessions.setClaudeSessionId(session.id, null);
      }

      if (sanitizedStreamMessage.message) {
        // 保存消息
        sessions.addMessage(session.id, sanitizedStreamMessage.message);

        // 广播消息
        broadcast(mainWindow, {
          type: 'stream.message',
          payload: { sessionId: session.id, message: sanitizedStreamMessage.message },
        });
        void feishuBridge.handleSessionMessage(session.id, sanitizedStreamMessage.message);
      }

      // 检查是否为 result 消息，更新状态
      if (message.type === 'result') {
        const slashFailureMessage =
          provider === 'claude'
            ? detectSilentSlashCommandFailure(
                prompt,
                initMessage,
                message,
                sawTurnOutput,
                session.cwd
              )
            : null;

        if (slashFailureMessage) {
          const assistantMessage = buildLocalAssistantMessage(slashFailureMessage);
          sessions.addMessage(session.id, assistantMessage);
          broadcast(mainWindow, {
            type: 'stream.message',
            payload: { sessionId: session.id, message: assistantMessage },
          });
        }

        const status: SessionStatus = message.subtype === 'success' ? 'completed' : 'error';
        sessions.updateSessionStatus(session.id, status);
        broadcast(mainWindow, {
          type: 'session.status',
          payload: {
            sessionId: session.id,
            status,
            provider,
            model: sessions.getSession(session.id)?.model || modelOverride || undefined,
            compatibleProviderId:
              provider === 'claude'
                ? sessions.getSession(session.id)?.compatible_provider_id || compatibleProviderId
                : undefined,
            betas:
              provider === 'claude'
                ? betasOverride || parseStoredBetas(sessions.getSession(session.id)?.betas)
                : undefined,
            claudeAccessMode:
              provider === 'claude'
                ? normalizeClaudeAccessMode(sessions.getSession(session.id)?.claude_access_mode || claudeAccessMode)
                : undefined,
            codexPermissionMode:
              provider === 'codex'
                ? normalizeCodexPermissionMode(sessions.getSession(session.id)?.codex_permission_mode || codexPermissionMode)
                : undefined,
            hiddenFromThreads: sessions.getSession(session.id)?.hidden_from_threads === 1,
          },
        });
        if (provider === 'claude' && runnerHandles.get(session.id)?.handle === handle) {
          runnerHandles.delete(session.id);
        }
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Runner error:', error);

      sessions.updateSessionStatus(session.id, 'error');
      broadcast(mainWindow, {
        type: 'session.status',
        payload: {
          sessionId: session.id,
          status: 'error',
          hiddenFromThreads: session.hidden_from_threads === 1,
        },
      });
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: { message, sessionId: session.id },
      });
      void feishuBridge.handleRunnerError(session.id, message);

      if (runnerHandles.get(session.id)?.handle === handle) {
        runnerHandles.delete(session.id);
      }
    },
    onPermissionRequest: async (toolUseId, toolName, input) => {
      // 广播权限请求
      broadcast(mainWindow, {
        type: 'permission.request',
        payload: {
          sessionId: session.id,
          toolUseId,
          toolName,
          input: input as PermissionRequestInput,
        },
      });
      void feishuBridge.handlePermissionRequest({
        sessionId: session.id,
        toolUseId,
        toolName,
        input: input as PermissionRequestInput,
      });

      // 等待用户响应
      return new Promise<PermissionResult>((resolve, reject) => {
        sessionState.pendingPermissions.set(toolUseId, { resolve, reject });
      });
    },
  });

  runnerHandles.set(session.id, {
    handle,
    provider,
    compatibleProviderId,
    claudeAccessMode: provider === 'claude' ? (claudeAccessMode || 'default') : undefined,
    codexPermissionMode: provider === 'codex' ? normalizeCodexPermissionMode(codexPermissionMode) : undefined,
  });
}

// 获取会话历史
function handleSessionHistory(mainWindow: BrowserWindow, sessionId: string): void {
  const session = sessions.getSession(sessionId);
  if (!session) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'Unknown session', sessionId },
    });
    return;
  }

  const messages =
    session.provider === 'claude'
      ? sanitizeStoredClaudeHistory(sessionId, sessions.getSessionHistory(sessionId)).messages
      : sessions.getSessionHistory(sessionId);

  broadcast(mainWindow, {
    type: 'session.history',
    payload: {
      sessionId,
      status: session.status as SessionInfo['status'],
      messages,
    },
  });
}

// 停止会话
function handleSessionStop(mainWindow: BrowserWindow, sessionId: string): void {
  const session = sessions.getSession(sessionId);
  const entry = runnerHandles.get(sessionId);
  if (entry) {
    entry.handle.abort();
    runnerHandles.delete(sessionId);
  }

  // 拒绝所有 pending permissions
  const state = sessionStates.get(sessionId);
  if (state) {
    for (const [, { reject }] of state.pendingPermissions) {
      reject(new Error('Session aborted'));
    }
    state.pendingPermissions.clear();
  }

  // 更新状态为 idle（stop 不算 error）
  sessions.updateSessionStatus(sessionId, 'idle');

  broadcast(mainWindow, {
    type: 'session.status',
    payload: {
      sessionId,
      status: 'idle',
      hiddenFromThreads: session?.hidden_from_threads === 1,
    },
  });
}

// 删除会话
function handleSessionDelete(mainWindow: BrowserWindow, sessionId: string): void {
  // 先停止运行中的会话
  const entry = runnerHandles.get(sessionId);
  if (entry) {
    entry.handle.abort();
    runnerHandles.delete(sessionId);
  }

  // 清理状态
  sessionStates.delete(sessionId);

  // 删除数据库记录
  sessions.deleteSession(sessionId);

  // 广播删除事件（幂等）
  broadcast(mainWindow, {
    type: 'session.deleted',
    payload: { sessionId },
  });
}

// 处理权限响应
function handlePermissionResponse(
  payload: PermissionResponsePayload
): boolean {
  const { sessionId, toolUseId, result } = payload;

  const state = sessionStates.get(sessionId);
  if (!state) return false;

  const pending = state.pendingPermissions.get(toolUseId);
  if (pending) {
    pending.resolve(result);
    state.pendingPermissions.delete(toolUseId);
    return true;
  }
  return false;
}

// 获取 MCP 配置（返回全局和项目级分开）
function handleMcpGetConfig(mainWindow: BrowserWindow, projectPath?: string): void {
  const globalServers = getGlobalMcpServers();
  const projectServers = projectPath ? getProjectMcpServers(projectPath) : {};

  // 合并用于向后兼容
  const mergedServers = { ...globalServers, ...projectServers };

  broadcast(mainWindow, {
    type: 'mcp.config',
    payload: {
      servers: mergedServers,  // 向后兼容
      globalServers,
      projectServers,
    },
  });
}

// 保存 MCP 配置
function handleMcpSaveConfig(
  mainWindow: BrowserWindow,
  payload: {
    servers?: Record<string, McpServerConfig>;
    globalServers?: Record<string, McpServerConfig>;
    projectServers?: Record<string, McpServerConfig>;
    projectPath?: string;
  }
): void {
  // 保存全局配置
  if (payload.globalServers !== undefined) {
    saveMcpServers(payload.globalServers);
  } else if (payload.servers !== undefined) {
    // 向后兼容
    saveMcpServers(payload.servers);
  }

  // 保存项目级配置
  if (payload.projectPath && payload.projectServers !== undefined) {
    saveProjectMcpServers(payload.projectPath, payload.projectServers);
  }

  // 返回更新后的配置
  const globalServers = getGlobalMcpServers();
  const projectServers = payload.projectPath ? getProjectMcpServers(payload.projectPath) : {};

  broadcast(mainWindow, {
    type: 'mcp.config',
    payload: {
      servers: globalServers,
      globalServers,
      projectServers,
    },
  });
}

function handleSkillsList(mainWindow: BrowserWindow, projectPath?: string): void {
  broadcast(mainWindow, {
    type: 'skills.list',
    payload: listClaudeSkills(projectPath),
  });
}

// 设置会话 TodoState
function handleSessionSetTodoState(
  mainWindow: BrowserWindow,
  payload: { sessionId: string; todoState: TodoState }
): void {
  sessions.updateSessionTodoState(payload.sessionId, payload.todoState);
  broadcast(mainWindow, {
    type: 'session.todoStateChanged',
    payload: { sessionId: payload.sessionId, todoState: payload.todoState },
  });
}

// 切换会话置顶状态
function handleSessionTogglePin(
  mainWindow: BrowserWindow,
  payload: { sessionId: string }
): void {
  const newPinned = sessions.toggleSessionPinned(payload.sessionId);
  broadcast(mainWindow, {
    type: 'session.pinned',
    payload: { sessionId: payload.sessionId, pinned: newPinned },
  });
}

// 状态列表
function handleStatusList(mainWindow: BrowserWindow): void {
  const statuses = statusConfig.listStatuses();
  broadcast(mainWindow, {
    type: 'status.list',
    payload: { statuses },
  });
}

// 创建状态
function handleStatusCreate(
  mainWindow: BrowserWindow,
  payload: CreateStatusInput
): void {
  statusConfig.createStatus(payload);
  broadcastStatusChanged(mainWindow);
}

// 更新状态
function handleStatusUpdate(
  mainWindow: BrowserWindow,
  payload: { id: string; updates: UpdateStatusInput }
): void {
  statusConfig.updateStatus(payload.id, payload.updates);
  broadcastStatusChanged(mainWindow);
}

// 删除状态
function handleStatusDelete(
  mainWindow: BrowserWindow,
  payload: { id: string }
): void {
  statusConfig.deleteStatus(payload.id);
  broadcastStatusChanged(mainWindow);
}

// 重排序状态
function handleStatusReorder(
  mainWindow: BrowserWindow,
  payload: { orderedIds: string[] }
): void {
  statusConfig.reorderStatuses(payload.orderedIds);
  broadcastStatusChanged(mainWindow);
}

// 广播状态变更
function broadcastStatusChanged(mainWindow: BrowserWindow): void {
  const statuses = statusConfig.listStatuses();
  broadcast(mainWindow, {
    type: 'status.changed',
    payload: { statuses },
  });
}

// 文件夹列表
function handleFolderList(mainWindow: BrowserWindow): void {
  const folders = folderConfig.listFolders();
  broadcast(mainWindow, {
    type: 'folder.list',
    payload: { folders },
  });
}

// 创建文件夹
function handleFolderCreate(
  mainWindow: BrowserWindow,
  payload: { path: string; displayName?: string }
): void {
  try {
    folderConfig.createFolder(payload.path, payload.displayName);
    broadcastFolderChanged(mainWindow);
  } catch (error) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: `Failed to create folder: ${String(error)}` },
    });
  }
}

// 更新文件夹
function handleFolderUpdate(
  mainWindow: BrowserWindow,
  payload: { path: string; updates: Partial<FolderConfig> }
): void {
  try {
    folderConfig.updateFolder(payload.path, payload.updates);
    broadcastFolderChanged(mainWindow);
  } catch (error) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: `Failed to update folder: ${String(error)}` },
    });
  }
}

// 删除文件夹
function handleFolderDelete(
  mainWindow: BrowserWindow,
  payload: { path: string }
): void {
  try {
    folderConfig.deleteFolder(payload.path);
    // 清除该文件夹下所有 session 的文件夹路径
    sessions.clearSessionsFolderPath(payload.path);
    broadcastFolderChanged(mainWindow);
    // 重新发送 session 列表以更新 folderPath
    handleSessionList(mainWindow);
  } catch (error) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: `Failed to delete folder: ${String(error)}` },
    });
  }
}

// 移动/重命名文件夹
function handleFolderMove(
  mainWindow: BrowserWindow,
  payload: { oldPath: string; newPath: string }
): void {
  try {
    const { oldPaths, newPaths } = folderConfig.moveFolder(payload.oldPath, payload.newPath);
    // 更新 session 的文件夹路径
    for (let i = 0; i < oldPaths.length; i++) {
      sessions.updateSessionsInFolder(oldPaths[i], newPaths[i]);
    }
    broadcastFolderChanged(mainWindow);
    // 重新发送 session 列表以更新 folderPath
    handleSessionList(mainWindow);
  } catch (error) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: `Failed to move folder: ${String(error)}` },
    });
  }
}

// 设置 session 文件夹
function handleSessionSetFolder(
  mainWindow: BrowserWindow,
  payload: { sessionId: string; folderPath: string | null }
): void {
  try {
    // 如果设置了文件夹路径，确保文件夹存在
    if (payload.folderPath) {
      folderConfig.ensureFolderExists(payload.folderPath);
    }
    sessions.updateSessionFolderPath(payload.sessionId, payload.folderPath);
    broadcast(mainWindow, {
      type: 'session.folderChanged',
      payload: { sessionId: payload.sessionId, folderPath: payload.folderPath },
    });
    // 如果创建了新文件夹，广播文件夹变更
    if (payload.folderPath) {
      broadcastFolderChanged(mainWindow);
    }
  } catch (error) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: `Failed to set session folder: ${String(error)}` },
    });
  }
}

// 广播文件夹变更
function broadcastFolderChanged(mainWindow: BrowserWindow): void {
  const folders = folderConfig.listFolders();
  broadcast(mainWindow, {
    type: 'folder.changed',
    payload: { folders },
  });
}

// 清理资源
export function cleanup(): void {
  ipcMain.removeAllListeners('client-event');
  // 停止所有运行中的 runner
  for (const [, entry] of runnerHandles) {
    entry.handle.abort();
  }
  runnerHandles.clear();
  sessionStates.clear();

  // 关闭数据库
  sessions.close();
}
