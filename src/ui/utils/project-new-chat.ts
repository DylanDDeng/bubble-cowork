import { useAppStore } from '../store/useAppStore';

/** Open a local New chat using the destination project's own channel. */
export function openProjectNewChat(cwd: string, sourceSessionId?: string | null) {
  const dir = cwd.trim();
  const state = useAppStore.getState();
  if (!dir || state.pendingStart) return;
  const source = sourceSessionId ? state.sessions[sourceSessionId] : undefined;
  if (source?.status === 'running') return;
  if (source && (source.projectCwd || source.cwd) === dir) return;

  state.setProjectCwd(dir);
  state.setChatSidebarView('threads');
  state.setSidebarSearchQuery('');
  const draftId = state.createDraftSession(dir, null, { projectCwd: dir });
  // Only an unsent draft can be removed; persisted conversations stay intact.
  if (source?.isDraft && source.messages.length === 0) {
    state.removeDraftSession(source.id);
  }
  return draftId;
}
