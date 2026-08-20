import type {
  ProjectUtilityPanelTarget,
  SessionRightPanelFileState,
  SessionRightPanelLiveFields,
  SessionRightPanelSnapshot,
} from '../types';
import {
  getRightUtilityTabKind,
  getSideChatSessionId,
  isRightUtilitySideChatTab,
  isSideChatPendingTab,
} from './right-utility-tabs';

export const NEW_SESSION_RIGHT_PANEL_KEY = '__new-session__';

export type RightPanelBySessionId = Record<string, SessionRightPanelSnapshot>;

export function rightPanelSessionKey(sessionId: string | null | undefined): string {
  const trimmed = sessionId?.trim();
  return trimmed || NEW_SESSION_RIGHT_PANEL_KEY;
}

export function emptyRightPanelSnapshot(): SessionRightPanelSnapshot {
  return {
    tabs: [],
    activeTab: null,
    hidden: true,
    fullscreen: null,
    fileTabsByUtilityTab: {},
    reviewDiffSelection: null,
  };
}

export function captureLiveRightPanel(
  live: Pick<
    SessionRightPanelLiveFields,
    | 'rightUtilityTabs'
    | 'activeRightUtilityTab'
    | 'rightUtilityPanelHidden'
    | 'rightPanelFullscreen'
    | 'reviewDiffSelection'
  >,
  map: RightPanelBySessionId,
  sessionId: string | null | undefined
): SessionRightPanelSnapshot {
  const key = rightPanelSessionKey(sessionId);
  return {
    tabs: [...live.rightUtilityTabs],
    activeTab: live.activeRightUtilityTab,
    hidden: live.rightUtilityPanelHidden,
    fullscreen: live.rightPanelFullscreen,
    fileTabsByUtilityTab: map[key]?.fileTabsByUtilityTab ?? {},
    reviewDiffSelection: live.reviewDiffSelection,
  };
}

function isPersistableRightUtilityTab(tab: ProjectUtilityPanelTarget): boolean {
  const kind = getRightUtilityTabKind(tab);
  return kind === 'files' || kind === 'browser' || kind === 'review' || kind === 'terminal';
}

export function filterRestorableRightUtilityTabs(
  tabs: ProjectUtilityPanelTarget[],
  sessions: Record<string, unknown>
): ProjectUtilityPanelTarget[] {
  return tabs.filter((tab) => {
    if (isSideChatPendingTab(tab)) return false;
    if (isRightUtilitySideChatTab(tab)) {
      return Boolean(sessions[getSideChatSessionId(tab)]);
    }
    return true;
  });
}

function sanitizeFullscreen(
  fullscreen: SessionRightPanelSnapshot['fullscreen'],
  tabs: ProjectUtilityPanelTarget[]
): SessionRightPanelSnapshot['fullscreen'] {
  if (!fullscreen) return null;
  const hasMatch = tabs.some((tab) => getRightUtilityTabKind(tab) === fullscreen);
  return hasMatch ? fullscreen : null;
}

export function sanitizeRightPanelSnapshot(
  snapshot: SessionRightPanelSnapshot | null | undefined,
  sessions: Record<string, unknown> = {}
): SessionRightPanelSnapshot {
  const source = snapshot ?? emptyRightPanelSnapshot();
  const tabs = filterRestorableRightUtilityTabs(
    Array.isArray(source.tabs) ? source.tabs : [],
    sessions
  );
  const activeTab =
    source.activeTab && tabs.includes(source.activeTab) ? source.activeTab : tabs[0] ?? null;
  const fileTabsByUtilityTab: Record<string, SessionRightPanelFileState> = {};
  for (const [tabId, fileState] of Object.entries(source.fileTabsByUtilityTab ?? {})) {
    const parsed = parseFileState(fileState);
    if (parsed) fileTabsByUtilityTab[tabId] = parsed;
  }
  return {
    tabs,
    activeTab,
    hidden: source.hidden === true,
    fullscreen: sanitizeFullscreen(source.fullscreen ?? null, tabs),
    fileTabsByUtilityTab,
    reviewDiffSelection: source.reviewDiffSelection ?? null,
  };
}

