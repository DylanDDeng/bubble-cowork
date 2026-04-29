import type { ClaudeReasoningEffort, ClaudeReasoningLevelOption } from '../types';

const STORAGE_KEY = 'cowork.preferredClaudeReasoningEfforts';

function normalizeClaudeReasoningEffort(
  raw: string | null | undefined
): ClaudeReasoningEffort | null {
  switch ((raw || '').trim().toLowerCase()) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return raw!.trim().toLowerCase() as ClaudeReasoningEffort;
    default:
      return null;
  }
}

function loadStoredPreferences(): Record<string, ClaudeReasoningEffort> {
  if (typeof window === 'undefined') {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Record<string, string>;
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([model, effort]) => [model, normalizeClaudeReasoningEffort(effort)] as const)
        .filter((entry): entry is [string, ClaudeReasoningEffort] => Boolean(entry[1]))
    );
  } catch {
    return {};
  }
}

function saveStoredPreferences(preferences: Record<string, ClaudeReasoningEffort>): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}

export function loadPreferredClaudeReasoningEffort(model: string | null): ClaudeReasoningEffort | null {
  if (!model) {
    return null;
  }

  return loadStoredPreferences()[model] || null;
}

export function savePreferredClaudeReasoningEffort(
  model: string | null,
  effort: ClaudeReasoningEffort
): void {
  if (!model || typeof window === 'undefined') {
    return;
  }

  const preferences = loadStoredPreferences();
  preferences[model] = effort;
  saveStoredPreferences(preferences);
}

export function getClaudeReasoningOptions(model: string | null): ClaudeReasoningLevelOption[] {
  const options: ClaudeReasoningLevelOption[] = [
    { effort: 'low', description: 'Minimal thinking, fastest responses' },
    { effort: 'medium', description: 'Moderate thinking for everyday tasks' },
    { effort: 'high', description: 'Deep reasoning, Claude Code default' },
    { effort: 'xhigh', description: 'Extra high reasoning depth for complex tasks' },
    { effort: 'max', description: 'Maximum effort for supported Claude Code runs' },
  ];

  return options;
}

export function getDefaultClaudeReasoningEffort(model: string | null): ClaudeReasoningEffort {
  return loadPreferredClaudeReasoningEffort(model) || 'high';
}
