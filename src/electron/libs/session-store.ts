import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { SessionRow, StreamMessage, SessionStatus } from '../types';
import type {
  ClaudeModelUsage,
  ClaudeUsageModelSummary,
  ClaudeUsageRangeDays,
  ClaudeUsageReport,
} from '../../shared/types';

let db: Database.Database | null = null;
const DAY_MS = 24 * 60 * 60 * 1000;

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
      provider TEXT NOT NULL DEFAULT 'claude',
      model TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      cwd TEXT,
      allowed_tools TEXT,
      last_prompt TEXT,
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
  ensureColumn('sessions', 'provider', "TEXT NOT NULL DEFAULT 'claude'");
  ensureColumn('sessions', 'model', 'TEXT');
  ensureColumn('sessions', 'todo_state', "TEXT DEFAULT 'todo'");
  ensureColumn('sessions', 'pinned', 'INTEGER DEFAULT 0');
  ensureColumn('sessions', 'folder_path', 'TEXT');

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
  provider?: 'claude' | 'codex';
  model?: string;
}): SessionRow {
  const now = Date.now();
  const id = uuidv4();

  const stmt = getDb().prepare(`
    INSERT INTO sessions (id, title, provider, model, cwd, allowed_tools, last_prompt, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)
  `);

  stmt.run(
    id,
    params.title,
    params.provider || 'claude',
    params.model || null,
    params.cwd || null,
    params.allowedTools || null,
    params.prompt || null,
    now,
    now
  );

  return getSession(id)!;
}

// 获取单个会话
export function getSession(sessionId: string): SessionRow | undefined {
  const stmt = getDb().prepare('SELECT * FROM sessions WHERE id = ?');
  return stmt.get(sessionId) as SessionRow | undefined;
}

// 获取所有会话
export function listSessions(): SessionRow[] {
  const stmt = getDb().prepare('SELECT * FROM sessions ORDER BY updated_at DESC');
  return stmt.all() as SessionRow[];
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

// 更新 Codex Session ID
export function updateCodexSessionId(sessionId: string, codexSessionId: string): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET codex_session_id = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(codexSessionId, now, sessionId);
}

// 更新 Session Provider
export function updateSessionProvider(sessionId: string, provider: 'claude' | 'codex'): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET provider = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(provider, now, sessionId);
}

export function updateSessionModel(sessionId: string, model: string | null): void {
  const now = Date.now();
  const stmt = getDb().prepare(`
    UPDATE sessions SET model = ?, updated_at = ? WHERE id = ?
  `);
  stmt.run(model, now, sessionId);
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
  inferred_model: string | null;
};

type StoredClaudeResultMessage = Extract<StreamMessage, { type: 'result' }> & {
  modelUsage?: Record<string, Partial<ClaudeModelUsage>>;
};

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

  const rows = getDb().prepare(`
    SELECT
      m.data AS data,
      m.created_at AS created_at,
      s.id AS session_id,
      s.model AS session_model,
      (
        SELECT json_extract(m2.data, '$.model')
        FROM messages m2
        WHERE m2.session_id = s.id
          AND json_extract(m2.data, '$.type') = 'system'
          AND json_extract(m2.data, '$.subtype') = 'init'
          AND json_extract(m2.data, '$.model') IS NOT NULL
          AND json_extract(m2.data, '$.model') != ''
        ORDER BY m2.created_at DESC
        LIMIT 1
      ) AS inferred_model
    FROM messages m
    INNER JOIN sessions s ON s.id = m.session_id
    WHERE s.provider = 'claude' AND m.created_at >= ?
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

    const fallbackModel = row.session_model || row.inferred_model || 'Unknown';
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

  return {
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
