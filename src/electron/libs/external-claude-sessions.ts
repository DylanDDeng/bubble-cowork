import type { BrowserWindow } from 'electron';
import type { SessionSource } from '../../shared/types';
import * as sessions from './session-store';
import { getClaudeCodeLocalHistorySource } from './history/registry';

const EXTERNAL_SESSION_SOURCE: SessionSource = 'claude_code';
const RESCAN_INTERVAL_MS = 30_000;

let syncInFlight = false;
let syncQueued = false;
let lastSyncAt = 0;

async function syncExternalClaudeSessions(): Promise<boolean> {
  const source = getClaudeCodeLocalHistorySource();
  const scanned = await source.scanSessions();
  if (scanned.length === 0) {
    const removed = sessions.pruneMissingExternalClaudeSessions([]);
    return removed > 0;
  }

  const validSessionIds = scanned.map((entry) => entry.session.id);
  let changed = false;

  for (const entry of scanned) {
    const syncInfo = sessions.getExternalSessionSyncInfo(entry.session.id);
    if (
      syncInfo?.session_origin === EXTERNAL_SESSION_SOURCE &&
      syncInfo.external_file_path === entry.session.externalFilePath &&
      syncInfo.external_file_mtime === entry.session.externalFileMtime
    ) {
      continue;
    }

    sessions.upsertExternalClaudeSession({
      sessionId: entry.session.id,
      title: entry.session.title,
      cwd: entry.session.cwd,
      model: entry.session.model,
      createdAt: entry.session.createdAt,
      updatedAt: entry.session.updatedAt,
      externalFilePath: entry.session.externalFilePath || '',
      externalFileMtime: entry.session.externalFileMtime || 0,
    });
    sessions.replaceSessionHistory(entry.session.id, entry.messages);
    changed = true;

    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const removed = sessions.pruneMissingExternalClaudeSessions(validSessionIds);
  return changed || removed > 0;
}

export function scheduleExternalClaudeSessionSync(
  mainWindow: BrowserWindow,
  onUpdated: () => void
): void {
  if (syncInFlight) {
    syncQueued = true;
    return;
  }

  if (Date.now() - lastSyncAt < RESCAN_INTERVAL_MS) {
    return;
  }

  syncInFlight = true;
  void syncExternalClaudeSessions()
    .then((changed) => {
      lastSyncAt = Date.now();
      if (changed && !mainWindow.isDestroyed()) {
        onUpdated();
      }
    })
    .catch((error) => {
      console.warn('[external-claude-sessions] Failed to sync external Claude sessions:', error);
    })
    .finally(() => {
      syncInFlight = false;
      if (syncQueued) {
        syncQueued = false;
        scheduleExternalClaudeSessionSync(mainWindow, onUpdated);
      }
    });
}
