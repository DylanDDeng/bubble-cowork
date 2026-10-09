/**
 * How an agent's browser action surfaces. It never pulls the user out of
 * another task or Settings (a toast offers to show it, at most once a
 * minute per task), and in the current task it reveals the browser tab
 * but stops re-revealing it for a while once the user has moved away.
 */
const agentBrowserNotices = new Map<string, number>();
const agentBrowserReveals = new Map<string, number>();
const AGENT_NOTICE_INTERVAL_MS = 60_000;
const AGENT_REVEAL_QUIET_MS = 90_000;

export function agentBrowserRevealDecision(input: {
  sessionId: string;
  activeSessionId: string | null;
  browserTabShown: boolean;
  settingsOpen: boolean;
  now: number;
}): 'reveal' | 'notify' | 'none' {
  if (input.sessionId === input.activeSessionId && !input.settingsOpen) {
    if (input.browserTabShown) {
      agentBrowserReveals.set(input.sessionId, input.now);
      return 'none';
    }
    const last = agentBrowserReveals.get(input.sessionId);
    if (last !== undefined && input.now - last < AGENT_REVEAL_QUIET_MS) return 'none';
    agentBrowserReveals.set(input.sessionId, input.now);
    return 'reveal';
  }
  const noticed = agentBrowserNotices.get(input.sessionId);
  if (noticed !== undefined && input.now - noticed < AGENT_NOTICE_INTERVAL_MS) return 'none';
  agentBrowserNotices.set(input.sessionId, input.now);
  return 'notify';
}
