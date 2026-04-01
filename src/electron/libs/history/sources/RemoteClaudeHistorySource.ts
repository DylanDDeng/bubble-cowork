import type {
  SessionHistorySource,
  UnifiedHistoryPage,
  UnifiedSessionRecord,
} from '../types';

function unsupported(): never {
  throw new Error('Remote Claude history source is registered but not yet configured in Aegis.');
}

export class RemoteClaudeHistorySource implements SessionHistorySource {
  readonly kind = 'claude_remote' as const;

  async loadLatest(_session: UnifiedSessionRecord, _limit: number): Promise<UnifiedHistoryPage> {
    return unsupported();
  }

  async loadBefore(_session: UnifiedSessionRecord, _cursor: string, _limit: number): Promise<UnifiedHistoryPage> {
    return unsupported();
  }

  async loadAll(_session: UnifiedSessionRecord) {
    return unsupported();
  }
}
