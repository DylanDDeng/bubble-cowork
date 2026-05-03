import Database from 'better-sqlite3';
import { app } from 'electron';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_WORKSPACE_CHANNEL_ID } from '../../shared/types';
import type { SessionRow, StreamMessage, SessionStatus } from '../types';
import type { ArtifactRow, DerivedSummaryRow } from '../types';
import type {
  ChatSessionSearchResult,
  ClaudeAccessMode,
  ClaudeExecutionMode,
  ClaudeReasoningEffort,
  ClaudeCompatibleProviderId,
  CodexExecutionMode,
  CodexPermissionMode,
  CodexReasoningEffort,
  OpenCodePermissionMode,
  ClaudeModelUsage,
  LatestClaudeModelUsage,
  ClaudeUsageModelSummary,
  ClaudeUsageRangeDays,
  ClaudeUsageReport,
  SessionSource,
  SessionScope,
} from '../../shared/types';

let db: Database.Database | null = null;
const DAY_MS = 24 * 60 * 60 * 1000;
const claudeUsageReportCache = new Map<
  ClaudeUsageRangeDays,
  { version: number; dayStart: number; report: ClaudeUsageReport }
>();
const codexUsageReportCache = new Map<
  ClaudeUsageRangeDays,
  { version: number; dayStart: number; report: ClaudeUsageReport }
>();
const opencodeUsageReportCache = new Map<
  ClaudeUsageRangeDays,
  { version: number; dayStart: number; report: ClaudeUsageReport }
>();
let codexRolloutPathIndex: Map<string, string> | null = null;
let claudeUsageReportDataVersion = 0;
let codexUsageReportDataVersion = 0;
let opencodeUsageReportDataVersion = 0;
const EXTERNALIZED_MESSAGE_THRESHOLD_BYTES = 64 * 1024;
const MESSAGE_PAYLOAD_ARTIFACT_KIND = 'message-payload';
const MAX_SEARCH_TEXT_CHARS = 12_000;

type ExternalizedMessagePointer = {
  __aegisStorage: 'external-message-payload-v1';
  artifactKind: typeof MESSAGE_PAYLOAD_ARTIFACT_KIND;
  artifactPath: string;
};

type MessageArtifactPersistenceRecord = {
  kind: typeof MESSAGE_PAYLOAD_ARTIFACT_KIND;
  filePath: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
};

type MessagePersistenceRecord = {
  id: string;
  sessionId: string;
  messageType: string;
  sourceOrigin: SessionSource;
  searchText: string;
  sortKey: number;
  data: string;
  createdAt: number;
  artifact?: MessageArtifactPersistenceRecord;
};

export type BuiltinMemoryRolloutStatus =
  | 'pending'
  | 'processing'
  | 'extracted'
  | 'skipped'
  | 'consolidated'
  | 'failed';

export interface BuiltinMemoryRolloutRow {
  session_id: string;
  agent_id: string;
  status: BuiltinMemoryRolloutStatus;
  model: string | null;
  attempts: number;
  last_error: string | null;
  rollout_summary: string | null;
  rollout_slug: string | null;
  created_at: number;
  updated_at: number;
  claimed_at: number | null;
  extracted_at: number | null;
  consolidated_at: number | null;
}

export interface BuiltinMemoryCandidateInput {
  text: string;
  reason?: string | null;
  confidence?: string | null;
}

export interface BuiltinMemoryCandidateRow {
  id: string;
  session_id: string;
  agent_id: string;
  text: string;
  reason: string | null;
  confidence: string | null;
  dedupe_key: string;
  created_at: number;
  consolidated_at: number | null;
}

function normalizeClaudeAccessMode(
  value?: string | null
): ClaudeAccessMode {
  return value === 'fullAccess' ? 'fullAccess' : 'default';
}

function normalizeClaudeExecutionMode(
  value?: string | null
): ClaudeExecutionMode {
  return value === 'plan' ? 'plan' : 'execute';
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
      return 'high';
  }
}

function normalizeCodexPermissionMode(
  value?: string | null
): CodexPermissionMode {
  return value === 'fullAccess' || value === 'fullAuto'
    ? 'fullAccess'
    : 'defaultPermissions';
}

function normalizeCodexExecutionMode(
  value?: string | null
): CodexExecutionMode {
  return value === 'plan' ? 'plan' : 'execute';
}

function normalizeCodexReasoningEffort(
  value?: string | null
): CodexReasoningEffort | null {
  switch ((value || '').trim().toLowerCase()) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
      return value!.trim().toLowerCase() as CodexReasoningEffort;
    default:
      return null;
  }
}

function normalizeOpenCodePermissionMode(
  value?: string | null
): OpenCodePermissionMode {
  return value === 'fullAccess' || value === 'fullAuto'
    ? 'fullAccess'
    : 'defaultPermissions';
}

function normalizeWorkspaceChannelId(value?: string | null): string {
  const trimmed = value?.trim();
  return trimmed || DEFAULT_WORKSPACE_CHANNEL_ID;
}

function normalizeSessionScope(value?: string | null): SessionScope {
  return value === 'dm' ? 'dm' : 'project';
}

