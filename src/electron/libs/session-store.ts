import Database from 'better-sqlite3';
import { app } from 'electron';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { SessionRow, StreamMessage, SessionStatus } from '../types';
import type {
  ChatSessionSearchResult,
  ClaudeAccessMode,
  ClaudeCompatibleProviderId,
  CodexPermissionMode,
  CodexReasoningEffort,
  OpenCodePermissionMode,
  ClaudeModelUsage,
  LatestClaudeModelUsage,
  ClaudeUsageModelSummary,
  ClaudeUsageRangeDays,
  ClaudeUsageReport,
  SessionSource,
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

function normalizeClaudeAccessMode(
  value?: string | null
): ClaudeAccessMode {
  return value === 'fullAccess' ? 'fullAccess' : 'default';
}

function normalizeCodexPermissionMode(
  value?: string | null
): CodexPermissionMode {
  return value === 'fullAccess' || value === 'fullAuto'
    ? 'fullAccess'
    : 'defaultPermissions';
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
      compatible_provider_id TEXT,
      betas TEXT,
      claude_access_mode TEXT DEFAULT 'default',
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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
  `);

  ensureColumn('sessions', 'codex_session_id', 'TEXT');
  ensureColumn('sessions', 'opencode_session_id', 'TEXT');
  ensureColumn('sessions', 'provider', "TEXT NOT NULL DEFAULT 'claude'");
  ensureColumn('sessions', 'model', 'TEXT');
  ensureColumn('sessions', 'compatible_provider_id', 'TEXT');
  ensureColumn('sessions', 'betas', 'TEXT');
  ensureColumn('sessions', 'claude_access_mode', "TEXT DEFAULT 'default'");
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

  const backfilledCount = backfillClaudeSessionModelsFromInitMessages();
  if (backfilledCount > 0) {
    console.log(`[session-store] Backfilled ${backfilledCount} Claude session model values from init messages.`);
  }
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
  provider?: 'claude' | 'codex' | 'opencode';
  model?: string;
  compatibleProviderId?: ClaudeCompatibleProviderId;
  betas?: string[];
  claudeAccessMode?: ClaudeAccessMode;
  codexPermissionMode?: CodexPermissionMode;
  codexReasoningEffort?: CodexReasoningEffort | null;
  codexFastMode?: boolean;
  opencodePermissionMode?: OpenCodePermissionMode;
  hiddenFromThreads?: boolean;
}): SessionRow {
  const now = Date.now();
  const id = uuidv4();

  const stmt = getDb().prepare(`
    INSERT INTO sessions (id, title, provider, model, compatible_provider_id, betas, claude_access_mode, codex_permission_mode, codex_reasoning_effort, codex_fast_mode, opencode_permission_mode, cwd, allowed_tools, last_prompt, session_origin, external_file_path, external_file_mtime, hidden_from_threads, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aegis', NULL, NULL, ?, 'idle', ?, ?)
  `);

  stmt.run(
    id,
    params.title,
    params.provider || 'claude',
    params.model || null,
    params.provider === 'claude' ? params.compatibleProviderId || null : null,
    params.betas && params.betas.length > 0 ? JSON.stringify(params.betas) : null,
    params.provider === 'claude' ? normalizeClaudeAccessMode(params.claudeAccessMode) : null,
    params.provider === 'codex' ? normalizeCodexPermissionMode(params.codexPermissionMode) : null,
    params.provider === 'codex' ? normalizeCodexReasoningEffort(params.codexReasoningEffort) : null,
    params.provider === 'codex' && params.codexFastMode ? 1 : 0,
    params.provider === 'opencode' ? normalizeOpenCodePermissionMode(params.opencodePermissionMode) : null,
    params.cwd || null,
    params.allowedTools || null,
    params.prompt || null,
    params.hiddenFromThreads ? 1 : 0,
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
    VALUES (?, ?, NULL, NULL, NULL, 'claude', ?, NULL, NULL, 'default', NULL, NULL, 0, NULL, 'idle', ?, NULL, NULL, 'claude_code', ?, ?, 0, ?, ?)
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
  const deleteStmt = getDb().prepare(`DELETE FROM sessions WHERE id = ? AND session_origin = 'claude_code'`);
  const transaction = getDb().transaction((ids: string[]) => {
    for (const id of ids) {
      deleteStmt.run(id);
    }
  });

  const staleIds = existing.map((row) => row.id).filter((id) => !valid.has(id));
  transaction(staleIds);
  return staleIds.length;
}

export function getLatestClaudeModelUsageBySession(): Record<string, LatestClaudeModelUsage> {
  const rows = getDb().prepare(`
    SELECT
      m.session_id AS session_id,
      m.data AS data,
      s.model AS session_model
    FROM messages m
    INNER JOIN sessions s ON s.id = m.session_id
    WHERE s.provider = 'claude'
      AND json_extract(m.data, '$.type') = 'result'
    ORDER BY m.created_at DESC
  `).all() as Array<{ session_id: string; data: string; session_model: string | null }>;

  const result: Record<string, LatestClaudeModelUsage> = {};

  for (const row of rows) {
    if (result[row.session_id]) {
      continue;
    }

    try {
      const parsed = JSON.parse(row.data) as StoredClaudeResultMessage;
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
export function updateSessionProvider(sessionId: string, provider: 'claude' | 'codex' | 'opencode'): void {
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

// 更新 Session TodoState
export function updateSessionTodoState(sessionId: string, todoState: string): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET todo_state = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(todoState, now, sessionId);
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
  // 由于设置了 CASCADE，删除 session 会自动删除关联的 messages
  const stmt = getDb().prepare('DELETE FROM sessions WHERE id = ?');
  stmt.run(sessionId);
  invalidateClaudeUsageReportCache();
}

// 添加消息
export function addMessage(sessionId: string, message: StreamMessage): void {
  const now = Date.now();
  // 优先使用 SDK 消息的 uuid，否则生成新的
  const id = (message as { uuid?: string }).uuid || uuidv4();

  const stmt = getDb().prepare(`
    INSERT INTO messages (id, session_id, data, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data
  `);
  stmt.run(id, sessionId, JSON.stringify(message), now);

  if (
    message.type === 'result' ||
    (message.type === 'system' && message.subtype === 'init')
  ) {
    invalidateClaudeUsageReportCache();
  }
}

export function replaceSessionHistory(sessionId: string, messages: StreamMessage[]): void {
  const deleteStmt = getDb().prepare('DELETE FROM messages WHERE session_id = ?');
  const insertStmt = getDb().prepare(`
    INSERT INTO messages (id, session_id, data, created_at)
    VALUES (?, ?, ?, ?)
  `);

  const transaction = getDb().transaction((nextMessages: StreamMessage[]) => {
    deleteStmt.run(sessionId);

    for (const message of nextMessages) {
      const createdAt =
        typeof (message as StreamMessage & { createdAt?: number }).createdAt === 'number'
          ? (message as StreamMessage & { createdAt?: number }).createdAt as number
          : Date.now();
      const id = (message as { uuid?: string }).uuid || uuidv4();
      insertStmt.run(id, sessionId, JSON.stringify(message), createdAt);
    }
  });

  transaction(messages);
  invalidateClaudeUsageReportCache();
}

// 获取会话历史消息
export function getSessionHistory(sessionId: string): StreamMessage[] {
  const stmt = getDb().prepare(`
    SELECT data, created_at FROM messages WHERE session_id = ? ORDER BY created_at ASC
  `);
  const rows = stmt.all(sessionId) as { data: string; created_at: number }[];

  return rows.map((row) => {
    const message = JSON.parse(row.data) as StreamMessage;
    if (typeof (message as StreamMessage & { createdAt?: number }).createdAt !== 'number') {
      (message as StreamMessage & { createdAt?: number }).createdAt = row.created_at;
    }
    return message;
  });
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

function extractSearchableMessageText(message: StreamMessage): string {
  if (message.type === 'user_prompt') {
    return message.prompt || '';
  }

  if (message.type === 'assistant') {
    return message.message.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  return '';
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
  const result = getDb().prepare(`
    UPDATE sessions
    SET model = (
      SELECT json_extract(m.data, '$.model')
      FROM messages m
      WHERE m.session_id = sessions.id
        AND json_extract(m.data, '$.type') = 'system'
        AND json_extract(m.data, '$.subtype') = 'init'
        AND json_extract(m.data, '$.model') IS NOT NULL
        AND json_extract(m.data, '$.model') != ''
      ORDER BY m.created_at DESC
      LIMIT 1
    )
    WHERE provider = 'claude'
      AND (model IS NULL OR model = '')
      AND EXISTS (
        SELECT 1
        FROM messages m
        WHERE m.session_id = sessions.id
          AND json_extract(m.data, '$.type') = 'system'
          AND json_extract(m.data, '$.subtype') = 'init'
          AND json_extract(m.data, '$.model') IS NOT NULL
          AND json_extract(m.data, '$.model') != ''
      )
  `).run();

  return result.changes || 0;
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
      AND json_extract(m.data, '$.type') = 'result'
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
      parsed = JSON.parse(row.data) as StreamMessage;
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
      m.created_at AS created_at,
      m.session_id AS session_id,
      s.title AS session_title,
      s.session_origin AS session_origin,
      s.cwd AS session_cwd,
      s.updated_at AS session_updated_at
    FROM messages m
    INNER JOIN sessions s ON s.id = m.session_id
    WHERE lower(m.data) LIKE ?
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(`%${normalizedQuery}%`, safeLimit * 8) as Array<{
    data: string;
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
      const message = JSON.parse(row.data) as StreamMessage;
      if (message.type !== 'user_prompt' && message.type !== 'assistant') {
        continue;
      }

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
        entry.matches.push({
          snippet: buildSearchSnippet(text, normalizedQuery),
          messageType: message.type,
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
