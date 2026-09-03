import type { SessionStartPayload } from '../../shared/types';
import type { BoardTask } from '../store/useBoardStore';

/** Build a direct Board run without leaking Board-only description metadata. */
export function createBoardTaskStartPayload(
  task: BoardTask,
  channelId: string
): SessionStartPayload {
  const title = task.title.trim();
  return {
    ...task.sessionConfig,
    title,
    prompt: title,
    cwd: task.projectCwd || undefined,
    projectCwd: task.projectCwd,
    scope: 'project',
    channelId,
  };
}
