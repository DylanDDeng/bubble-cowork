const CLAUDE_CONTEXT_1M_BETA = 'context-1m-2025-08-07';

const CLAUDE_FAMILY_ALIASES = new Set(['sonnet', 'opus', 'haiku']);

// Older Aegis builds pinned "latest" picks to the then-newest concrete model
// id, which went stale the moment a newer model shipped (a stored
// claude-opus-4-7 kept masquerading as "latest" after 4-8 released). Stored
// ids from that era are mapped back to their family alias so they keep
// tracking latest. Legacy migration only — never add new models here.
const LEGACY_PINNED_LATEST_MODELS: Record<string, string> = {
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

  // Bare family aliases stay aliases: the Claude runtime resolves them to the
  // newest model server-side, so pinning them to a concrete version here would
  // require a hand-maintained table that inevitably goes stale.
  const bareAlias = stripContext1mSuffix(trimmed.toLowerCase());
  if (CLAUDE_FAMILY_ALIASES.has(bareAlias)) {
    return bareAlias;
  }
  return trimmed;
}

export function isClaudeFamilyAlias(model?: string | null): boolean {
  if (typeof model !== 'string') return false;
  return CLAUDE_FAMILY_ALIASES.has(stripContext1mSuffix(model.trim().toLowerCase()));
}

export function supportsClaude1mContext(model?: string | null): boolean {
  const normalized = normalizeClaudeRequestedModel(model);
  if (!normalized) return false;
  if (normalized === 'sonnet' || normalized === 'opus') return true;
  // Family-based (any sonnet/opus generation), mirroring the frontend rule in
  // src/ui/utils/claude-model.ts so new model versions are supported without a code change.
  return /^claude-(sonnet|opus)-\d+/i.test(normalized);
}

export function toClaudeCodeRuntimeModel(
  model?: string | null,
  betas?: string[] | null
): string | undefined {
  const normalized = normalizeClaudeRequestedModel(model);
  if (!normalized) {
    return undefined;
  }

  const runtimeAlias = CLAUDE_FAMILY_ALIASES.has(normalized)
    ? normalized
    : LEGACY_PINNED_LATEST_MODELS[normalized];
  if (!runtimeAlias) {
    return normalized;
  }

  const wants1m =
    hasContext1mSuffix(model) || Boolean(betas?.includes(CLAUDE_CONTEXT_1M_BETA));
  return wants1m && supportsClaude1mContext(runtimeAlias) ? `${runtimeAlias}[1m]` : runtimeAlias;
}

/**
 * Whether a requested model and a stored/display model refer to the same
 * effective selection. A bare family alias ('opus') resolves server-side to
 * the newest concrete model of its family, and session init records the
 * CLI-reported concrete id back into the session — so the composer's alias
 * compared against that stored concrete id is NOT a model change (treating
 * it as one made every follow-up message abort the warm runner and cold
 * respawn). Two different concrete ids remain a real change; family names
 * come from CLAUDE_FAMILY_ALIASES (no pinned versions).
 */
export function isSameClaudeModelSelection(
  a?: string | null,
  b?: string | null
): boolean {
  const na = normalizeClaudeRequestedModel(a);
  const nb = normalizeClaudeRequestedModel(b);
  if (na === nb) return true;
  if (!na || !nb) return false;
  const aliasSide = CLAUDE_FAMILY_ALIASES.has(na)
    ? na
    : CLAUDE_FAMILY_ALIASES.has(nb)
      ? nb
      : undefined;
  if (!aliasSide) return false;
  const concreteSide = aliasSide === na ? nb : na;
  if (CLAUDE_FAMILY_ALIASES.has(concreteSide)) return false;
  return claudeModelFamily(concreteSide) === aliasSide;
}

/** 'claude-opus-4-8' → 'opus'; 'sonnet' → 'sonnet'; unknown shapes → undefined. */
function claudeModelFamily(model: string): string | undefined {
  const bare = stripContext1mSuffix(model.trim().toLowerCase());
  if (CLAUDE_FAMILY_ALIASES.has(bare)) return bare;
  const familyPattern = new RegExp(`^claude-(${[...CLAUDE_FAMILY_ALIASES].join('|')})\\b`);
  const match = familyPattern.exec(bare);
  return match?.[1];
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
