import type { ClaudeModelUsage, StreamMessage } from '../types';

export type ClaudeContextSnapshot = {
  model: string;
  used: number;
  total: number;
  percent: number;
  costUSD: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  maxOutputTokens: number;
  webSearchRequests: number;
};

export type CodexContextSnapshot = {
  used: number;
  total: number;
  percent: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type ContextUsageLevel = 'safe' | 'warning' | 'critical';

// Threshold percentages of the context window. The Claude Agent SDK auto-compacts
// near the upper limit, so we warn ahead of time to make the boundary feel intentional.
export const CONTEXT_WARNING_PERCENT = 75;
export const CONTEXT_CRITICAL_PERCENT = 90;

export function getContextUsageLevel(percent: number): ContextUsageLevel {
  if (percent >= CONTEXT_CRITICAL_PERCENT) return 'critical';
  if (percent >= CONTEXT_WARNING_PERCENT) return 'warning';
  return 'safe';
}

// CSS variable used to color the usage ring / banner for a given level.
export function getContextLevelColorVar(level: ContextUsageLevel): string {
  switch (level) {
    case 'critical':
      return 'var(--error)';
    case 'warning':
      return 'var(--warning)';
    default:
      return 'var(--text-secondary)';
  }
}

function isResultMessage(message: StreamMessage): message is Extract<StreamMessage, { type: 'result' }> {
  return message.type === 'result';
}

function isCodexTokenUsageMessage(
  message: StreamMessage
): message is Extract<StreamMessage, { type: 'system'; subtype: 'token_usage' }> {
  return message.type === 'system' && message.subtype === 'token_usage' && message.provider === 'codex';
}

function selectModelUsageEntry(
  modelUsage: Record<string, ClaudeModelUsage>,
  preferredModel?: string | null
): [string, ClaudeModelUsage] | null {
  const entries = Object.entries(modelUsage);
  if (entries.length === 0) {
    return null;
  }

  const normalizedPreferred = preferredModel?.trim().toLowerCase();
  if (normalizedPreferred) {
    return entries.find(([model]) => isClaudeUsageModelMatch(model, normalizedPreferred)) || null;
  }

  return entries.sort((left, right) => {
    const leftUsage = left[1].inputTokens + left[1].outputTokens;
    const rightUsage = right[1].inputTokens + right[1].outputTokens;
    return rightUsage - leftUsage;
  })[0] || null;
}

function normalizeClaudeUsageModelKey(model?: string | null): string {
  return (model || '').trim().toLowerCase().replace(/\[1m\]$/i, '');
}

export function isClaudeUsageModelMatch(
  reportedModel?: string | null,
  preferredModel?: string | null
): boolean {
  const preferred = normalizeClaudeUsageModelKey(preferredModel);
  if (!preferred) return true;
  return normalizeClaudeUsageModelKey(reportedModel) === preferred;
}

export function buildClaudeContextSnapshot(
  model: string,
  usage: ClaudeModelUsage
): ClaudeContextSnapshot {
  const cacheReadTokens = usage.cacheReadInputTokens || 0;
  const cacheCreationTokens = usage.cacheCreationInputTokens || 0;
  const outputTokens = usage.outputTokens || 0;
  const inputTokens = usage.inputTokens || 0;
  const total = usage.contextWindow || 0;
  const used = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

  return {
    model,
    used,
    total,
    percent: total > 0 ? Math.min(100, Math.max(0, Math.round((used / total) * 100))) : 0,
    costUSD: usage.costUSD || 0,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    maxOutputTokens: usage.maxOutputTokens || 0,
    webSearchRequests: usage.webSearchRequests || 0,
  };
}

export function getLatestClaudeContextSnapshot(
  messages: StreamMessage[],
  preferredModel?: string | null
): ClaudeContextSnapshot | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isResultMessage(message) || !message.modelUsage) {
      continue;
    }

    const selected = selectModelUsageEntry(message.modelUsage, preferredModel);
    if (!selected) {
      continue;
    }

    const [model, usage] = selected;
    return buildClaudeContextSnapshot(model, usage);
  }

  return null;
}

export function getLatestCodexContextSnapshot(messages: StreamMessage[]): CodexContextSnapshot | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isCodexTokenUsageMessage(message)) {
      continue;
    }

    const contextWindow = message.usage.contextWindow || 0;
    if (contextWindow <= 0) {
      continue;
    }

    const used = message.usage.totalTokens || 0;
    return {
      used,
      total: contextWindow,
      percent: Math.min(100, Math.max(0, Math.round((used / contextWindow) * 100))),
      inputTokens: message.usage.inputTokens || 0,
      cachedInputTokens: message.usage.cachedInputTokens || 0,
      outputTokens: message.usage.outputTokens || 0,
      reasoningOutputTokens: message.usage.reasoningOutputTokens || 0,
    };
  }

  return null;
}
