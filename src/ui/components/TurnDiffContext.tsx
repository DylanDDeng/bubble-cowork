import { createContext, useContext } from 'react';
import type { ChangeRecord } from '../utils/change-records';

export interface TurnDiffContextValue {
  /** Lookup: tool_use id -> ChangeRecord produced by that tool call. */
  changeRecordByToolUseId: Map<string, ChangeRecord>;
  /** Invoked when the user clicks a file row or inline hint to view its diff. */
  onOpenDiff?: (record: ChangeRecord) => void;
}

const DEFAULT_VALUE: TurnDiffContextValue = {
  changeRecordByToolUseId: new Map(),
};

export const TurnDiffContext = createContext<TurnDiffContextValue>(DEFAULT_VALUE);

export function useTurnDiffContext(): TurnDiffContextValue {
  return useContext(TurnDiffContext);
}
