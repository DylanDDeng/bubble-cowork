const CLAUDE_CONTEXT_1M_BETA = 'context-1m-2025-08-07';

const CLAUDE_CODE_RUNTIME_ALIASES: Record<string, string> = {
  'claude-sonnet-4-6': 'sonnet',
  'claude-opus-4-7': 'opus',
  'claude-haiku-4-5': 'haiku',
};

function stripContext1mSuffix(model: string): string {
  return model.replace(/\[1m\]$/i, '');
}

function hasContext1mSuffix(model?: string | null): boolean {
  return typeof model === 'string' && /\[1m\]$/i.test(model.trim());
}

export function normalizeClaudeRequestedModel(model?: string | null): string | undefined {
  if (typeof model !== 'string') return undefined;
  const trimmed = model.trim();
  if (!trimmed.length) return undefined;

  const lower = trimmed.toLowerCase();
  const normalizedWithout1m = stripContext1mSuffix(lower);

  switch (normalizedWithout1m) {
    case 'sonnet':
    case 'claude-sonnet-4-6':
      return 'claude-sonnet-4-6';
    case 'opus':
    case 'claude-opus-4-7':
      return 'claude-opus-4-7';
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
  return (
    normalized === 'claude-sonnet-4-6' ||
    normalized === 'claude-opus-4-7' ||
    normalized === 'claude-opus-4-6'
  );
}

export function toClaudeCodeRuntimeModel(
  model?: string | null,
  betas?: string[] | null
): string | undefined {
  const normalized = normalizeClaudeRequestedModel(model);
  if (!normalized) {
    return undefined;
  }

  const runtimeAlias = CLAUDE_CODE_RUNTIME_ALIASES[normalized];
  if (!runtimeAlias) {
    return normalized;
  }

  const wants1m =
    hasContext1mSuffix(model) || Boolean(betas?.includes(CLAUDE_CONTEXT_1M_BETA));
  return wants1m && supportsClaude1mContext(normalized) ? `${runtimeAlias}[1m]` : runtimeAlias;
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
