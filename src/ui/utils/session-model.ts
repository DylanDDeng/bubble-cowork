import type {
  AgentProvider,
  ClaudeCompatibleProviderId,
  SessionView,
  StreamMessage,
} from '../types';

export interface AgentModelSelection {
  provider: AgentProvider;
  model: string | null;
  compatibleProviderId: ClaudeCompatibleProviderId | null;
}

export function applySessionAgentSelection(
  session: SessionView,
  selection: AgentModelSelection
): SessionView {
  return {
    ...session,
    provider: selection.provider,
    model: selection.model || undefined,
    compatibleProviderId:
      selection.provider === 'claude'
        ? selection.compatibleProviderId || undefined
        : undefined,
  };
}

/**
 * Resolve a model id for picker/session state.
 * - Prefer explicit session model, then preferred, then config default.
 * - While the model list is still empty (config loading), still accept those
 *   candidates so the composer does not flash the empty "Default" option.
 * - If the list is loaded and an explicit session model is missing from it
 *   (stale list), keep the session model instead of clearing to null.
 */
export function resolveListedOrPendingModel(
  requestedModel: string | null | undefined,
  preferredModel: string | null | undefined,
  defaultModel: string | null | undefined,
  listedValues: Iterable<string>
): string | null {
  const nonEmptyListed = new Set(
    Array.from(listedValues)
      .map((value) => value.trim())
      .filter(Boolean)
  );
  const candidates = [requestedModel, preferredModel, defaultModel]
    .map((value) => value?.trim() || null)
    .filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (nonEmptyListed.size === 0 || nonEmptyListed.has(candidate)) {
      return candidate;
    }
  }

  if (requestedModel?.trim()) {
    return requestedModel.trim();
  }
  return null;
}

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
