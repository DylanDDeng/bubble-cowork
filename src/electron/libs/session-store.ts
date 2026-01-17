import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { SessionRow, StreamMessage, SessionStatus } from '../types';

let db: Database.Database | null = null;

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
}): SessionRow {
  const now = Date.now();
  const id = uuidv4();

  const stmt = getDb().prepare(`
    INSERT INTO sessions (id, title, cwd, allowed_tools, last_prompt, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'idle', ?, ?)
  `);

  stmt.run(
    id,
    params.title,
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
    INSERT OR IGNORE INTO messages (id, session_id, data, created_at)
    VALUES (?, ?, ?, ?)
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
