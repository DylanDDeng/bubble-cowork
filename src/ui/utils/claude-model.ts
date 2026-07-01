import type { ClaudeCompatibleProviderId, ClaudeModelConfig } from '../types';

const STORAGE_KEY = 'cowork.preferredClaudeModel';
const COMPATIBLE_PROVIDER_STORAGE_KEY = 'cowork.preferredClaudeCompatibleProvider';
const CONTEXT_1M_STORAGE_KEY = 'cowork.preferredClaudeContext1m';

const CLAUDE_SHORT_ALIASES = new Set(['sonnet', 'opus', 'haiku']);

function parseClaudeShortAlias(model: string | null | undefined): 'sonnet' | 'opus' | 'haiku' | null {
  const normalized = canonicalizeClaudeModel(model);
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  return CLAUDE_SHORT_ALIASES.has(lower) ? (lower as 'sonnet' | 'opus' | 'haiku') : null;
}

export function canonicalizeClaudeModel(model: string | null | undefined): string | null {
  const normalized = model?.trim();
  if (!normalized) {
    return null;
  }
  return normalized.replace(/\[1m\]$/i, '');
}

function parseClaudeModelFamily(
  model: string | null | undefined
): { family: 'sonnet' | 'opus' | 'haiku'; major: number; minor: number } | null {
  const normalized = canonicalizeClaudeModel(model);
  if (!normalized) return null;
  const match = normalized.match(/^claude-(sonnet|opus|haiku)-(\d+)(?:-(\d+))?/i);
  if (!match) return null;
  const family = match[1].toLowerCase() as 'sonnet' | 'opus' | 'haiku';
  const major = Number(match[2]);
  const minor = match[3] ? Number(match[3]) : 0;
  return { family, major, minor };
}

export function loadPreferredClaudeModel(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  return canonicalizeClaudeModel(raw);
}

export function savePreferredClaudeModel(model: string | null): void {
  if (typeof window === 'undefined') return;
  if (!model) {
    window.localStorage.removeItem(STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, canonicalizeClaudeModel(model) || model);
}

export function loadPreferredClaudeCompatibleProviderId(): ClaudeCompatibleProviderId | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(COMPATIBLE_PROVIDER_STORAGE_KEY);
  if (
    raw === 'minimaxCn' ||
    raw === 'minimax' ||
    raw === 'mimo' ||
    raw === 'zhipu' ||
    raw === 'moonshot' ||
    raw === 'deepseek'
  ) {
    return raw;
  }
  return null;
}

export function savePreferredClaudeCompatibleProviderId(
  providerId: ClaudeCompatibleProviderId | null
): void {
  if (typeof window === 'undefined') return;
  if (!providerId) {
    window.localStorage.removeItem(COMPATIBLE_PROVIDER_STORAGE_KEY);
    return;
  }
  window.localStorage.setItem(COMPATIBLE_PROVIDER_STORAGE_KEY, providerId);
}

export function loadPreferredClaudeContext1m(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(CONTEXT_1M_STORAGE_KEY) === 'true';
}

export function savePreferredClaudeContext1m(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(CONTEXT_1M_STORAGE_KEY, enabled ? 'true' : 'false');
}

export function supportsClaude1mContext(model?: string | null): boolean {
  const alias = parseClaudeShortAlias(model);
  if (alias === 'sonnet' || alias === 'opus') {
    return true;
  }
  const parsed = parseClaudeModelFamily(model);
  if (!parsed) return false;
  return parsed.family === 'sonnet' || parsed.family === 'opus';
}

export function isOfficialClaudeModel(model?: string | null): boolean {
  const normalized = canonicalizeClaudeModel(model) || model?.trim() || '';
  if (!normalized) return false;
  return normalized.startsWith('claude-') || CLAUDE_SHORT_ALIASES.has(normalized.toLowerCase());
}

export function formatClaudeModelLabel(model: string, context1m = false): string {
  const normalized = canonicalizeClaudeModel(model) || model.trim();
  const parsed = parseClaudeModelFamily(normalized);

  if (parsed) {
    const familyLabel =
      parsed.family === 'sonnet' ? 'Sonnet' : parsed.family === 'opus' ? 'Opus' : 'Haiku';
    const versionLabel = `${parsed.major}.${parsed.minor}`;
    const suffix = context1m && supportsClaude1mContext(normalized) ? ' (1M context)' : '';
    return `${familyLabel} ${versionLabel}${suffix}`;
  }

  const alias = parseClaudeShortAlias(normalized);
  if (alias) {
    const aliasLabel = alias === 'sonnet' ? 'Sonnet' : alias === 'opus' ? 'Opus' : 'Haiku';
    const suffix = context1m && supportsClaude1mContext(normalized) ? ' (1M context)' : '';
    return `${aliasLabel} (latest)${suffix}`;
  }

  return model;
}

// Collapse each Claude family (sonnet/opus/haiku) to a single "latest" entry and drop
// superseded versions. Within a family the survivor is:
//   1. the bare alias (e.g. "sonnet" → "Sonnet (latest)") if one is present — it always
//      tracks the newest model, so the concrete latest version is merged into it; else
//   2. the highest concrete version, decided by comparing version numbers parsed from the
//      id, so a newer generation wins automatically — no hardcoded model list to maintain.
// Models that don't parse into a family (Fable, third-party ids) pass through untouched,
// and anything in `protectedModels` (e.g. the currently selected model) is always kept.
function collapseClaudeFamiliesToLatest(
  models: string[],
  protectedModels: Set<string> = new Set()
): string[] {
  const aliasByFamily = new Map<string, string>();
  for (const model of models) {
    const alias = parseClaudeShortAlias(model);
    if (alias) aliasByFamily.set(alias, model);
  }

  const latestByFamily = new Map<string, { major: number; minor: number; id: string }>();
  for (const model of models) {
    const parsed = parseClaudeModelFamily(model);
    if (!parsed) continue;
    const current = latestByFamily.get(parsed.family);
    if (
      !current ||
      parsed.major > current.major ||
      (parsed.major === current.major && parsed.minor > current.minor)
    ) {
      latestByFamily.set(parsed.family, { major: parsed.major, minor: parsed.minor, id: model });
    }
  }

  return models.filter((model) => {
    if (protectedModels.has(model)) return true;
    const alias = parseClaudeShortAlias(model);
    if (alias) return aliasByFamily.get(alias) === model;
    const parsed = parseClaudeModelFamily(model);
    if (!parsed) return true;
    // Drop superseded versions, and drop the concrete latest when a bare alias already
    // represents this family's "latest" slot (they resolve to the same model).
    if (latestByFamily.get(parsed.family)?.id !== model) return false;
    return !aliasByFamily.has(parsed.family);
  });
}

export function buildClaudeModelOptions(
  config: ClaudeModelConfig,
  extraModels: Array<string | null | undefined> = []
): string[] {
  const normalizedConfigValues = [config.defaultModel, ...config.options]
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => canonicalizeClaudeModel(value) || value.trim());
  const normalizedExtras = extraModels
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => canonicalizeClaudeModel(value) || value.trim());

  const all = Array.from(new Set([...normalizedConfigValues, ...normalizedExtras]));
  return collapseClaudeFamiliesToLatest(all, new Set(normalizedExtras));
}
