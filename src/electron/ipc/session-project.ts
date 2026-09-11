import { isAbsolute } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { BrowserWindow } from 'electron';
import * as sessions from '../libs/session-store';
import { canonicalProjectPath, missingProjectSources } from '../libs/project-paths';
import type { SessionProjectMoveResult } from '../../shared/session-project';
import { ipcMainHandle } from '../util';

export function setupSessionProjectIPC(options: {
  isMoving: (sessionId: string) => boolean;
  retireRunner: (sessionId: string) => void;
  changed: (sessionId: string) => void;
  sourcesChanged?: (projectCwd: string) => void;
}) {
  // A confirmation authorizes exactly the displayed source/target snapshot.
  // Other windows can change either project while the dialog is open.
  const approvals = new Map<string, { token: string; fingerprint: string; expires: number }>();
  ipcMainHandle('move-session-project', async (event, sessionId: string, cwd: string, approvalToken?: string): Promise<SessionProjectMoveResult> => {
    if (typeof sessionId !== 'string' || typeof cwd !== 'string' || !isAbsolute(cwd)) throw new Error('Choose a valid project directory.');
    const target = await realpath(cwd);
    if (!(await stat(target)).isDirectory()) throw new Error('The project directory is not available.');
    if (options.isMoving(sessionId)) throw new Error('Wait for the workspace operation to finish.');
    const row = sessions.getSession(sessionId);
    if (!row || row.hidden_from_threads) throw new Error('This task is no longer available.');
    if (row.session_origin === 'claude_remote') throw new Error('External conversations are read-only.');
    if (row.status === 'running') throw new Error('Wait for the task to finish before changing its project.');
    if (row.env_mode === 'worktree' && row.worktree_path) throw new Error('Return this task to its local project before moving it to another project.');
    const source = row.project_cwd || row.cwd;
    const key = `${event.sender.id}:${sessionId}`;
    for (const [id, pending] of approvals) if (pending.expires < Date.now()) approvals.delete(id);
    if (source && canonicalProjectPath(source) === target) {
      approvals.delete(key);
      return { status: 'unchanged', projectCwd: target };
    }
    const sourceRoots = sessions.getProjectSources(source);
    const targetRoots = sessions.getProjectSources(target);
    const missingSources = missingProjectSources(sourceRoots, targetRoots);
    const fingerprint = JSON.stringify([source, row.cwd, target, sourceRoots, targetRoots]);
    const approved = approvals.get(key);
    if (missingSources.length && (!approved || approved.token !== approvalToken || approved.fingerprint !== fingerprint)) {
      const token = randomUUID();
      approvals.set(key, { token, fingerprint, expires: Date.now() + 10 * 60_000 });
      return { status: 'needs-confirmation', projectCwd: target, missingSources, approvalToken: token };
    }
    approvals.delete(key);
    // No await between the authoritative check and the atomic DB update.
    options.retireRunner(sessionId);
    sessions.moveSessionWithProjectSources(sessionId, target, missingSources);
    if (missingSources.length) options.sourcesChanged?.(target);
    const snapshot = sessions.getSessionOrganization();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('session-organization-changed', snapshot);
    }
    options.changed(sessionId);
    return { status: 'moved', projectCwd: target };
  });
}