export function liveFieldsFromRightPanel(
  snapshot: SessionRightPanelSnapshot
): SessionRightPanelLiveFields {
  const tabs = snapshot.tabs;
  const activeTab =
    snapshot.activeTab && tabs.includes(snapshot.activeTab) ? snapshot.activeTab : tabs[0] ?? null;
  const kind = activeTab ? getRightUtilityTabKind(activeTab) : null;
  const hidden = snapshot.hidden === true || tabs.length === 0;
  return {
    rightUtilityTabs: tabs,
    activeRightUtilityTab: activeTab,
    rightUtilityPanelHidden: hidden,
    rightPanelFullscreen: hidden ? null : snapshot.fullscreen,
    projectTreeCollapsed: hidden || (kind !== 'files' && kind !== 'review'),
    projectPanelView: kind === 'review' ? 'changes' : kind === 'files' ? 'files' : 'files',
    browserPanelOpen: !hidden && kind === 'browser',
    reviewDiffSelection: snapshot.reviewDiffSelection,
  };
}

export function liveRightPanelEquals(
  left: Pick<
    SessionRightPanelLiveFields,
    'rightUtilityTabs' | 'activeRightUtilityTab' | 'rightUtilityPanelHidden' | 'rightPanelFullscreen'
  >,
  right: Pick<
    SessionRightPanelLiveFields,
    'rightUtilityTabs' | 'activeRightUtilityTab' | 'rightUtilityPanelHidden' | 'rightPanelFullscreen'
  >
): boolean {
  return (
    left.rightUtilityPanelHidden === right.rightUtilityPanelHidden &&
    left.rightPanelFullscreen === right.rightPanelFullscreen &&
    left.activeRightUtilityTab === right.activeRightUtilityTab &&
    left.rightUtilityTabs.length === right.rightUtilityTabs.length &&
    left.rightUtilityTabs.every((tab, index) => tab === right.rightUtilityTabs[index])
  );
}

export function migrateRightPanelSessionId(
  map: RightPanelBySessionId,
  fromSessionId: string | null | undefined,
  toSessionId: string | null | undefined
): RightPanelBySessionId {
  const fromKey = rightPanelSessionKey(fromSessionId);
  const toKey = rightPanelSessionKey(toSessionId);
  if (fromKey === toKey || !(fromKey in map)) return map;
  const { [fromKey]: snapshot, ...rest } = map;
  return {
    ...rest,
    [toKey]: snapshot ?? rest[toKey] ?? emptyRightPanelSnapshot(),
  };
}

export function pruneRightPanelBySessionId(
  map: RightPanelBySessionId,
  keepSessionIds: Iterable<string>
): RightPanelBySessionId {
  const keep = new Set<string>([NEW_SESSION_RIGHT_PANEL_KEY, ...keepSessionIds]);
  let changed = false;
  const next: RightPanelBySessionId = {};
  for (const [key, snapshot] of Object.entries(map)) {
    if (!keep.has(key)) {
      changed = true;
      continue;
    }
    next[key] = snapshot;
  }
  return changed ? next : map;
}

export function withFileTabsForUtilityTab(
  map: RightPanelBySessionId,
  sessionId: string | null | undefined,
  utilityTabId: string,
  fileState: SessionRightPanelFileState,
  live?: Parameters<typeof captureLiveRightPanel>[0]
): RightPanelBySessionId {
  const key = rightPanelSessionKey(sessionId);
  const current = live
    ? captureLiveRightPanel(live, map, sessionId)
    : map[key] ?? emptyRightPanelSnapshot();
  return {
    ...map,
    [key]: {
      ...current,
      fileTabsByUtilityTab: {
        ...current.fileTabsByUtilityTab,
        [utilityTabId]: fileState,
      },
    },
  };
}

