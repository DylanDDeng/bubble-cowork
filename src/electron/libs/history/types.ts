import type { StreamMessage } from '../../../shared/types';
import type { SessionRow } from '../../types';

export type UnifiedSessionSource =
  | 'aegis'
  | 'claude_code_local'
  | 'claude_remote'
  | 'codex_local'
  | 'opencode_local';

export interface UnifiedSessionRecord {
  id: string;
  title: string;
  cwd: string | null;
  provider: SessionRow['provider'];
  model: string | null;
  source: UnifiedSessionSource;
  readOnly: boolean;
  createdAt: number;
  updatedAt: number;
  externalFilePath?: string | null;
  externalFileMtime?: number | null;
}

export interface UnifiedHistoryPage {
  messages: StreamMessage[];
  cursor: string | null;
  hasMore: boolean;
}

export interface SessionHistorySource {
  readonly kind: UnifiedSessionSource;
  loadLatest(session: UnifiedSessionRecord, limit: number): Promise<UnifiedHistoryPage>;
  loadBefore(session: UnifiedSessionRecord, cursor: string, limit: number): Promise<UnifiedHistoryPage>;
  loadAround(
    session: UnifiedSessionRecord,
    anchorCreatedAt: number,
    before: number,
    after: number
  ): Promise<UnifiedHistoryPage>;
  loadAll(session: UnifiedSessionRecord): Promise<StreamMessage[]>;
}

export interface ClaudeCodeSessionIndexEntry {
  sessionId: string;
  fullPath?: string;
  fileMtime?: number;
  firstPrompt?: string;
  summary?: string;
  messageCount?: number;
  created?: string;
  modified?: string;
  projectPath?: string;
}

export interface ClaudeCodeSessionIndexFile {
  version?: number;
  entries?: ClaudeCodeSessionIndexEntry[];
  originalPath?: string;
}

export interface ClaudeCodeSessionScanResult {
  session: UnifiedSessionRecord;
  messages: StreamMessage[];
}
