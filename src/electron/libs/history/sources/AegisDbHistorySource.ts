import * as sessions from '../../session-store';
import type {
  SessionHistorySource,
  UnifiedHistoryPage,
  UnifiedSessionRecord,
} from '../types';

function encodeCursor(offset: number): string {
  return String(offset);
}

function decodeCursor(cursor: string): number {
  const parsed = Number(cursor);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class AegisDbHistorySource implements SessionHistorySource {
  readonly kind = 'aegis' as const;

  async loadLatest(session: UnifiedSessionRecord, limit: number): Promise<UnifiedHistoryPage> {
    const messages = sessions.getSessionHistory(session.id);
    const safeLimit = Math.max(1, limit);
    const start = Math.max(0, messages.length - safeLimit);
    return {
      messages: messages.slice(start),
      cursor: start > 0 ? encodeCursor(start) : null,
      hasMore: start > 0,
    };
  }

  async loadBefore(session: UnifiedSessionRecord, cursor: string, limit: number): Promise<UnifiedHistoryPage> {
    const messages = sessions.getSessionHistory(session.id);
    const offset = Math.max(0, decodeCursor(cursor));
    const safeLimit = Math.max(1, limit);
    const start = Math.max(0, offset - safeLimit);
    return {
      messages: messages.slice(start, offset),
      cursor: start > 0 ? encodeCursor(start) : null,
      hasMore: start > 0,
    };
  }

  async loadAll(session: UnifiedSessionRecord) {
    return sessions.getSessionHistory(session.id);
  }
}