export function switchSessionRightPanel(input: {
  prevSessionId: string | null;
  nextSessionId: string | null;
  live: Parameters<typeof captureLiveRightPanel>[0];
  rightPanelBySessionId: RightPanelBySessionId;
  sessions: Record<string, unknown>;
}): { rightPanelBySessionId: RightPanelBySessionId } & SessionRightPanelLiveFields {
  const prevKey = rightPanelSessionKey(input.prevSessionId);
  const nextKey = rightPanelSessionKey(input.nextSessionId);
  if (prevKey === nextKey) {
    const snapshot = captureLiveRightPanel(
      input.live,
      input.rightPanelBySessionId,
      input.prevSessionId
    );
    return {
      rightPanelBySessionId: { ...input.rightPanelBySessionId, [prevKey]: snapshot },
      ...liveFieldsFromRightPanel(sanitizeRightPanelSnapshot(snapshot, input.sessions)),
    };
  }
  const prevSnapshot = captureLiveRightPanel(
    input.live,
    input.rightPanelBySessionId,
    input.prevSessionId
  );
  const nextMap: RightPanelBySessionId = { ...input.rightPanelBySessionId };
  if (input.prevSessionId && !(input.prevSessionId in input.sessions)) {
    delete nextMap[prevKey];
  } else {
    nextMap[prevKey] = prevSnapshot;
  }

  const nextSnapshot = sanitizeRightPanelSnapshot(nextMap[nextKey], input.sessions);
  nextMap[nextKey] = nextSnapshot;

  return {
    rightPanelBySessionId: nextMap,
    ...liveFieldsFromRightPanel(nextSnapshot),
  };
}

function parseFileState(value: unknown): SessionRightPanelFileState | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<SessionRightPanelFileState>;
  const files = Array.isArray(record.files)
    ? record.files.flatMap((file) => {
        if (!file || typeof file !== 'object') return [];
        const cwd = typeof file.cwd === 'string' ? file.cwd.trim() : '';
        const filePath = typeof file.filePath === 'string' ? file.filePath.trim() : '';
        if (!cwd || !filePath) return [];
        const viewMode =
          file.viewMode === 'view' || file.viewMode === 'code' || file.viewMode === 'split'
            ? file.viewMode
            : undefined;
        const name = typeof file.name === 'string' && file.name.trim() ? file.name.trim() : undefined;
        return [{ cwd, filePath, name, viewMode }];
      })
    : [];
  const active =
    record.activeFile &&
    typeof record.activeFile === 'object' &&
    typeof record.activeFile.cwd === 'string' &&
    typeof record.activeFile.filePath === 'string'
      ? {
          cwd: record.activeFile.cwd.trim(),
          filePath: record.activeFile.filePath.trim(),
        }
      : null;
  return {
    files,
    activeFile: active && active.cwd && active.filePath ? active : null,
  };
}

function persistableSnapshot(snapshot: SessionRightPanelSnapshot): SessionRightPanelSnapshot {
  const tabs = snapshot.tabs.filter(isPersistableRightUtilityTab);
  const activeTab =
    snapshot.activeTab && tabs.includes(snapshot.activeTab) ? snapshot.activeTab : tabs[0] ?? null;
  const fileTabsByUtilityTab: Record<string, SessionRightPanelFileState> = {};
  for (const tab of tabs) {
    if (getRightUtilityTabKind(tab) !== 'files') continue;
    const fileState = snapshot.fileTabsByUtilityTab[tab];
    if (fileState) fileTabsByUtilityTab[tab] = fileState;
  }
  return {
    tabs,
    activeTab,
    hidden: snapshot.hidden,
    fullscreen: sanitizeFullscreen(snapshot.fullscreen, tabs),
    fileTabsByUtilityTab,
    reviewDiffSelection: null,
  };
}

export function persistRightPanelBySessionId(map: RightPanelBySessionId): RightPanelBySessionId {
  const next: RightPanelBySessionId = {};
  for (const [key, snapshot] of Object.entries(map)) {
    const persistable = persistableSnapshot(sanitizeRightPanelSnapshot(snapshot));
    if (
      persistable.tabs.length === 0 &&
      Object.keys(persistable.fileTabsByUtilityTab).length === 0
    ) {
      continue;
    }
    next[key] = persistable;
  }
  return next;
}

export function parseRightPanelBySessionId(value: unknown): RightPanelBySessionId {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const next: RightPanelBySessionId = {};
  for (const [key, snapshot] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim()) continue;
    next[key] = sanitizeRightPanelSnapshot(snapshot as SessionRightPanelSnapshot);
  }
  return next;
}
