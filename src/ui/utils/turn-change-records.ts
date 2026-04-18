import type { StreamMessage } from '../types';
import { extractToolChangeRecords, type ChangeRecord } from './change-records';

export interface TurnChangeSummary {
  turnIndex: number;
  /** Inclusive slice start in StreamMessage[] (the user_prompt of the turn, if any). */
  firstMessageIndex: number;
  /** Inclusive slice end in StreamMessage[]. */
  lastMessageIndex: number;
  /** Records merged per file path. */
  records: ChangeRecord[];
  totalFiles: number;
  totalAdded: number;
  totalRemoved: number;
}

export interface TurnChangeContext {
  turns: TurnChangeSummary[];
  /** Map tool_use id -> the raw ChangeRecord produced by that tool call. */
  changeRecordByToolUseId: Map<string, ChangeRecord>;
}

/**
 * Walks messages and groups tool-induced change records by "turn", where a turn
 * is every message between two consecutive `user_prompt` entries (including the
 * leading prompt of each segment).
 */
export function buildTurnChangeContext(messages: StreamMessage[]): TurnChangeContext {
  const turns: TurnChangeSummary[] = [];
  const changeRecordByToolUseId = new Map<string, ChangeRecord>();

  let turnStart = 0;
  let pendingTurnIndex = 0;

  const flush = (endExclusive: number) => {
    if (endExclusive <= turnStart) return;
    const slice = messages.slice(turnStart, endExclusive);
    const records = extractToolChangeRecords(slice);

    for (const record of records) {
      if (record.toolUseId) {
        changeRecordByToolUseId.set(record.toolUseId, record);
      }
    }

    const merged = mergeRecordsByPath(records);
    if (merged.length > 0 || records.length > 0) {
      turns.push({
        turnIndex: pendingTurnIndex,
        firstMessageIndex: turnStart,
        lastMessageIndex: endExclusive - 1,
        records: merged,
        totalFiles: merged.length,
        totalAdded: merged.reduce((sum, r) => sum + r.addedLines, 0),
        totalRemoved: merged.reduce((sum, r) => sum + r.removedLines, 0),
      });
    }
    pendingTurnIndex += 1;
    turnStart = endExclusive;
  };

  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (msg.type === 'user_prompt' && i > turnStart) {
      flush(i);
    }
  }
  flush(messages.length);

  return { turns, changeRecordByToolUseId };
}

function mergeRecordsByPath(records: ChangeRecord[]): ChangeRecord[] {
  const byPath = new Map<string, ChangeRecord>();
  for (const record of records) {
    const existing = byPath.get(record.filePath);
    if (!existing) {
      byPath.set(record.filePath, { ...record });
      continue;
    }

    existing.addedLines += record.addedLines;
    existing.removedLines += record.removedLines;

    if (record.operation === 'delete') {
      existing.operation = 'delete';
    } else if (existing.operation !== 'write' && record.operation === 'write') {
      existing.operation = 'write';
    }

    if (record.diffContent) {
      existing.diffContent = existing.diffContent
        ? `${existing.diffContent}\n${record.diffContent}`
        : record.diffContent;
    }

    if (record.state === 'pending') {
      existing.state = 'pending';
    }
  }
  return Array.from(byPath.values());
}
