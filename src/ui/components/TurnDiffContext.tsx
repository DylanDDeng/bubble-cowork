import { createContext, useContext } from 'react';
import type { ChangeRecord } from '../utils/change-records';

export interface TurnDiffContextValue {
  /** Lookup: tool_use id -> ChangeRecord produced by that tool call. */
  changeRecordByToolUseId: Map<string, ChangeRecord>;
  /** Lookup: tool_use id -> all ChangeRecords produced by that tool call. */
  changeRecordsByToolUseId: Map<string, ChangeRecord[]>;
  /** Invoked when the user clicks a file row or inline hint to view its diff. */
  onOpenDiff?: (
    record: ChangeRecord,
    scope?: { records: ChangeRecord[]; label?: string; turnKey?: string }
  ) => void;
}

const DEFAULT_VALUE: TurnDiffContextValue = {
  changeRecordByToolUseId: new Map(),
  changeRecordsByToolUseId: new Map(),
};

export const TurnDiffContext = createContext<TurnDiffContextValue>(DEFAULT_VALUE);

export function useTurnDiffContext(): TurnDiffContextValue {
  return useContext(TurnDiffContext);
}
