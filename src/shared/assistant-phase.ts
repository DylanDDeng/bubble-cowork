import type { StreamMessage } from './types';

/** A model stop is useful only when the provider explicitly reports it.
 * Never infer a final answer from text length, a quiet period, or an empty tool queue. */
export function getAssistantPhase(message: StreamMessage): 'commentary' | 'final_answer' | undefined {
  if (message.type !== 'assistant') return undefined;
  if (message.phase) return message.phase;
  const reason = message.message.stop_reason;
  const blocks = message.message.content;
  if (blocks.some(block => block.type === 'tool_use') || reason === 'tool_use') return 'commentary';
  if (reason === 'end_turn' && blocks.some(block => block.type === 'text' && block.text.trim())) return 'final_answer';
  return undefined;
}