// 初始化数据库
export function initialize(): void {
  const dbPath = join(app.getPath('userData'), 'sessions.db');
  db = new Database(dbPath);

  // 启用 WAL 模式
  db.pragma('journal_mode = WAL');

  // 创建表
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      claude_session_id TEXT,
      codex_session_id TEXT,
      opencode_session_id TEXT,
      provider TEXT NOT NULL DEFAULT 'claude',
      model TEXT,
      conversation_scope TEXT DEFAULT 'project',
      agent_id TEXT,
      compatible_provider_id TEXT,
      betas TEXT,
      claude_access_mode TEXT DEFAULT 'default',
      claude_execution_mode TEXT DEFAULT 'execute',
      claude_reasoning_effort TEXT DEFAULT 'high',
      codex_execution_mode TEXT DEFAULT 'execute',
      codex_permission_mode TEXT DEFAULT 'defaultPermissions',
      codex_reasoning_effort TEXT,
      codex_fast_mode INTEGER DEFAULT 0,
      opencode_permission_mode TEXT DEFAULT 'defaultPermissions',
      status TEXT NOT NULL DEFAULT 'idle',
      cwd TEXT,
      allowed_tools TEXT,
      last_prompt TEXT,
      session_origin TEXT NOT NULL DEFAULT 'aegis',
      external_file_path TEXT,
      external_file_mtime INTEGER,
      hidden_from_threads INTEGER DEFAULT 0,
      workspace_channel_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_type TEXT,
      source_origin TEXT,
      search_text TEXT,
      sort_key INTEGER,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT,
      kind TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mime_type TEXT,
      size_bytes INTEGER,
      sha256 TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS derived_summaries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT,
      scope TEXT NOT NULL,
      source_ids TEXT,
      summary TEXT NOT NULL,
      model TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS search_index (
      message_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      source_origin TEXT NOT NULL,
      text TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS builtin_memory_rollouts (
      session_id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      model TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      rollout_summary TEXT,
      rollout_slug TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      claimed_at INTEGER,
      extracted_at INTEGER,
      consolidated_at INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS builtin_memory_candidates (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      text TEXT NOT NULL,
      reason TEXT,
      confidence TEXT,
      dedupe_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      consolidated_at INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS builtin_memory_consolidations (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      candidate_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  ensureColumn('sessions', 'codex_session_id', 'TEXT');
  ensureColumn('sessions', 'opencode_session_id', 'TEXT');
  ensureColumn('sessions', 'provider', "TEXT NOT NULL DEFAULT 'claude'");
  ensureColumn('sessions', 'model', 'TEXT');
  ensureColumn('sessions', 'conversation_scope', "TEXT DEFAULT 'project'");
  ensureColumn('sessions', 'agent_id', 'TEXT');
  ensureColumn('sessions', 'compatible_provider_id', 'TEXT');
  ensureColumn('sessions', 'betas', 'TEXT');
  ensureColumn('sessions', 'claude_access_mode', "TEXT DEFAULT 'default'");
  ensureColumn('sessions', 'claude_execution_mode', "TEXT DEFAULT 'execute'");
  ensureColumn('sessions', 'claude_reasoning_effort', "TEXT DEFAULT 'high'");
  ensureColumn('sessions', 'codex_execution_mode', "TEXT DEFAULT 'execute'");
  ensureColumn('sessions', 'codex_permission_mode', "TEXT DEFAULT 'defaultPermissions'");
  ensureColumn('sessions', 'codex_reasoning_effort', 'TEXT');
  ensureColumn('sessions', 'codex_fast_mode', 'INTEGER DEFAULT 0');
  ensureColumn('sessions', 'opencode_permission_mode', "TEXT DEFAULT 'defaultPermissions'");
  ensureColumn('sessions', 'todo_state', "TEXT DEFAULT 'todo'");
  ensureColumn('sessions', 'pinned', 'INTEGER DEFAULT 0');
  ensureColumn('sessions', 'folder_path', 'TEXT');
  ensureColumn('sessions', 'session_origin', "TEXT NOT NULL DEFAULT 'aegis'");
  ensureColumn('sessions', 'external_file_path', 'TEXT');
  ensureColumn('sessions', 'external_file_mtime', 'INTEGER');
  ensureColumn('sessions', 'hidden_from_threads', 'INTEGER DEFAULT 0');
  ensureColumn('sessions', 'workspace_channel_id', 'TEXT');
  ensureColumn('messages', 'message_type', 'TEXT');
  ensureColumn('messages', 'source_origin', 'TEXT');
  ensureColumn('messages', 'search_text', 'TEXT');
  ensureColumn('messages', 'sort_key', 'INTEGER');

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_sort_key ON messages(sort_key);
    CREATE INDEX IF NOT EXISTS idx_messages_message_type ON messages(message_type);
    CREATE INDEX IF NOT EXISTS idx_artifacts_session_id ON artifacts(session_id);
    CREATE INDEX IF NOT EXISTS idx_derived_summaries_session_id ON derived_summaries(session_id);
    CREATE INDEX IF NOT EXISTS idx_search_index_session_id ON search_index(session_id);
    CREATE INDEX IF NOT EXISTS idx_builtin_memory_rollouts_agent_status ON builtin_memory_rollouts(agent_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_builtin_memory_candidates_agent_pending ON builtin_memory_candidates(agent_id, consolidated_at, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_builtin_memory_candidates_dedupe ON builtin_memory_candidates(agent_id, dedupe_key);
    CREATE INDEX IF NOT EXISTS idx_builtin_memory_consolidations_agent ON builtin_memory_consolidations(agent_id, created_at);
  `);

  const backfilledCount = backfillClaudeSessionModelsFromInitMessages();
  if (backfilledCount > 0) {
    console.log(`[session-store] Backfilled ${backfilledCount} Claude session model values from init messages.`);
  }
  backfillMessageMetadata();
  backfillExternalizedMessagePayloads();
  rebalanceSearchIndexText();
}

function ensureColumn(table: string, column: string, definition: string): void {
  const rows = getDb().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (rows.some((row) => row.name === column)) {
    return;
  }
  getDb().exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function invalidateClaudeUsageReportCache(): void {
  claudeUsageReportDataVersion += 1;
  claudeUsageReportCache.clear();
  codexUsageReportDataVersion += 1;
  codexUsageReportCache.clear();
  opencodeUsageReportDataVersion += 1;
  opencodeUsageReportCache.clear();
}

function extractMessageType(message: StreamMessage): string {
  return message.type;
}

function extractSearchableMessageText(message: StreamMessage): string {
  if (message.type === 'user_prompt') {
    return message.prompt || '';
  }

  if (message.type === 'assistant') {
    return message.message.content
      .map((block) => {
        if (block.type === 'text') return block.text;
        if (block.type === 'thinking') return block.thinking;
        if (block.type === 'tool_use') {
          try {
            return `${block.name} ${JSON.stringify(block.input)}`;
          } catch {
            return block.name;
          }
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (message.type === 'user') {
    return message.message.content
      .map((block) => {
        if (block.type === 'text') return block.text;
        if (block.type === 'tool_result') return block.content;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (message.type === 'system') {
    if (message.subtype === 'compact_boundary') {
      return 'Conversation compacted';
    }
    if (message.subtype === 'available_commands_update') {
      return message.availableCommands.map((command) => `${command.name} ${command.description}`).join('\n');
    }
    if (message.subtype === 'init') {
      return `${message.model} ${message.cwd}`;
    }
  }

  if (message.type === 'result') {
    return message.subtype || '';
  }

  return '';
}

function normalizeSearchText(text: string): string {
  if (!text) {
    return '';
  }

  if (text.length <= MAX_SEARCH_TEXT_CHARS) {
    return text;
  }

  const headLength = 8_000;
  const tailLength = 3_500;
  return `${text.slice(0, headLength)}\n\n[...truncated for search index...]\n\n${text.slice(-tailLength)}`;
}

function getSessionSourceOrigin(sessionId: string): SessionSource {
  const row = getDb().prepare(
    'SELECT session_origin, provider FROM sessions WHERE id = ?'
  ).get(sessionId) as { session_origin?: string | null; provider?: string | null } | undefined;

  if (!row) {
    return 'aegis';
  }

  if (row.session_origin === 'claude_code') {
    return 'claude_code';
  }
  if (row.session_origin === 'claude_remote') {
    return 'claude_remote';
  }
  if (row.provider === 'codex') {
    return 'codex_local';
  }
  if (row.provider === 'opencode') {
    return 'opencode_local';
  }
  return 'aegis';
}

function getMessageArtifactsRoot(): string {
  const root = join(app.getPath('userData'), 'message-artifacts');
  mkdirSync(root, { recursive: true });
  return root;
}

function getMessageArtifactPath(sessionId: string, messageId: string): string {
  const sessionDir = join(getMessageArtifactsRoot(), sessionId);
  mkdirSync(sessionDir, { recursive: true });
  return join(sessionDir, `${messageId}.json`);
}

function isExternalizedMessagePointer(value: unknown): value is ExternalizedMessagePointer {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__aegisStorage' in value &&
    (value as { __aegisStorage?: unknown }).__aegisStorage === 'external-message-payload-v1'
  );
}

function shouldExternalizeMessagePayload(message: StreamMessage, rawData: string): boolean {
  if (message.type === 'stream_event') {
    return false;
  }

  return Buffer.byteLength(rawData, 'utf8') >= EXTERNALIZED_MESSAGE_THRESHOLD_BYTES;
}

function externalizeMessagePayload(
  sessionId: string,
  messageId: string,
  rawData: string
): { storedData: string; artifact: MessageArtifactPersistenceRecord } {
  const filePath = getMessageArtifactPath(sessionId, messageId);
  writeFileSync(filePath, rawData, 'utf8');

  const sizeBytes = Buffer.byteLength(rawData, 'utf8');
  const sha256 = createHash('sha256').update(rawData).digest('hex');
  const pointer: ExternalizedMessagePointer = {
    __aegisStorage: 'external-message-payload-v1',
    artifactKind: MESSAGE_PAYLOAD_ARTIFACT_KIND,
    artifactPath: filePath,
  };

  return {
    storedData: JSON.stringify(pointer),
    artifact: {
      kind: MESSAGE_PAYLOAD_ARTIFACT_KIND,
      filePath,
      mimeType: 'application/json',
      sizeBytes,
      sha256,
    },
  };
}

function readStoredMessagePayload(data: string, createdAt: number): StreamMessage {
  const parsed = JSON.parse(data) as StreamMessage | ExternalizedMessagePointer;
  const materialized = isExternalizedMessagePointer(parsed)
    ? (JSON.parse(readFileSync(parsed.artifactPath, 'utf8')) as StreamMessage)
    : (parsed as StreamMessage);

  if (typeof (materialized as StreamMessage & { createdAt?: number }).createdAt !== 'number') {
    (materialized as StreamMessage & { createdAt?: number }).createdAt = createdAt;
  }

  return materialized;
}

function buildUnavailableStoredMessage(createdAt: number, reason: string): StreamMessage {
  return {
    type: 'assistant',
    uuid: uuidv4(),
    createdAt,
    message: {
      content: [
        {
          type: 'text',
          text: `[stored message payload unavailable: ${reason}]`,
        },
      ],
    },
  };
}

function buildMessagePersistenceRecord(
  sessionId: string,
  sourceOrigin: SessionSource,
  message: StreamMessage
): MessagePersistenceRecord {
  const createdAt =
    typeof (message as StreamMessage & { createdAt?: number }).createdAt === 'number'
      ? ((message as StreamMessage & { createdAt?: number }).createdAt as number)
      : Date.now();
  const id = (message as { uuid?: string }).uuid || uuidv4();
  const rawData = JSON.stringify(message);
  const externalized = shouldExternalizeMessagePayload(message, rawData)
    ? externalizeMessagePayload(sessionId, id, rawData)
    : null;

  return {
    id,
    sessionId,
    messageType: extractMessageType(message),
    sourceOrigin,
    searchText: normalizeSearchText(extractSearchableMessageText(message)),
    sortKey: createdAt,
    data: externalized?.storedData || rawData,
    createdAt,
    artifact: externalized?.artifact,
  };
}

function upsertMessagePayloadArtifact(
  sessionId: string,
  messageId: string,
  artifact: MessageArtifactPersistenceRecord
): void {
  const existing = getDb().prepare(`
    SELECT id, file_path
    FROM artifacts
    WHERE session_id = ? AND message_id = ? AND kind = ?
    LIMIT 1
  `).get(sessionId, messageId, MESSAGE_PAYLOAD_ARTIFACT_KIND) as { id: string; file_path: string } | undefined;

  if (existing) {
    getDb().prepare(`
      UPDATE artifacts
      SET file_path = ?, mime_type = ?, size_bytes = ?, sha256 = ?
      WHERE id = ?
    `).run(artifact.filePath, artifact.mimeType, artifact.sizeBytes, artifact.sha256, existing.id);
    if (existing.file_path !== artifact.filePath) {
      try {
        unlinkSync(existing.file_path);
      } catch {
        // ignore stale artifact file cleanup failures
      }
    }
    return;
  }

  addArtifact({
    sessionId,
    messageId,
    kind: artifact.kind,
    filePath: artifact.filePath,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
  });
}

function deleteArtifactFiles(filePaths: string[]): void {
  for (const filePath of filePaths) {
    try {
      unlinkSync(filePath);
    } catch {
      // ignore cleanup failures
    }
  }
}

function listMessagePayloadArtifactsForSession(sessionId: string): Array<{ id: string; message_id: string | null; file_path: string }> {
  return getDb().prepare(`
    SELECT id, message_id, file_path
    FROM artifacts
    WHERE session_id = ? AND kind = ?
  `).all(sessionId, MESSAGE_PAYLOAD_ARTIFACT_KIND) as Array<{ id: string; message_id: string | null; file_path: string }>;
}

function deleteMessagePayloadArtifactForMessage(sessionId: string, messageId: string): void {
  const rows = getDb().prepare(`
    SELECT id, file_path
    FROM artifacts
    WHERE session_id = ? AND message_id = ? AND kind = ?
  `).all(sessionId, messageId, MESSAGE_PAYLOAD_ARTIFACT_KIND) as Array<{ id: string; file_path: string }>;

  if (rows.length === 0) {
    return;
  }

  const deleteStmt = getDb().prepare('DELETE FROM artifacts WHERE id = ?');
  for (const row of rows) {
    deleteStmt.run(row.id);
    try {
      unlinkSync(row.file_path);
    } catch {
      // ignore cleanup failures
    }
  }
}

function backfillMessageMetadata(): void {
  const rows = getDb().prepare(`
    SELECT m.id, m.session_id, m.data, m.created_at, s.session_origin, s.provider
    FROM messages m
    INNER JOIN sessions s ON s.id = m.session_id
    WHERE m.message_type IS NULL
       OR m.source_origin IS NULL
       OR m.search_text IS NULL
       OR m.sort_key IS NULL
  `).all() as Array<{
    id: string;
    session_id: string;
    data: string;
    created_at: number;
    session_origin: string | null;
    provider: string | null;
  }>;

  if (rows.length === 0) {
    return;
  }

  const updateStmt = getDb().prepare(`
    UPDATE messages
    SET message_type = ?, source_origin = ?, search_text = ?, sort_key = ?
    WHERE id = ?
  `);
  const upsertSearchIndexStmt = getDb().prepare(`
    INSERT INTO search_index (message_id, session_id, source_origin, text, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET
      session_id = excluded.session_id,
      source_origin = excluded.source_origin,
      text = excluded.text,
      updated_at = excluded.updated_at
  `);

  const transaction = getDb().transaction(() => {
    for (const row of rows) {
      try {
        const parsed = readStoredMessagePayload(row.data, row.created_at);
        const sourceOrigin =
          row.session_origin === 'claude_code'
            ? 'claude_code'
            : row.session_origin === 'claude_remote'
              ? 'claude_remote'
              : row.provider === 'codex'
                ? 'codex_local'
                : row.provider === 'opencode'
                  ? 'opencode_local'
                  : 'aegis';
        const searchText = normalizeSearchText(extractSearchableMessageText(parsed));
        updateStmt.run(extractMessageType(parsed), sourceOrigin, searchText, row.created_at, row.id);
        upsertSearchIndexStmt.run(row.id, row.session_id, sourceOrigin, searchText, row.created_at);
      } catch {
        continue;
      }
    }
  });

  transaction();
}

function rebalanceSearchIndexText(): void {
  const rows = getDb().prepare(`
    SELECT m.id, m.session_id, m.data, m.created_at, si.text AS indexed_text
    FROM messages m
    INNER JOIN search_index si ON si.message_id = m.id
    WHERE LENGTH(si.text) > ?
  `).all(MAX_SEARCH_TEXT_CHARS) as Array<{
    id: string;
    session_id: string;
    data: string;
    created_at: number;
    indexed_text: string;
  }>;

  if (rows.length === 0) {
    return;
  }

  const updateMessageStmt = getDb().prepare(`
    UPDATE messages
    SET search_text = ?
    WHERE id = ?
  `);
  const updateSearchIndexStmt = getDb().prepare(`
    UPDATE search_index
    SET text = ?, updated_at = ?
    WHERE message_id = ?
  `);

  const transaction = getDb().transaction(() => {
    for (const row of rows) {
      try {
        const message = readStoredMessagePayload(row.data, row.created_at);
        const nextSearchText = normalizeSearchText(extractSearchableMessageText(message));
        updateMessageStmt.run(nextSearchText, row.id);
        updateSearchIndexStmt.run(nextSearchText, row.created_at, row.id);
      } catch {
        continue;
      }
    }
  });

  transaction();
}

function backfillExternalizedMessagePayloads(): void {
  const rows = getDb().prepare(`
    SELECT m.id, m.session_id, m.data, m.created_at
    FROM messages m
    LEFT JOIN artifacts a
      ON a.message_id = m.id
      AND a.kind = ?
    WHERE a.id IS NULL
      AND LENGTH(m.data) >= ?
  `).all(MESSAGE_PAYLOAD_ARTIFACT_KIND, EXTERNALIZED_MESSAGE_THRESHOLD_BYTES / 2) as Array<{
    id: string;
    session_id: string;
    data: string;
    created_at: number;
  }>;

  if (rows.length === 0) {
    return;
  }

  const updateStmt = getDb().prepare(`
    UPDATE messages
    SET data = ?
    WHERE id = ?
  `);

  const transaction = getDb().transaction(() => {
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.data) as StreamMessage | ExternalizedMessagePointer;
        if (isExternalizedMessagePointer(parsed)) {
          continue;
        }
        if (!shouldExternalizeMessagePayload(parsed as StreamMessage, row.data)) {
          continue;
        }

        const externalized = externalizeMessagePayload(row.session_id, row.id, row.data);
        updateStmt.run(externalized.storedData, row.id);
        upsertMessagePayloadArtifact(row.session_id, row.id, externalized.artifact);
      } catch {
        continue;
      }
    }
  });

  transaction();
}

// 获取数据库实例
function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}

// 创建会话
export function createSession(params: {
  title: string;
  cwd?: string;
  allowedTools?: string;
  prompt?: string;
  provider?: 'aegis' | 'claude' | 'codex' | 'opencode';
  model?: string;
  scope?: SessionScope;
  agentId?: string | null;
  compatibleProviderId?: ClaudeCompatibleProviderId;
  betas?: string[];
  claudeAccessMode?: ClaudeAccessMode;
  claudeExecutionMode?: ClaudeExecutionMode;
  claudeReasoningEffort?: ClaudeReasoningEffort;
  codexExecutionMode?: CodexExecutionMode;
  codexPermissionMode?: CodexPermissionMode;
  codexReasoningEffort?: CodexReasoningEffort | null;
  codexFastMode?: boolean;
  opencodePermissionMode?: OpenCodePermissionMode;
  hiddenFromThreads?: boolean;
  channelId?: string;
}): SessionRow {
  const now = Date.now();
  const id = uuidv4();

  const stmt = getDb().prepare(`
    INSERT INTO sessions (id, title, provider, model, conversation_scope, agent_id, compatible_provider_id, betas, claude_access_mode, claude_execution_mode, claude_reasoning_effort, codex_execution_mode, codex_permission_mode, codex_reasoning_effort, codex_fast_mode, opencode_permission_mode, cwd, allowed_tools, last_prompt, todo_state, session_origin, external_file_path, external_file_mtime, hidden_from_threads, workspace_channel_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aegis', NULL, NULL, ?, ?, 'idle', ?, ?)
  `);

  stmt.run(
    id,
    params.title,
    params.provider || 'claude',
    params.model || null,
    normalizeSessionScope(params.scope),
    normalizeSessionScope(params.scope) === 'dm' ? params.agentId?.trim() || null : null,
    params.provider === 'claude' ? params.compatibleProviderId || null : null,
    params.betas && params.betas.length > 0 ? JSON.stringify(params.betas) : null,
    params.provider === 'claude' ? normalizeClaudeAccessMode(params.claudeAccessMode) : null,
    params.provider === 'claude' ? normalizeClaudeExecutionMode(params.claudeExecutionMode) : null,
    params.provider === 'claude' ? normalizeClaudeReasoningEffort(params.claudeReasoningEffort) : null,
    params.provider === 'codex' ? normalizeCodexExecutionMode(params.codexExecutionMode) : null,
    params.provider === 'codex' ? normalizeCodexPermissionMode(params.codexPermissionMode) : null,
    params.provider === 'codex' ? normalizeCodexReasoningEffort(params.codexReasoningEffort) : null,
    params.provider === 'codex' && params.codexFastMode ? 1 : 0,
    params.provider === 'opencode' ? normalizeOpenCodePermissionMode(params.opencodePermissionMode) : null,
    params.cwd || null,
    params.allowedTools || null,
    params.prompt || null,
    'todo',
    params.hiddenFromThreads ? 1 : 0,
    normalizeWorkspaceChannelId(params.channelId),
    now,
    now
  );

  if ((params.provider || 'claude') === 'claude') {
    invalidateClaudeUsageReportCache();
  }

  return getSession(id)!;
}

// 获取单个会话
export function getSession(sessionId: string): SessionRow | undefined {
  const stmt = getDb().prepare('SELECT * FROM sessions WHERE id = ?');
  return stmt.get(sessionId) as SessionRow | undefined;
}

// 获取所有会话
export function listSessions(): SessionRow[] {
  const stmt = getDb().prepare('SELECT * FROM sessions WHERE COALESCE(hidden_from_threads, 0) = 0 ORDER BY updated_at DESC');
  return stmt.all() as SessionRow[];
}

export function getExternalSessionSyncInfo(sessionId: string): Pick<
  SessionRow,
  'id' | 'external_file_path' | 'external_file_mtime' | 'session_origin'
> | undefined {
  const stmt = getDb().prepare(`
    SELECT id, external_file_path, external_file_mtime, session_origin
    FROM sessions
    WHERE id = ?
  `);
  return stmt.get(sessionId) as Pick<
    SessionRow,
    'id' | 'external_file_path' | 'external_file_mtime' | 'session_origin'
  > | undefined;
}

export function upsertExternalClaudeSession(params: {
  sessionId: string;
  title: string;
  cwd?: string | null;
  model?: string | null;
  createdAt: number;
  updatedAt: number;
  externalFilePath: string;
  externalFileMtime: number;
}): void {
  const stmt = getDb().prepare(`
    INSERT INTO sessions (
      id,
      title,
      claude_session_id,
      codex_session_id,
      opencode_session_id,
      provider,
      model,
      compatible_provider_id,
      betas,
      claude_access_mode,
      claude_execution_mode,
      codex_permission_mode,
      codex_reasoning_effort,
      codex_fast_mode,
      opencode_permission_mode,
      status,
      cwd,
      allowed_tools,
      last_prompt,
      session_origin,
      external_file_path,
      external_file_mtime,
      hidden_from_threads,
      created_at,
      updated_at
    )
    VALUES (?, ?, NULL, NULL, NULL, 'claude', ?, NULL, NULL, 'default', 'execute', NULL, NULL, 0, NULL, 'idle', ?, NULL, NULL, 'claude_code', ?, ?, 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      provider = 'claude',
      model = excluded.model,
      status = 'idle',
      cwd = excluded.cwd,
      session_origin = 'claude_code',
      external_file_path = excluded.external_file_path,
      external_file_mtime = excluded.external_file_mtime,
      updated_at = excluded.updated_at
  `);

  stmt.run(
    params.sessionId,
    params.title,
    params.model || null,
    params.cwd || null,
    params.externalFilePath,
    params.externalFileMtime,
    params.createdAt,
    params.updatedAt
  );
}

export function pruneMissingExternalClaudeSessions(validSessionIds: string[]): number {
  const existing = getDb()
    .prepare(`SELECT id FROM sessions WHERE session_origin = 'claude_code'`)
    .all() as Array<{ id: string }>;

  const valid = new Set(validSessionIds);
  const staleIds = existing.map((row) => row.id).filter((id) => !valid.has(id));
  for (const id of staleIds) {
    deleteSession(id);
  }
  return staleIds.length;
}

export function getLatestClaudeModelUsageBySession(): Record<string, LatestClaudeModelUsage> {
  const rows = getDb().prepare(`
    SELECT
      m.session_id AS session_id,
      m.data AS data,
      m.created_at AS created_at,
      s.model AS session_model
    FROM messages m
    INNER JOIN sessions s ON s.id = m.session_id
    WHERE s.provider = 'claude'
      AND m.message_type = 'result'
    ORDER BY m.created_at DESC
  `).all() as Array<{ session_id: string; data: string; created_at: number; session_model: string | null }>;

  const result: Record<string, LatestClaudeModelUsage> = {};

  for (const row of rows) {
    if (result[row.session_id]) {
      continue;
    }

    try {
      const parsed = readStoredMessagePayload(row.data, row.created_at) as StoredClaudeResultMessage;
      const latest = selectLatestClaudeModelUsage(parsed, row.session_model);
      if (latest) {
        result[row.session_id] = latest;
      }
    } catch {
      continue;
    }
  }

  return result;
}

// 更新会话状态
export function updateSessionStatus(sessionId: string, status: SessionStatus): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(status, now, sessionId);
}

// 更新 Claude Session ID
export function updateClaudeSessionId(sessionId: string, claudeSessionId: string): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET claude_session_id = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(claudeSessionId, now, sessionId);
}

export function setClaudeSessionId(sessionId: string, claudeSessionId: string | null): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET claude_session_id = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(claudeSessionId, now, sessionId);
}

// 更新 Codex Session ID
export function updateCodexSessionId(sessionId: string, codexSessionId: string): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET codex_session_id = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(codexSessionId, now, sessionId);
}

export function setCodexSessionId(sessionId: string, codexSessionId: string | null): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET codex_session_id = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(codexSessionId, now, sessionId);
}

// 更新 OpenCode Session ID
export function updateOpencodeSessionId(sessionId: string, opencodeSessionId: string): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET opencode_session_id = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(opencodeSessionId, now, sessionId);
}

export function setOpencodeSessionId(sessionId: string, opencodeSessionId: string | null): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET opencode_session_id = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(opencodeSessionId, now, sessionId);
}

// 更新 Session Provider
export function updateSessionProvider(sessionId: string, provider: 'aegis' | 'claude' | 'codex' | 'opencode'): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET provider = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(provider, now, sessionId);
  invalidateClaudeUsageReportCache();
}

export function updateSessionModel(sessionId: string, model: string | null): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(model, now, sessionId);
  invalidateClaudeUsageReportCache();
}

export function updateSessionCompatibleProviderId(
  sessionId: string,
  compatibleProviderId: ClaudeCompatibleProviderId | null
): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET compatible_provider_id = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(compatibleProviderId, now, sessionId);
}

export function updateSessionBetas(sessionId: string, betas: string[] | null): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET betas = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(betas && betas.length > 0 ? JSON.stringify(betas) : null, now, sessionId);
}

export function updateSessionClaudeAccessMode(
  sessionId: string,
  mode: ClaudeAccessMode | null
): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET claude_access_mode = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(mode ? normalizeClaudeAccessMode(mode) : null, now, sessionId);
}

export function updateSessionClaudeExecutionMode(
  sessionId: string,
  mode: ClaudeExecutionMode | null
): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET claude_execution_mode = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(mode ? normalizeClaudeExecutionMode(mode) : null, now, sessionId);
}

export function updateSessionClaudeReasoningEffort(
  sessionId: string,
  effort: ClaudeReasoningEffort | null
): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET claude_reasoning_effort = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(effort ? normalizeClaudeReasoningEffort(effort) : null, now, sessionId);
}

export function updateSessionCodexPermissionMode(
  sessionId: string,
  mode: CodexPermissionMode | null
): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET codex_permission_mode = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(mode ? normalizeCodexPermissionMode(mode) : null, now, sessionId);
}

export function updateSessionCodexExecutionMode(
  sessionId: string,
  mode: CodexExecutionMode | null
): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET codex_execution_mode = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(mode ? normalizeCodexExecutionMode(mode) : null, now, sessionId);
}

export function updateSessionCodexReasoningEffort(
  sessionId: string,
  effort: CodexReasoningEffort | null
): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET codex_reasoning_effort = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(normalizeCodexReasoningEffort(effort), now, sessionId);
}

export function updateSessionCodexFastMode(
  sessionId: string,
  enabled: boolean
): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET codex_fast_mode = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(enabled ? 1 : 0, now, sessionId);
}

export function updateSessionOpenCodePermissionMode(
  sessionId: string,
  mode: OpenCodePermissionMode | null
): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET opencode_permission_mode = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(mode ? normalizeOpenCodePermissionMode(mode) : null, now, sessionId);
}

// 切换 Session Pinned 状态
export function toggleSessionPinned(sessionId: string): boolean {
  const session = getSession(sessionId);
  if (!session) return false;

  const newPinned = session.pinned ? 0 : 1;
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET pinned = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(newPinned, now, sessionId);
  return newPinned === 1;
}

// 更新 Session 文件夹路径
export function updateSessionFolderPath(sessionId: string, folderPath: string | null): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET folder_path = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(folderPath, now, sessionId);
}

// 更新 Session 所属 workspace channel
export function updateSessionChannelId(sessionId: string, channelId: string | null): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET workspace_channel_id = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(normalizeWorkspaceChannelId(channelId), now, sessionId);
}

// 批量更新指定文件夹（及其子文件夹）下的 session 的路径（用于文件夹重命名）
export function updateSessionsInFolder(oldPath: string, newPath: string): number {
  const now = Date.now();

  // 更新精确匹配的路径
  const stmt1 = getDb().prepare(`
    UPDATE sessions SET folder_path = ?, updated_at = ? WHERE folder_path = ?
  `);
  const result1 = stmt1.run(newPath, now, oldPath);

  // 更新所有子路径（oldPath/ 开头的）
  const stmt2 = getDb().prepare(`
    UPDATE sessions
    SET folder_path = ? || substr(folder_path, ?), updated_at = ?
    WHERE folder_path LIKE ?
  `);
  const result2 = stmt2.run(newPath, oldPath.length + 1, now, oldPath + '/%');

  return (result1.changes || 0) + (result2.changes || 0);
}

// 清除指定文件夹（及其子文件夹）下所有 session 的文件夹路径（用于文件夹删除）
export function clearSessionsFolderPath(folderPath: string): number {
  const now = Date.now();

  // 清除精确匹配的路径
  const stmt1 = getDb().prepare(`
    UPDATE sessions SET folder_path = NULL, updated_at = ? WHERE folder_path = ?
  `);
  const result1 = stmt1.run(now, folderPath);

  // 清除所有子路径
  const stmt2 = getDb().prepare(`
    UPDATE sessions SET folder_path = NULL, updated_at = ? WHERE folder_path LIKE ?
  `);
  const result2 = stmt2.run(now, folderPath + '/%');

  return (result1.changes || 0) + (result2.changes || 0);
}

// 更新最后的 prompt
export function updateLastPrompt(sessionId: string, prompt: string): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET last_prompt = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(prompt, now, sessionId);
}

// 更新会话标题
export function updateSessionTitle(sessionId: string, title: string): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(title, now, sessionId);
}

// 删除会话
export function deleteSession(sessionId: string): void {
  const artifactRows = listArtifactsForSession(sessionId);
  const artifactPaths = artifactRows.map((row) => row.file_path);
  // 由于设置了 CASCADE，删除 session 会自动删除关联的 messages
  const stmt = getDb().prepare('DELETE FROM sessions WHERE id = ?');
  stmt.run(sessionId);
  deleteArtifactFiles(artifactPaths);
  try {
    rmSync(join(getMessageArtifactsRoot(), sessionId), { recursive: true, force: true });
  } catch {
    // ignore session artifact directory cleanup failures
  }
  invalidateClaudeUsageReportCache();
}

// 添加消息
export function addMessage(sessionId: string, message: StreamMessage): void {
  const sourceOrigin = getSessionSourceOrigin(sessionId);
  const record = buildMessagePersistenceRecord(sessionId, sourceOrigin, message);

  const stmt = getDb().prepare(`
    INSERT INTO messages (id, session_id, message_type, source_origin, search_text, sort_key, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      message_type = excluded.message_type,
      source_origin = excluded.source_origin,
      search_text = excluded.search_text,
      sort_key = excluded.sort_key,
      data = excluded.data,
      created_at = excluded.created_at
  `);
  const searchIndexStmt = getDb().prepare(`
    INSERT INTO search_index (message_id, session_id, source_origin, text, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET
      session_id = excluded.session_id,
      source_origin = excluded.source_origin,
      text = excluded.text,
      updated_at = excluded.updated_at
  `);
  stmt.run(
    record.id,
    record.sessionId,
    record.messageType,
    record.sourceOrigin,
    record.searchText,
    record.sortKey,
    record.data,
    record.createdAt
  );
  if (record.artifact) {
    upsertMessagePayloadArtifact(sessionId, record.id, record.artifact);
  } else {
    deleteMessagePayloadArtifactForMessage(sessionId, record.id);
  }
  searchIndexStmt.run(
    record.id,
    record.sessionId,
    record.sourceOrigin,
    record.searchText,
    record.createdAt
  );

  if (
    message.type === 'result' ||
    (message.type === 'system' && message.subtype === 'init')
  ) {
    invalidateClaudeUsageReportCache();
  }
}

export function replaceSessionHistory(sessionId: string, messages: StreamMessage[]): void {
  const previousArtifacts = listMessagePayloadArtifactsForSession(sessionId);
  const deleteStmt = getDb().prepare('DELETE FROM messages WHERE session_id = ?');
  const deleteArtifactsStmt = getDb().prepare('DELETE FROM artifacts WHERE session_id = ? AND kind = ?');
  const deleteSearchIndexStmt = getDb().prepare('DELETE FROM search_index WHERE session_id = ?');
  const insertStmt = getDb().prepare(`
    INSERT INTO messages (id, session_id, message_type, source_origin, search_text, sort_key, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSearchIndexStmt = getDb().prepare(`
    INSERT INTO search_index (message_id, session_id, source_origin, text, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const sourceOrigin = getSessionSourceOrigin(sessionId);
  const nextArtifactPaths = new Set<string>();

  const transaction = getDb().transaction((nextMessages: StreamMessage[]) => {
    deleteStmt.run(sessionId);
    deleteArtifactsStmt.run(sessionId, MESSAGE_PAYLOAD_ARTIFACT_KIND);
    deleteSearchIndexStmt.run(sessionId);

    for (const message of nextMessages) {
      const record = buildMessagePersistenceRecord(sessionId, sourceOrigin, message);
      insertStmt.run(
        record.id,
        record.sessionId,
        record.messageType,
        record.sourceOrigin,
        record.searchText,
        record.sortKey,
        record.data,
        record.createdAt
      );
      if (record.artifact) {
        upsertMessagePayloadArtifact(sessionId, record.id, record.artifact);
        nextArtifactPaths.add(record.artifact.filePath);
      }
      insertSearchIndexStmt.run(
        record.id,
        record.sessionId,
        record.sourceOrigin,
        record.searchText,
        record.createdAt
      );
    }
  });

  transaction(messages);
  deleteArtifactFiles(
    previousArtifacts
      .map((artifact) => artifact.file_path)
      .filter((filePath) => !nextArtifactPaths.has(filePath))
  );
  invalidateClaudeUsageReportCache();
}

// 获取会话历史消息
export function getSessionHistory(sessionId: string): StreamMessage[] {
  const stmt = getDb().prepare(`
    SELECT data, created_at FROM messages WHERE session_id = ? ORDER BY COALESCE(sort_key, created_at) ASC, created_at ASC
  `);
  const rows = stmt.all(sessionId) as { data: string; created_at: number }[];

  return rows.map((row) => {
    try {
      return readStoredMessagePayload(row.data, row.created_at);
    } catch (error) {
      return buildUnavailableStoredMessage(
        row.created_at,
        error instanceof Error ? error.message : 'unknown storage error'
      );
    }
  });
}

function normalizeBuiltinMemoryAgentId(agentId?: string | null): string {
  return agentId?.trim() || 'default';
}

function buildBuiltinMemoryDedupeKey(text: string): string {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256').update(normalized).digest('hex');
}

export function enqueueBuiltinMemoryRollout(params: {
  sessionId: string;
  agentId?: string | null;
  model?: string | null;
}): void {
  const now = Date.now();
  const agentId = normalizeBuiltinMemoryAgentId(params.agentId);
  getDb().prepare(`
    INSERT INTO builtin_memory_rollouts (
      session_id,
      agent_id,
      status,
      model,
      attempts,
      last_error,
      created_at,
      updated_at
    )
    VALUES (?, ?, 'pending', ?, 0, NULL, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      agent_id = excluded.agent_id,
      status = CASE
        WHEN builtin_memory_rollouts.status = 'processing' THEN builtin_memory_rollouts.status
        ELSE 'pending'
      END,
      model = excluded.model,
      attempts = CASE
        WHEN builtin_memory_rollouts.status = 'processing' THEN builtin_memory_rollouts.attempts
        ELSE 0
      END,
      last_error = NULL,
      updated_at = excluded.updated_at,
      claimed_at = CASE
        WHEN builtin_memory_rollouts.status = 'processing' THEN builtin_memory_rollouts.claimed_at
        ELSE NULL
      END,
      extracted_at = CASE
        WHEN builtin_memory_rollouts.status = 'processing' THEN builtin_memory_rollouts.extracted_at
        ELSE NULL
      END,
      consolidated_at = NULL
  `).run(
    params.sessionId,
    agentId,
    params.model || null,
    now,
    now
  );
}

export function beginBuiltinMemoryRollout(sessionId: string): BuiltinMemoryRolloutRow | null {
  const now = Date.now();
  const result = getDb().prepare(`
    UPDATE builtin_memory_rollouts
    SET
      status = 'processing',
      attempts = attempts + 1,
      last_error = NULL,
      claimed_at = ?,
      updated_at = ?
    WHERE session_id = ?
      AND (
        status = 'pending'
        OR (status = 'failed' AND attempts < 3)
      )
  `).run(now, now, sessionId);

  if (!result.changes) {
    return null;
  }

  return getDb().prepare(`
    SELECT *
    FROM builtin_memory_rollouts
    WHERE session_id = ?
  `).get(sessionId) as BuiltinMemoryRolloutRow | null;
}

export function completeBuiltinMemoryExtraction(params: {
  sessionId: string;
  agentId?: string | null;
  rolloutSummary?: string | null;
  rolloutSlug?: string | null;
  candidates: BuiltinMemoryCandidateInput[];
}): void {
  const now = Date.now();
  const agentId = normalizeBuiltinMemoryAgentId(params.agentId);
  const insertCandidate = getDb().prepare(`
    INSERT OR IGNORE INTO builtin_memory_candidates (
      id,
      session_id,
      agent_id,
      text,
      reason,
      confidence,
      dedupe_key,
      created_at,
      consolidated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `);
  const updateRollout = getDb().prepare(`
    UPDATE builtin_memory_rollouts
    SET
      status = ?,
      rollout_summary = ?,
      rollout_slug = ?,
      extracted_at = ?,
      updated_at = ?
    WHERE session_id = ?
  `);

  const transaction = getDb().transaction(() => {
    for (const candidate of params.candidates) {
      const text = candidate.text.trim();
      if (!text) continue;
      insertCandidate.run(
        uuidv4(),
        params.sessionId,
        agentId,
        text,
        candidate.reason?.trim() || null,
        candidate.confidence?.trim() || null,
        buildBuiltinMemoryDedupeKey(text),
        now
      );
    }

    updateRollout.run(
      params.candidates.length > 0 ? 'extracted' : 'skipped',
      params.rolloutSummary?.trim() || null,
      params.rolloutSlug?.trim() || null,
      now,
      now,
      params.sessionId
    );
  });

  transaction();
}

export function failBuiltinMemoryRollout(sessionId: string, error: string): void {
  const now = Date.now();
  getDb().prepare(`
    UPDATE builtin_memory_rollouts
    SET
      status = 'failed',
      last_error = ?,
      updated_at = ?
    WHERE session_id = ?
  `).run(error.slice(0, 2000), now, sessionId);
}

export function listUnconsolidatedBuiltinMemoryCandidates(
  agentId?: string | null,
  limit = 24
): BuiltinMemoryCandidateRow[] {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  return getDb().prepare(`
    SELECT *
    FROM builtin_memory_candidates
    WHERE agent_id = ?
      AND consolidated_at IS NULL
    ORDER BY created_at ASC
    LIMIT ?
  `).all(normalizeBuiltinMemoryAgentId(agentId), safeLimit) as BuiltinMemoryCandidateRow[];
}

export function completeBuiltinMemoryConsolidation(params: {
  agentId?: string | null;
  candidateIds: string[];
  sessionIds: string[];
}): void {
  const now = Date.now();
  const candidateIds = Array.from(new Set(params.candidateIds.filter(Boolean)));
  const sessionIds = Array.from(new Set(params.sessionIds.filter(Boolean)));
  const agentId = normalizeBuiltinMemoryAgentId(params.agentId);
  const insertConsolidation = getDb().prepare(`
    INSERT INTO builtin_memory_consolidations (
      id,
      agent_id,
      status,
      candidate_count,
      error,
      created_at,
      updated_at
    )
    VALUES (?, ?, 'completed', ?, NULL, ?, ?)
  `);

  const transaction = getDb().transaction(() => {
    insertConsolidation.run(uuidv4(), agentId, candidateIds.length, now, now);

    if (candidateIds.length > 0) {
      const placeholders = candidateIds.map(() => '?').join(', ');
      getDb().prepare(`
        UPDATE builtin_memory_candidates
        SET consolidated_at = ?
        WHERE id IN (${placeholders})
      `).run(now, ...candidateIds);
    }

    if (sessionIds.length > 0) {
      const placeholders = sessionIds.map(() => '?').join(', ');
      getDb().prepare(`
        UPDATE builtin_memory_rollouts
        SET
          status = 'consolidated',
          consolidated_at = ?,
          updated_at = ?
        WHERE session_id IN (${placeholders})
      `).run(now, now, ...sessionIds);
    }
  });

  transaction();
}

export function failBuiltinMemoryConsolidation(params: {
  agentId?: string | null;
  error: string;
}): void {
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO builtin_memory_consolidations (
      id,
      agent_id,
      status,
      candidate_count,
      error,
      created_at,
      updated_at
    )
    VALUES (?, ?, 'failed', 0, ?, ?, ?)
  `).run(
    uuidv4(),
    normalizeBuiltinMemoryAgentId(params.agentId),
    params.error.slice(0, 2000),
    now,
    now
  );
}

export function addArtifact(params: {
  sessionId: string;
  messageId?: string | null;
  kind: string;
  filePath: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  sha256?: string | null;
}): ArtifactRow {
  const id = uuidv4();
  const createdAt = Date.now();
  getDb().prepare(`
    INSERT INTO artifacts (id, session_id, message_id, kind, file_path, mime_type, size_bytes, sha256, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.sessionId,
    params.messageId || null,
    params.kind,
    params.filePath,
    params.mimeType || null,
    params.sizeBytes ?? null,
    params.sha256 || null,
    createdAt
  );

  return {
    id,
    session_id: params.sessionId,
    message_id: params.messageId || null,
    kind: params.kind,
    file_path: params.filePath,
    mime_type: params.mimeType || null,
    size_bytes: params.sizeBytes ?? null,
    sha256: params.sha256 || null,
    created_at: createdAt,
  };
}

export function listArtifactsForSession(sessionId: string): ArtifactRow[] {
  return getDb()
    .prepare(`
      SELECT id, session_id, message_id, kind, file_path, mime_type, size_bytes, sha256, created_at
      FROM artifacts
      WHERE session_id = ?
      ORDER BY created_at DESC
    `)
    .all(sessionId) as ArtifactRow[];
}

export function upsertDerivedSummary(params: {
  sessionId: string;
  scope: string;
  summary: string;
  messageId?: string | null;
  sourceIds?: string[] | null;
  model?: string | null;
}): DerivedSummaryRow {
  const sourceIds = params.sourceIds && params.sourceIds.length > 0 ? JSON.stringify(params.sourceIds) : null;
  const existing = getDb().prepare(`
    SELECT id, created_at
    FROM derived_summaries
    WHERE session_id = ? AND scope = ? AND COALESCE(message_id, '') = COALESCE(?, '') AND COALESCE(source_ids, '') = COALESCE(?, '')
    LIMIT 1
  `).get(
    params.sessionId,
    params.scope,
    params.messageId || null,
    sourceIds
  ) as { id: string; created_at: number } | undefined;

  const now = Date.now();
  if (existing) {
    getDb().prepare(`
      UPDATE derived_summaries
      SET summary = ?, model = ?, updated_at = ?
      WHERE id = ?
    `).run(params.summary, params.model || null, now, existing.id);

    return {
      id: existing.id,
      session_id: params.sessionId,
      message_id: params.messageId || null,
      scope: params.scope,
      source_ids: sourceIds,
      summary: params.summary,
      model: params.model || null,
      created_at: existing.created_at,
      updated_at: now,
    };
  }

  const id = uuidv4();
  getDb().prepare(`
    INSERT INTO derived_summaries (id, session_id, message_id, scope, source_ids, summary, model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.sessionId,
    params.messageId || null,
    params.scope,
    sourceIds,
    params.summary,
    params.model || null,
    now,
    now
  );

  return {
    id,
    session_id: params.sessionId,
    message_id: params.messageId || null,
    scope: params.scope,
    source_ids: sourceIds,
    summary: params.summary,
    model: params.model || null,
    created_at: now,
    updated_at: now,
  };
}

export function listDerivedSummariesForSession(sessionId: string): DerivedSummaryRow[] {
  return getDb().prepare(`
    SELECT id, session_id, message_id, scope, source_ids, summary, model, created_at, updated_at
    FROM derived_summaries
    WHERE session_id = ?
    ORDER BY updated_at DESC
  `).all(sessionId) as DerivedSummaryRow[];
}

type JoinedClaudeMessageRow = {
  data: string;
  created_at: number;
  session_id: string;
  session_model: string | null;
};

type StoredClaudeResultMessage = Extract<StreamMessage, { type: 'result' }> & {
  modelUsage?: Record<string, Partial<ClaudeModelUsage>>;
};

type CodexSessionUsageRow = {
  session_id: string;
  codex_session_id: string;
  session_model: string | null;
};

type CodexThreadRow = {
  id: string;
  rollout_path: string;
  model: string | null;
  tokens_used: number;
};

type OpencodeSessionUsageRow = {
  session_id: string;
  opencode_session_id: string;
  session_model: string | null;
};

type OpencodeAssistantUsageRow = {
  session_id: string;
  created_at: number;
  model_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_cost_usd: number;
};

type CodexTokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

type CodexUsageSnapshot = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

function normalizeClaudeModelUsage(value: Partial<ClaudeModelUsage> | undefined): ClaudeModelUsage | null {
  if (!value) {
    return null;
  }

  return {
    inputTokens: toNumber(value.inputTokens),
    outputTokens: toNumber(value.outputTokens),
    cacheReadInputTokens: toNumber(value.cacheReadInputTokens),
    cacheCreationInputTokens: toNumber(value.cacheCreationInputTokens),
    costUSD: toNumber(value.costUSD),
    contextWindow: toNumber(value.contextWindow),
    maxOutputTokens: toNumber(value.maxOutputTokens),
    webSearchRequests: toNumber(value.webSearchRequests),
  };
}

function selectLatestClaudeModelUsage(
  result: StoredClaudeResultMessage,
  preferredModel?: string | null
): LatestClaudeModelUsage | undefined {
  const entries = Object.entries(result.modelUsage || {});
  if (entries.length === 0) {
    return undefined;
  }

  const preferred = preferredModel?.trim().toLowerCase();
  const exactMatch = preferred
    ? entries.find(([model]) => model.trim().toLowerCase() === preferred)
    : undefined;
  const chosen =
    exactMatch ||
    entries.sort((left, right) => {
      const leftTokens = toNumber(left[1].inputTokens) + toNumber(left[1].outputTokens);
      const rightTokens = toNumber(right[1].inputTokens) + toNumber(right[1].outputTokens);
      return rightTokens - leftTokens;
    })[0];

  if (!chosen) {
    return undefined;
  }

  const usage = normalizeClaudeModelUsage(chosen[1]);
  if (!usage || !usage.contextWindow) {
    return undefined;
  }

  return {
    model: chosen[0],
    usage,
  };
}

function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function formatDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function buildSearchSnippet(text: string, query: string): string {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerText.indexOf(lowerQuery);
  if (matchIndex === -1) {
    return text.slice(0, 140);
  }

  const start = Math.max(0, matchIndex - 36);
  const end = Math.min(text.length, matchIndex + query.length + 72);
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
}

function emptyModelSummary(model: string): ClaudeUsageModelSummary {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    sessionCount: 0,
    cacheReadTokens: 0,
  };
}

function createEmptyUsageReport(
  rangeDays: ClaudeUsageRangeDays,
  costMode: ClaudeUsageReport['costMode'] = 'actual',
  note?: string
): ClaudeUsageReport {
  return {
    rangeDays,
    costMode,
    ...(note ? { note } : {}),
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      totalCostUsd: 0,
      sessionCount: 0,
      cacheReadTokens: 0,
      cacheHitRate: 0,
    },
    models: [],
    daily: [],
  };
}

type CodexPriceEntry = {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
};

const CODEX_PRICE_TABLE: Array<{ pattern: RegExp; price: CodexPriceEntry }> = [
  {
    pattern: /^gpt-5\.4-mini(?:$|-)/i,
    price: { inputUsdPerMillion: 0.75, outputUsdPerMillion: 4.5, cachedInputUsdPerMillion: 0.075 },
  },
  {
    pattern: /^gpt-5\.4(?:$|-)/i,
    price: { inputUsdPerMillion: 2.5, outputUsdPerMillion: 15, cachedInputUsdPerMillion: 0.25 },
  },
  {
    pattern: /^gpt-5\.2(?:-codex)?(?:$|-)/i,
    price: { inputUsdPerMillion: 1.75, outputUsdPerMillion: 14, cachedInputUsdPerMillion: 0.175 },
  },
  {
    pattern: /^gpt-5\.1(?:-codex)?(?:$|-)/i,
    price: { inputUsdPerMillion: 1.25, outputUsdPerMillion: 10, cachedInputUsdPerMillion: 0.125 },
  },
];

function getCodexPriceEntry(model: string): CodexPriceEntry | null {
  const normalized = model.trim();
  if (!normalized) {
    return null;
  }

  const matched = CODEX_PRICE_TABLE.find((entry) => entry.pattern.test(normalized));
  return matched?.price || null;
}

function estimateCodexUsageCost(model: string, usage: CodexTokenUsage): number {
  const price = getCodexPriceEntry(model);
  if (!price) {
    return 0;
  }

  const cachedInputTokens = Math.min(usage.cachedInputTokens, usage.inputTokens);
  const uncachedInputTokens = Math.max(0, usage.inputTokens - cachedInputTokens);

  return (
    (uncachedInputTokens * price.inputUsdPerMillion) / 1_000_000 +
    (cachedInputTokens * price.cachedInputUsdPerMillion) / 1_000_000 +
    (usage.outputTokens * price.outputUsdPerMillion) / 1_000_000
  );
}

function getCodexStateDbPath(): string {
  return join(homedir(), '.codex', 'state_5.sqlite');
}

function getCodexSessionsRootPath(): string {
  return join(homedir(), '.codex', 'sessions');
}

function getOpencodeDbPath(): string {
  return join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

function readOpencodeAssistantUsageRows(
  sessionIds: string[],
  rangeStart: number
): OpencodeAssistantUsageRow[] {
  const opencodeDbPath = getOpencodeDbPath();
  if (!existsSync(opencodeDbPath) || sessionIds.length === 0) {
    return [];
  }

  let opencodeDb: Database.Database | null = null;
  try {
    opencodeDb = new Database(opencodeDbPath, { readonly: true, fileMustExist: true });
    const placeholders = sessionIds.map(() => '?').join(', ');
    const stmt = opencodeDb.prepare(`
      SELECT
        session_id,
        time_created AS created_at,
        json_extract(data, '$.modelID') AS model_id,
        COALESCE(json_extract(data, '$.tokens.input'), 0) AS input_tokens,
        COALESCE(json_extract(data, '$.tokens.output'), 0) AS output_tokens,
        COALESCE(json_extract(data, '$.tokens.cache.read'), 0) AS cache_read_tokens,
        COALESCE(json_extract(data, '$.tokens.cache.write'), 0) AS cache_write_tokens,
        COALESCE(json_extract(data, '$.cost'), 0) AS total_cost_usd
      FROM message
      WHERE session_id IN (${placeholders})
        AND time_created >= ?
        AND json_extract(data, '$.role') = 'assistant'
      ORDER BY time_created ASC
    `);

    return stmt.all(...sessionIds, rangeStart) as OpencodeAssistantUsageRow[];
  } catch {
    return [];
  } finally {
    opencodeDb?.close();
  }
}

function buildCodexRolloutPathIndex(): Map<string, string> {
  const result = new Map<string, string>();
  const rootPath = getCodexSessionsRootPath();
  if (!existsSync(rootPath)) {
    return result;
  }

  const queue = [rootPath];
  while (queue.length > 0) {
    const currentPath = queue.pop();
    if (!currentPath) {
      continue;
    }

    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = readdirSync(currentPath, { withFileTypes: true, encoding: 'utf8' }) as Array<{
        name: string;
        isDirectory: () => boolean;
        isFile: () => boolean;
      }>;
    } catch {
      continue;
    }

    for (const entry of entries) {
      const nextPath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        queue.push(nextPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) {
        continue;
      }

      const idMatch = entry.name.match(/-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i);
      if (!idMatch) {
        continue;
      }

      result.set(idMatch[1], nextPath);
    }
  }

  return result;
}

function findCodexRolloutPathById(id: string): string | null {
  if (!codexRolloutPathIndex) {
    codexRolloutPathIndex = buildCodexRolloutPathIndex();
  }

  const cached = codexRolloutPathIndex.get(id);
  if (cached) {
    return cached;
  }

  codexRolloutPathIndex = buildCodexRolloutPathIndex();
  return codexRolloutPathIndex.get(id) || null;
}

function readCodexThreadsById(ids: string[]): Map<string, CodexThreadRow> {
  const result = new Map<string, CodexThreadRow>();
  const stateDbPath = getCodexStateDbPath();
  if (!existsSync(stateDbPath) || ids.length === 0) {
    return result;
  }

  let stateDb: Database.Database | null = null;
  try {
    stateDb = new Database(stateDbPath, { readonly: true, fileMustExist: true });
    const stmt = stateDb.prepare(`
      SELECT id, rollout_path, model, tokens_used
      FROM threads
      WHERE id = ?
    `);

    for (const id of ids) {
      const row = stmt.get(id) as CodexThreadRow | undefined;
      if (row) {
        result.set(id, row);
      }
    }
  } catch {
    return result;
  } finally {
    stateDb?.close();
  }

  return result;
}

function parseCodexSnapshot(value: unknown): CodexUsageSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  return {
    inputTokens: toNumber(record.input_tokens),
    cachedInputTokens: toNumber(record.cached_input_tokens),
    outputTokens: toNumber(record.output_tokens),
    totalTokens: toNumber(record.total_tokens),
  };
}

function getCodexSnapshotKey(snapshot: CodexUsageSnapshot): string {
  return [
    snapshot.inputTokens,
    snapshot.cachedInputTokens,
    snapshot.outputTokens,
    snapshot.totalTokens,
  ].join(':');
}

function parseCodexRolloutUsage(params: {
  rolloutPath: string;
  fallbackModel: string;
  rangeStart: number;
  dailyMap: Map<string, {
    totalTokens: number;
    byModel: Record<string, number>;
    byModelCostUsd: Record<string, number>;
  }>;
  modelSummaries: Map<string, ClaudeUsageModelSummary>;
  modelSessions: Map<string, Set<string>>;
  sessionId: string;
}): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalCostUsd: number;
  totalTokens: number;
} {
  const result = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    totalCostUsd: 0,
    totalTokens: 0,
  };

  if (!existsSync(params.rolloutPath)) {
    return result;
  }

  const content = readFileSync(params.rolloutPath, 'utf8');
  let currentModel = params.fallbackModel;
  let previousSnapshotKey: string | null = null;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (parsed.type === 'turn_context') {
      const payload = parsed.payload as Record<string, unknown> | undefined;
      if (typeof payload?.model === 'string' && payload.model.trim()) {
        currentModel = payload.model.trim();
      }
      continue;
    }

    if (parsed.type !== 'event_msg') {
      continue;
    }

    const payload = parsed.payload as Record<string, unknown> | undefined;
    if (payload?.type !== 'token_count') {
      continue;
    }

    const info = payload.info as Record<string, unknown> | undefined;
    const lastUsage = parseCodexSnapshot(info?.last_token_usage);
    const totalUsage = parseCodexSnapshot(info?.total_token_usage);
    if (!lastUsage || !totalUsage) {
      continue;
    }

    const snapshotKey = getCodexSnapshotKey(totalUsage);
    if (snapshotKey === previousSnapshotKey) {
      continue;
    }
    previousSnapshotKey = snapshotKey;

    const timestamp = typeof parsed.timestamp === 'string' ? Date.parse(parsed.timestamp) : Number.NaN;
    if (!Number.isFinite(timestamp) || timestamp < params.rangeStart) {
      continue;
    }

    const model = currentModel || params.fallbackModel || 'Unknown';
    const usage: CodexTokenUsage = {
      inputTokens: lastUsage.inputTokens,
      cachedInputTokens: lastUsage.cachedInputTokens,
      outputTokens: lastUsage.outputTokens,
      totalTokens: lastUsage.totalTokens || lastUsage.inputTokens + lastUsage.outputTokens,
    };
    const estimatedCostUsd = estimateCodexUsageCost(model, usage);
    const dateKey = formatDateKey(timestamp);
    const dayBucket = params.dailyMap.get(dateKey);
    const summary = params.modelSummaries.get(model) || emptyModelSummary(model);

    result.inputTokens += usage.inputTokens;
    result.outputTokens += usage.outputTokens;
    result.cacheReadTokens += Math.min(usage.cachedInputTokens, usage.inputTokens);
    result.totalCostUsd += estimatedCostUsd;
    result.totalTokens += usage.totalTokens;

    summary.inputTokens += usage.inputTokens;
    summary.outputTokens += usage.outputTokens;
    summary.totalTokens += usage.totalTokens;
    summary.totalCostUsd += estimatedCostUsd;
    summary.cacheReadTokens += Math.min(usage.cachedInputTokens, usage.inputTokens);
    params.modelSummaries.set(model, summary);

    if (!params.modelSessions.has(model)) {
      params.modelSessions.set(model, new Set());
    }
    params.modelSessions.get(model)!.add(params.sessionId);

    if (dayBucket) {
      dayBucket.totalTokens += usage.totalTokens;
      dayBucket.byModel[model] = (dayBucket.byModel[model] || 0) + usage.totalTokens;
      dayBucket.byModelCostUsd[model] = (dayBucket.byModelCostUsd[model] || 0) + estimatedCostUsd;
    }
  }

  return result;
}

function backfillClaudeSessionModelsFromInitMessages(): number {
  const rows = getDb().prepare(`
    SELECT
      s.id AS session_id,
      m.data AS data,
      m.created_at AS created_at
    FROM sessions s
    INNER JOIN messages m ON m.session_id = s.id
    WHERE s.provider = 'claude'
      AND (s.model IS NULL OR s.model = '')
      AND m.message_type = 'system'
    ORDER BY s.id ASC, m.created_at DESC
  `).all() as Array<{ session_id: string; data: string; created_at: number }>;

  const updates = new Map<string, string>();
  for (const row of rows) {
    if (updates.has(row.session_id)) {
      continue;
    }

    try {
      const parsed = readStoredMessagePayload(row.data, row.created_at);
      if (parsed.type === 'system' && parsed.subtype === 'init' && parsed.model?.trim()) {
        updates.set(row.session_id, parsed.model.trim());
      }
    } catch {
      continue;
    }
  }

  if (updates.size === 0) {
    return 0;
  }

  const updateStmt = getDb().prepare('UPDATE sessions SET model = ? WHERE id = ?');
  const transaction = getDb().transaction(() => {
    for (const [sessionId, model] of updates.entries()) {
      updateStmt.run(model, sessionId);
    }
  });
  transaction();
  return updates.size;
}

export function getClaudeUsageReport(days: ClaudeUsageRangeDays = 30): ClaudeUsageReport {
  const safeDays: ClaudeUsageRangeDays = days === 7 || days === 90 ? days : 30;
  const todayStart = startOfLocalDay(Date.now());
  const rangeStart = todayStart - (safeDays - 1) * DAY_MS;
  const cached = claudeUsageReportCache.get(safeDays);
  if (cached && cached.version === claudeUsageReportDataVersion && cached.dayStart === todayStart) {
    return cached.report;
  }

  const rows = getDb().prepare(`
    SELECT
      m.data AS data,
      m.created_at AS created_at,
      s.id AS session_id,
      s.model AS session_model
    FROM messages m
    INNER JOIN sessions s ON s.id = m.session_id
    WHERE s.provider = 'claude'
      AND m.created_at >= ?
      AND m.message_type = 'result'
    ORDER BY m.created_at ASC
  `).all(rangeStart) as JoinedClaudeMessageRow[];

  const dailyMap = new Map<string, {
    totalTokens: number;
    byModel: Record<string, number>;
    byModelCostUsd: Record<string, number>;
  }>();
  for (let index = 0; index < safeDays; index += 1) {
    const dayStart = rangeStart + index * DAY_MS;
    dailyMap.set(formatDateKey(dayStart), { totalTokens: 0, byModel: {}, byModelCostUsd: {} });
  }

  const sessionIds = new Set<string>();
  const modelSummaries = new Map<string, ClaudeUsageModelSummary>();
  const modelSessions = new Map<string, Set<string>>();
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;

  for (const row of rows) {
    let parsed: StreamMessage;
    try {
      parsed = readStoredMessagePayload(row.data, row.created_at);
    } catch {
      continue;
    }

    if (parsed.type !== 'result') {
      continue;
    }

    const result = parsed as StoredClaudeResultMessage;
    const inputTokens = toNumber(result.usage?.input_tokens);
    const outputTokens = toNumber(result.usage?.output_tokens);
    const cacheReadTokens = toNumber(result.usage?.cache_read_input_tokens);
    const cacheCreationTokens = toNumber(result.usage?.cache_creation_input_tokens);
    const totalTokens = inputTokens + outputTokens;
    const dateKey = formatDateKey(row.created_at);
    const dayBucket = dailyMap.get(dateKey);

    totalInputTokens += inputTokens;
    totalOutputTokens += outputTokens;
    totalCostUsd += toNumber(result.total_cost_usd);
    totalCacheReadTokens += cacheReadTokens;
    totalCacheCreationTokens += cacheCreationTokens;
    sessionIds.add(row.session_id);

    const rawModelUsage = result.modelUsage;
    if (rawModelUsage && Object.keys(rawModelUsage).length > 0) {
      for (const [model, usage] of Object.entries(rawModelUsage)) {
        const summary = modelSummaries.get(model) || emptyModelSummary(model);
        const modelInputTokens = toNumber(usage.inputTokens);
        const modelOutputTokens = toNumber(usage.outputTokens);
        const modelTotalTokens = modelInputTokens + modelOutputTokens;

        summary.inputTokens += modelInputTokens;
        summary.outputTokens += modelOutputTokens;
        summary.totalTokens += modelTotalTokens;
        summary.totalCostUsd += toNumber(usage.costUSD);
        summary.cacheReadTokens += toNumber(usage.cacheReadInputTokens);
        modelSummaries.set(model, summary);

        if (!modelSessions.has(model)) {
          modelSessions.set(model, new Set());
        }
        if (modelTotalTokens > 0 || toNumber(usage.costUSD) > 0) {
          modelSessions.get(model)!.add(row.session_id);
        }

        if (dayBucket) {
          dayBucket.totalTokens += modelTotalTokens;
          dayBucket.byModel[model] = (dayBucket.byModel[model] || 0) + modelTotalTokens;
          dayBucket.byModelCostUsd[model] = (dayBucket.byModelCostUsd[model] || 0) + toNumber(usage.costUSD);
        }
      }
      continue;
    }

    const fallbackModel = row.session_model || 'Unknown';
    const summary = modelSummaries.get(fallbackModel) || emptyModelSummary(fallbackModel);
    summary.inputTokens += inputTokens;
    summary.outputTokens += outputTokens;
    summary.totalTokens += totalTokens;
    summary.totalCostUsd += toNumber(result.total_cost_usd);
    summary.cacheReadTokens += cacheReadTokens;
    modelSummaries.set(fallbackModel, summary);

    if (!modelSessions.has(fallbackModel)) {
      modelSessions.set(fallbackModel, new Set());
    }
    modelSessions.get(fallbackModel)!.add(row.session_id);

    if (dayBucket) {
      dayBucket.totalTokens += totalTokens;
      dayBucket.byModel[fallbackModel] = (dayBucket.byModel[fallbackModel] || 0) + totalTokens;
      dayBucket.byModelCostUsd[fallbackModel] =
        (dayBucket.byModelCostUsd[fallbackModel] || 0) + toNumber(result.total_cost_usd);
    }
  }

  const modelList = Array.from(modelSummaries.values())
    .map((summary) => ({
      ...summary,
      sessionCount: modelSessions.get(summary.model)?.size || 0,
    }))
    .sort((left, right) =>
      right.totalTokens - left.totalTokens ||
      right.totalCostUsd - left.totalCostUsd ||
      left.model.localeCompare(right.model)
    );

  const cacheDenominator = totalInputTokens + totalCacheReadTokens + totalCacheCreationTokens;

  const report = {
    rangeDays: safeDays,
    totals: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      totalCostUsd,
      sessionCount: sessionIds.size,
      cacheReadTokens: totalCacheReadTokens,
      cacheHitRate: cacheDenominator > 0 ? totalCacheReadTokens / cacheDenominator : 0,
    },
    models: modelList,
    daily: Array.from(dailyMap.entries()).map(([date, bucket]) => ({
      date,
      totalTokens: bucket.totalTokens,
      byModel: bucket.byModel,
      byModelCostUsd: bucket.byModelCostUsd,
    })),
  };

  claudeUsageReportCache.set(safeDays, {
    version: claudeUsageReportDataVersion,
    dayStart: todayStart,
    report,
  });

  return report;
}

export function getCodexUsageReport(days: ClaudeUsageRangeDays = 30): ClaudeUsageReport {
  const safeDays: ClaudeUsageRangeDays = days === 7 || days === 90 ? days : 30;
  const todayStart = startOfLocalDay(Date.now());
  const rangeStart = todayStart - (safeDays - 1) * DAY_MS;
  const cached = codexUsageReportCache.get(safeDays);
  if (cached && cached.version === codexUsageReportDataVersion && cached.dayStart === todayStart) {
    return cached.report;
  }

  const report = createEmptyUsageReport(
    safeDays,
    'estimated',
    'Cost is estimated from the OpenAI API price table. ChatGPT-plan billing may differ from this estimate.'
  );
  const dailyMap = new Map<string, {
    totalTokens: number;
    byModel: Record<string, number>;
    byModelCostUsd: Record<string, number>;
  }>();

  for (let index = 0; index < safeDays; index += 1) {
    const dayStart = rangeStart + index * DAY_MS;
    dailyMap.set(formatDateKey(dayStart), { totalTokens: 0, byModel: {}, byModelCostUsd: {} });
  }

  const sessionRows = getDb().prepare(`
    SELECT id AS session_id, codex_session_id AS codex_session_id, model AS session_model
    FROM sessions
    WHERE provider = 'codex'
      AND codex_session_id IS NOT NULL
      AND codex_session_id != ''
  `).all() as CodexSessionUsageRow[];

  if (sessionRows.length === 0) {
    report.daily = Array.from(dailyMap.entries()).map(([date, bucket]) => ({
      date,
      totalTokens: bucket.totalTokens,
      byModel: bucket.byModel,
      byModelCostUsd: bucket.byModelCostUsd,
    }));
    codexUsageReportCache.set(safeDays, {
      version: codexUsageReportDataVersion,
      dayStart: todayStart,
      report,
    });
    return report;
  }

  const rowsByThread = new Map<string, { sessionId: string; sessionModel: string | null }>();
  for (const row of sessionRows) {
    if (!rowsByThread.has(row.codex_session_id)) {
      rowsByThread.set(row.codex_session_id, {
        sessionId: row.session_id,
        sessionModel: row.session_model,
      });
    }
  }

  const uniqueThreadIds = Array.from(rowsByThread.keys());
  const threadsById = readCodexThreadsById(uniqueThreadIds);
  const modelSummaries = new Map<string, ClaudeUsageModelSummary>();
  const modelSessions = new Map<string, Set<string>>();
  const sessionsWithUsage = new Set<string>();

  for (const [threadId, sessionMeta] of rowsByThread.entries()) {
    const thread = threadsById.get(threadId);
    const rolloutPath = thread?.rollout_path || findCodexRolloutPathById(threadId);
    if (!rolloutPath) {
      continue;
    }

    const fallbackModel = sessionMeta.sessionModel || thread?.model || 'Unknown';
    const usage = parseCodexRolloutUsage({
      rolloutPath,
      fallbackModel,
      rangeStart,
      dailyMap,
      modelSummaries,
      modelSessions,
      sessionId: sessionMeta.sessionId,
    });

    if (usage.totalTokens <= 0 && usage.totalCostUsd <= 0) {
      continue;
    }

    report.totals.inputTokens += usage.inputTokens;
    report.totals.outputTokens += usage.outputTokens;
    report.totals.totalTokens += usage.totalTokens;
    report.totals.totalCostUsd += usage.totalCostUsd;
    report.totals.cacheReadTokens += usage.cacheReadTokens;
    sessionsWithUsage.add(sessionMeta.sessionId);
  }

  report.models = Array.from(modelSummaries.values())
    .map((summary) => ({
      ...summary,
      sessionCount: modelSessions.get(summary.model)?.size || 0,
    }))
    .sort((left, right) =>
      right.totalTokens - left.totalTokens ||
      right.totalCostUsd - left.totalCostUsd ||
      left.model.localeCompare(right.model)
    );

  report.daily = Array.from(dailyMap.entries()).map(([date, bucket]) => ({
    date,
    totalTokens: bucket.totalTokens,
    byModel: bucket.byModel,
    byModelCostUsd: bucket.byModelCostUsd,
  }));
  report.totals.sessionCount = sessionsWithUsage.size;
  report.totals.cacheHitRate =
    report.totals.inputTokens > 0 ? report.totals.cacheReadTokens / report.totals.inputTokens : 0;

  codexUsageReportCache.set(safeDays, {
    version: codexUsageReportDataVersion,
    dayStart: todayStart,
    report,
  });

  return report;
}

export function getOpencodeUsageReport(days: ClaudeUsageRangeDays = 30): ClaudeUsageReport {
  const safeDays: ClaudeUsageRangeDays = days === 7 || days === 90 ? days : 30;
  const todayStart = startOfLocalDay(Date.now());
  const rangeStart = todayStart - (safeDays - 1) * DAY_MS;
  const cached = opencodeUsageReportCache.get(safeDays);
  if (cached && cached.version === opencodeUsageReportDataVersion && cached.dayStart === todayStart) {
    return cached.report;
  }

  const report = createEmptyUsageReport(
    safeDays,
    'actual',
    'Only includes OpenCode sessions launched from Aegis.'
  );
  const dailyMap = new Map<string, {
    totalTokens: number;
    byModel: Record<string, number>;
    byModelCostUsd: Record<string, number>;
  }>();

  for (let index = 0; index < safeDays; index += 1) {
    const dayStart = rangeStart + index * DAY_MS;
    dailyMap.set(formatDateKey(dayStart), { totalTokens: 0, byModel: {}, byModelCostUsd: {} });
  }

  const sessionRows = getDb().prepare(`
    SELECT id AS session_id, opencode_session_id AS opencode_session_id, model AS session_model
    FROM sessions
    WHERE provider = 'opencode'
      AND opencode_session_id IS NOT NULL
      AND opencode_session_id != ''
  `).all() as OpencodeSessionUsageRow[];

  if (sessionRows.length === 0) {
    report.daily = Array.from(dailyMap.entries()).map(([date, bucket]) => ({
      date,
      totalTokens: bucket.totalTokens,
      byModel: bucket.byModel,
      byModelCostUsd: bucket.byModelCostUsd,
    }));
    opencodeUsageReportCache.set(safeDays, {
      version: opencodeUsageReportDataVersion,
      dayStart: todayStart,
      report,
    });
    return report;
  }

  const rowsByOpencodeSession = new Map<string, { sessionId: string; sessionModel: string | null }>();
  for (const row of sessionRows) {
    if (!rowsByOpencodeSession.has(row.opencode_session_id)) {
      rowsByOpencodeSession.set(row.opencode_session_id, {
        sessionId: row.session_id,
        sessionModel: row.session_model,
      });
    }
  }

  const usageRows = readOpencodeAssistantUsageRows(Array.from(rowsByOpencodeSession.keys()), rangeStart);
  const modelSummaries = new Map<string, ClaudeUsageModelSummary>();
  const modelSessions = new Map<string, Set<string>>();
  const sessionsWithUsage = new Set<string>();
  let totalCacheWriteTokens = 0;

  for (const row of usageRows) {
    const sessionMeta = rowsByOpencodeSession.get(row.session_id);
    if (!sessionMeta) {
      continue;
    }

    const model = row.model_id || sessionMeta.sessionModel || 'Unknown';
    const inputTokens = toNumber(row.input_tokens);
    const outputTokens = toNumber(row.output_tokens);
    const cacheReadTokens = toNumber(row.cache_read_tokens);
    const cacheWriteTokens = toNumber(row.cache_write_tokens);
    const totalCostUsd = toNumber(row.total_cost_usd);
    const totalTokens = inputTokens + outputTokens;

    if (totalTokens <= 0 && totalCostUsd <= 0 && cacheReadTokens <= 0 && cacheWriteTokens <= 0) {
      continue;
    }

    const summary = modelSummaries.get(model) || emptyModelSummary(model);
    summary.inputTokens += inputTokens;
    summary.outputTokens += outputTokens;
    summary.totalTokens += totalTokens;
    summary.totalCostUsd += totalCostUsd;
    summary.cacheReadTokens += cacheReadTokens;
    modelSummaries.set(model, summary);

    if (!modelSessions.has(model)) {
      modelSessions.set(model, new Set());
    }
    modelSessions.get(model)!.add(sessionMeta.sessionId);

    const dateKey = formatDateKey(row.created_at);
    const dayBucket = dailyMap.get(dateKey);
    if (dayBucket) {
      dayBucket.totalTokens += totalTokens;
      dayBucket.byModel[model] = (dayBucket.byModel[model] || 0) + totalTokens;
      dayBucket.byModelCostUsd[model] = (dayBucket.byModelCostUsd[model] || 0) + totalCostUsd;
    }

    report.totals.inputTokens += inputTokens;
    report.totals.outputTokens += outputTokens;
    report.totals.totalTokens += totalTokens;
    report.totals.totalCostUsd += totalCostUsd;
    report.totals.cacheReadTokens += cacheReadTokens;
    totalCacheWriteTokens += cacheWriteTokens;
    sessionsWithUsage.add(sessionMeta.sessionId);
  }

  report.models = Array.from(modelSummaries.values())
    .map((summary) => ({
      ...summary,
      sessionCount: modelSessions.get(summary.model)?.size || 0,
    }))
    .sort((left, right) =>
      right.totalTokens - left.totalTokens ||
      right.totalCostUsd - left.totalCostUsd ||
      left.model.localeCompare(right.model)
    );

  report.daily = Array.from(dailyMap.entries()).map(([date, bucket]) => ({
    date,
    totalTokens: bucket.totalTokens,
    byModel: bucket.byModel,
    byModelCostUsd: bucket.byModelCostUsd,
  }));
  report.totals.sessionCount = sessionsWithUsage.size;
  const cacheDenominator = report.totals.inputTokens + report.totals.cacheReadTokens + totalCacheWriteTokens;
  report.totals.cacheHitRate = cacheDenominator > 0 ? report.totals.cacheReadTokens / cacheDenominator : 0;

  opencodeUsageReportCache.set(safeDays, {
    version: opencodeUsageReportDataVersion,
    dayStart: todayStart,
    report,
  });

  return report;
}

export function searchChatMessages(query: string, limit = 60): ChatSessionSearchResult[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit || 60)));
  const rows = getDb().prepare(`
    SELECT
      m.data AS data,
      m.message_type AS message_type,
      m.created_at AS created_at,
      m.session_id AS session_id,
      s.title AS session_title,
      s.session_origin AS session_origin,
      s.cwd AS session_cwd,
      s.updated_at AS session_updated_at
    FROM search_index si
    INNER JOIN messages m ON m.id = si.message_id
    INNER JOIN sessions s ON s.id = m.session_id
    WHERE lower(si.text) LIKE ?
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(`%${normalizedQuery}%`, safeLimit * 8) as Array<{
    data: string;
    message_type: string | null;
    created_at: number;
    session_id: string;
    session_title: string;
    session_origin: SessionSource | null;
    session_cwd: string | null;
    session_updated_at: number;
  }>;

  const grouped = new Map<string, ChatSessionSearchResult>();

  for (const row of rows) {
    try {
      if (row.message_type !== 'user_prompt' && row.message_type !== 'assistant') {
        continue;
      }

      const message = readStoredMessagePayload(row.data, row.created_at);
      const text = extractSearchableMessageText(message).trim();
      if (!text || !text.toLowerCase().includes(normalizedQuery)) {
        continue;
      }

      let entry = grouped.get(row.session_id);
      if (!entry) {
        if (grouped.size >= safeLimit) {
          continue;
        }

        entry = {
          sessionId: row.session_id,
          sessionTitle: row.session_title,
          sessionSource: row.session_origin || 'aegis',
          sessionCwd: row.session_cwd || undefined,
          sessionUpdatedAt: row.session_updated_at,
          matchCount: 0,
          matches: [],
        };
        grouped.set(row.session_id, entry);
      }

      entry.matchCount += 1;
      if (entry.matches.length < 3) {
        const messageType = message.type === 'assistant' ? 'assistant' : 'user_prompt';
        entry.matches.push({
          snippet: buildSearchSnippet(text, normalizedQuery),
          messageType,
          createdAt: row.created_at,
        });
      }
    } catch {
      continue;
    }
  }

  return Array.from(grouped.values()).sort((left, right) => {
    const leftLatest = left.matches[0]?.createdAt || left.sessionUpdatedAt || 0;
    const rightLatest = right.matches[0]?.createdAt || right.sessionUpdatedAt || 0;
    return rightLatest - leftLatest;
  });
}

// 获取最近使用的工作目录
export function listRecentCwds(limit: number = 8): string[] {
  // 限制范围 1-20
  const safeLimit = Math.max(1, Math.min(20, limit));

  const stmt = getDb().prepare(`
    SELECT DISTINCT cwd FROM sessions
    WHERE cwd IS NOT NULL AND cwd != ''
    ORDER BY updated_at DESC
    LIMIT ?
  `);
  const rows = stmt.all(safeLimit) as { cwd: string }[];
  return rows.map((row) => row.cwd);
}

// 关闭数据库
export function close(): void {
  if (db) {
    db.close();
    db = null;
  }
}
