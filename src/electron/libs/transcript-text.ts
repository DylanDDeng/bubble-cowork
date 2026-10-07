import type { StreamMessage } from '../../shared/types';

/** Visible assistant prose of one stored message (plans included, tool calls excluded). */
export function extractAssistantText(message: StreamMessage): string {
  if (message.type === 'proposed_plan') {
    const planMarkdown = message.planMarkdown.trim();
    return planMarkdown ? `Proposed plan:\n${planMarkdown}` : '';
  }

  if (message.type !== 'assistant' || !message.message || !Array.isArray(message.message.content)) {
    return '';
  }

  return message.message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

/** Assistant rows Aegis writes itself (usage, compaction notices) rather than the agent. */
export function isLocalUtilityAssistantText(text: string): boolean {
  return (
    text.startsWith('**Session usage**') ||
    text.startsWith('**Context compacted**') ||
    text.startsWith('Compacting conversation...') ||
    text.startsWith('Failed to compact conversation') ||
    text.includes('Aegis yet.')
  );
}
