import type { ClaudeModelUsage, StreamMessage } from '../types';

export type ClaudeContextSnapshot = {
  model: string;
  total: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  maxOutputTokens: number;
  webSearchRequests: number;
};

function isResultMessage(message: StreamMessage): message is Extract<StreamMessage, { type: 'result' }> {
  return message.type === 'result';
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
    const exactMatch = entries.find(([model]) => model.trim().toLowerCase() === normalizedPreferred);
    if (exactMatch) {
      return exactMatch;
    }
  }

  return entries.sort((left, right) => {
    const leftUsage = left[1].inputTokens + left[1].outputTokens;
    const rightUsage = right[1].inputTokens + right[1].outputTokens;
    return rightUsage - leftUsage;
  })[0] || null;
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
    const cacheReadTokens = usage.cacheReadInputTokens || 0;
    const cacheCreationTokens = usage.cacheCreationInputTokens || 0;
    const outputTokens = usage.outputTokens || 0;
    const inputTokens = usage.inputTokens || 0;

    return {
      model,
      total: usage.contextWindow || 0,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      maxOutputTokens: usage.maxOutputTokens || 0,
      webSearchRequests: usage.webSearchRequests || 0,
    };
  }

  return null;
}
