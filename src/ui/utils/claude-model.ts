import type { ClaudeCompatibleProviderId, ClaudeModelConfig } from '../types';

const STORAGE_KEY = 'cowork.preferredClaudeModel';
const COMPATIBLE_PROVIDER_STORAGE_KEY = 'cowork.preferredClaudeCompatibleProvider';
const CONTEXT_1M_STORAGE_KEY = 'cowork.preferredClaudeContext1m';

export const CLAUDE_MODEL_PRESETS = [
  'claude-sonnet-4-6',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-haiku-4-5',
];

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
  return (
    CLAUDE_MODEL_PRESETS.includes(normalized) ||
    normalized.startsWith('claude-') ||
    CLAUDE_SHORT_ALIASES.has(normalized.toLowerCase())
  );
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

  const known = CLAUDE_MODEL_PRESETS.filter((value) =>
    [...normalizedConfigValues, ...normalizedExtras].some((candidate) => candidate === value)
  );

  const unknown = [...normalizedConfigValues, ...normalizedExtras].filter(
    (value): value is string => Boolean(value && value.trim() && !CLAUDE_MODEL_PRESETS.includes(value.trim()))
  );

  return Array.from(new Set([...known, ...CLAUDE_MODEL_PRESETS, ...unknown]));
}
