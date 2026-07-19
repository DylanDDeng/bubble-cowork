import type { AgentProvider } from '../types';
import { useAppStore } from '../store/useAppStore';
import { hasQueueFlushOwner, useComposerQueueStore } from '../store/useComposerQueueStore';
import { sendEvent } from '../hooks/useIPC';

/**
 * Store-level queue auto-flush: when ANY session's running turn completes,
 * its queued composer messages are sent as the next turn — even when no pane
 * is showing that session. The mounted-composer effect in PromptInput claims
 * flush ownership for its bound session (it applies the live composer
 * selection); this watcher only covers ownerless sessions and sends WITHOUT
 * composer overrides, so the session's sticky model/config apply.
 */

let started = false;
let prevSessionsRef: unknown = null;
let prevStatuses = new Map<string, string>();

function snapshotStatuses(sessions: Record<string, { status?: string }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [sessionId, session] of Object.entries(sessions)) {
    if (session?.status) map.set(sessionId, session.status);
  }
  return map;
}

export function startQueueAutoFlush(): void {
  if (started) return;
  started = true;
  const initial = useAppStore.getState();
  prevSessionsRef = initial.sessions;
  prevStatuses = snapshotStatuses(initial.sessions);

  useAppStore.subscribe((state) => {
    if (state.sessions === prevSessionsRef) return;
    prevSessionsRef = state.sessions;
    const next = snapshotStatuses(state.sessions);
    for (const [sessionId, status] of next) {
      if (status === 'completed' && prevStatuses.get(sessionId) === 'running') {
        flushIfUnowned(sessionId, state.sessions[sessionId]?.provider);
      }
    }
    prevStatuses = next;
  });
}

function flushIfUnowned(sessionId: string, provider: AgentProvider | undefined): void {
  if (hasQueueFlushOwner(sessionId)) return;
  const items = useComposerQueueStore.getState().takeAll(sessionId);
  if (items.length === 0) return;
  const attachments = items.flatMap((item) => item.attachments);
  sendEvent({
    type: 'session.continue',
    payload: {
      sessionId,
      prompt: items.map((item) => item.displayPrompt).join('\n\n'),
      effectivePrompt: items.map((item) => item.effectivePrompt).join('\n\n'),
      attachments: attachments.length > 0 ? attachments : undefined,
      provider,
      codexSkills: items.flatMap((item) => item.references.codexSkills ?? []),
      codexMentions: items.flatMap((item) => item.references.codexMentions ?? []),
      teamMode: 'solo',
      teamId: null,
    },
  });
}
