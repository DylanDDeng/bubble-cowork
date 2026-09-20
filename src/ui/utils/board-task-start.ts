import type { SessionStartPayload } from '../../shared/types';
import type { BoardTask } from '../store/useBoardStore';
import { createSessionLink } from '../../shared/session-links';

/** Build a direct Board run without leaking Board-only description metadata. */
export function createBoardTaskStartPayload(
  task: BoardTask,
  channelId: string
): SessionStartPayload {
  const title = task.title.trim();
  return {
    ...task.sessionConfig,
    title,
    prompt: title + (task.sourceSessionId
      ? `\n\nUse this conversation as context for this task: ${createSessionLink(task.sourceSessionId)}`
      : ''),
    attachments: task.attachments?.length ? task.attachments : undefined,
    cwd: task.projectCwd || undefined,
    projectCwd: task.projectCwd,
    scope: 'project',
    channelId,
  };
}
