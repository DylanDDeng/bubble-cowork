import type { SessionRow } from '../../types';
import { AegisDbHistorySource } from './sources/AegisDbHistorySource';
import { RemoteClaudeHistorySource } from './sources/RemoteClaudeHistorySource';
import type {
  SessionHistorySource,
  UnifiedSessionRecord,
  UnifiedSessionSource,
} from './types';

const aegisDbHistorySource = new AegisDbHistorySource();
const remoteClaudeHistorySource = new RemoteClaudeHistorySource();

export function normalizeUnifiedSessionSource(row: Pick<SessionRow, 'provider' | 'session_origin'>): UnifiedSessionSource {
  if (row.session_origin === 'claude_remote') {
    return 'claude_remote';
  }
  if (row.provider === 'codex') {
    return 'codex_local';
  }
  if (row.provider === 'opencode') {
    return 'opencode_local';
  }
  if (row.provider === 'kimi') {
    return 'kimi_local';
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
    readOnly: source === 'claude_remote',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    externalFilePath: row.external_file_path,
    externalFileMtime: row.external_file_mtime,
  };
}

export function getHistorySourceForSession(session: UnifiedSessionRecord): SessionHistorySource {
  switch (session.source) {
    case 'claude_remote':
      return remoteClaudeHistorySource;
    case 'codex_local':
    case 'opencode_local':
    case 'kimi_local':
    case 'aegis':
    default:
      return aegisDbHistorySource;
  }
}
