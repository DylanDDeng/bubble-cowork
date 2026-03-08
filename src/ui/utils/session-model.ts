import type { AgentProvider, SessionView, StreamMessage } from '../types';

export function getSessionModel(messages?: StreamMessage[] | null): string | null {
  if (!messages || messages.length === 0) {
    return null;
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.type === 'system' && message.subtype === 'init') {
      const model = message.model.trim();
      return model.length > 0 ? model : null;
    }
  }

  return null;
}

export function getLatestProviderModel(
  sessions: Record<string, SessionView>,
  provider: AgentProvider
): string | null {
  return (
    Object.values(sessions)
      .filter((session) => session.provider === provider)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((session) => session.model || getSessionModel(session.messages))
      .find((model): model is string => Boolean(model)) || null
  );
}
