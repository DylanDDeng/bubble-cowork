import { normalizeSessionTitleInput } from '../../shared/session-rename';
import type { ServerEvent } from '../../shared/types';
import * as sessions from '../libs/session-store';
import { ipcMainHandle } from '../util';

export function setupSessionTitleIPC(emit: (event: ServerEvent) => void): void {
  ipcMainHandle('rename-session', async (_, sessionId: string, value: string) => {
    const title = normalizeSessionTitleInput(value);
    if (typeof sessionId !== 'string' || !sessions.getSession(sessionId)) {
      throw new Error('This conversation is no longer available.');
    }
    sessions.updateSessionTitle(sessionId, title);
    const updated = sessions.getSession(sessionId)!;
    const result = { title: updated.title, updatedAt: updated.updated_at };
    emit({ type: 'session.renamed', payload: { sessionId, ...result } });
    return result;
  });
}
