export function normalizeClaudeRequestedModel(model?: string | null): string | undefined {
  if (typeof model !== 'string') return undefined;
  const trimmed = model.trim();
  if (!trimmed.length) return undefined;

  const lower = trimmed.toLowerCase();
  const normalizedWithout1m = lower.replace(/\[1m\]$/i, '');

  switch (normalizedWithout1m) {
    case 'sonnet':
    case 'claude-sonnet-4-6':
      return 'claude-sonnet-4-6';
    case 'opus':
    case 'claude-opus-4-6':
      return 'claude-opus-4-6';
    case 'haiku':
    case 'claude-haiku-4-5':
      return 'claude-haiku-4-5';
    default:
      return trimmed;
  }
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
