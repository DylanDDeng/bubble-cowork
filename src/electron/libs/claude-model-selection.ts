export function normalizeClaudeRequestedModel(model?: string | null): string | undefined {
  if (typeof model !== 'string') return undefined;
  const trimmed = model.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function supportsClaude1mContext(model?: string | null): boolean {
  const normalized = normalizeClaudeRequestedModel(model);
  return normalized === 'claude-sonnet-4-6' || normalized === 'claude-opus-4-6';
}

export function reconcileClaudeDisplayModel(
  requestedModel?: string | null,
  runtimeModel?: string | null
): string | undefined {
  const requested = normalizeClaudeRequestedModel(requestedModel);
  const runtime = normalizeClaudeRequestedModel(runtimeModel);

  if (!requested) {
    return runtime;
  }

  if (!runtime) {
    return requested;
  }

  if (supportsClaude1mContext(requested) && runtime.startsWith(requested)) {
    return requested;
  }

  return runtime;
}
