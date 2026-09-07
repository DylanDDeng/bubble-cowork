import { BrowserWindow } from 'electron';
import { ipcMainHandle } from '../util';
import { attachTaskPullRequest, detachTaskPullRequest, listTaskPullRequests } from '../libs/session-pull-requests';
import type { AttachSessionPullRequestInput } from '../../shared/types';

export function setupSessionPullRequestsIPC() {
  const changed = (sessionId: string) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('session-pull-requests-changed', sessionId);
    }
  };
  ipcMainHandle('list-session-pull-requests', (_, sessionId: string, refresh?: boolean) => listTaskPullRequests(sessionId, refresh === true));
  ipcMainHandle('attach-session-pull-request', async (_, input: AttachSessionPullRequestInput) => {
    const result = await attachTaskPullRequest(input);
    if (result.created) changed(input.sessionId);
    return result;
  });
  ipcMainHandle('detach-session-pull-request', (_, sessionId: string, url: string, attachedAt: number) => {
    detachTaskPullRequest(sessionId, url, attachedAt);
    changed(sessionId);
  });
}
