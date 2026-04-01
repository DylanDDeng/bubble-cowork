import type { SessionRow } from '../../types';
import { AegisDbHistorySource } from './sources/AegisDbHistorySource';
import { ClaudeCodeLocalHistorySource } from './sources/ClaudeCodeLocalHistorySource';
import { RemoteClaudeHistorySource } from './sources/RemoteClaudeHistorySource';
import type {
  SessionHistorySource,
  UnifiedSessionRecord,
  UnifiedSessionSource,
} from './types';

const aegisDbHistorySource = new AegisDbHistorySource();
const claudeCodeLocalHistorySource = new ClaudeCodeLocalHistorySource();
const remoteClaudeHistorySource = new RemoteClaudeHistorySource();

export function normalizeUnifiedSessionSource(row: Pick<SessionRow, 'provider' | 'session_origin'>): UnifiedSessionSource {
  if (row.session_origin === 'claude_code') {
    return 'claude_code_local';
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

export function toUnifiedSessionRecord(row: SessionRow): UnifiedSessionRecord {
  const source = normalizeUnifiedSessionSource(row);
  return {
    id: row.id,
    title: row.title,
    cwd: row.cwd,
    provider: row.provider,
    model: row.model,
    source,
    readOnly: source === 'claude_code_local' || source === 'claude_remote',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    externalFilePath: row.external_file_path,
    externalFileMtime: row.external_file_mtime,
  };
}

export function getHistorySourceForSession(session: UnifiedSessionRecord): SessionHistorySource {
  switch (session.source) {
    case 'claude_code_local':
      return claudeCodeLocalHistorySource;
    case 'claude_remote':
      return remoteClaudeHistorySource;
    case 'codex_local':
    case 'opencode_local':
    case 'aegis':
    default:
      return aegisDbHistorySource;
  }
}

export function getClaudeCodeLocalHistorySource(): ClaudeCodeLocalHistorySource {
  return claudeCodeLocalHistorySource;
}
