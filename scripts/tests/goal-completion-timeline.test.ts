import assert from 'node:assert/strict';
import type { StreamMessage } from '../../src/shared/types';
import type { ThreadGoal } from '../../src/shared/session-goal';
import { deriveTranscriptTimelineItems } from '../../src/ui/utils/transcript-timeline';

const answer = (uuid: string, createdAt: number): StreamMessage => ({
  type: 'assistant', uuid, createdAt,
  message: { content: [{ type: 'text', text: `Answer ${uuid}` }] },
});
const completed = (uuid: string, createdAt: number, updatedAt: number): StreamMessage => ({
  type: 'goal_completed', uuid, createdAt: updatedAt * 1000,
  goal: { threadId: 'task', objective: uuid, status: 'complete', createdAt, updatedAt,
    timeUsedSeconds: updatedAt - createdAt, tokensUsed: 0, tokenBudget: null },
});
const first = completed('first-goal', 1, 5);
const second = completed('second-goal', 10, 20);
const history: StreamMessage[] = [
  { type: 'user_prompt', prompt: '/goal first', createdAt: 1000 },
  answer('first-answer', 4500),
  // A queued prompt may precede the native completion event.
  { type: 'user_prompt', prompt: 'Follow up', createdAt: 4900 },
  answer('ordinary-answer', 7000),
  first,
  { type: 'user_prompt', prompt: '/goal second', createdAt: 10000 },
  answer('second-answer', 19000),
  { ...answer('child-answer', 19500), parentToolUseId: 'task-tool' },
  second,
  { type: 'user_prompt', prompt: 'Next', createdAt: 21000 },
  answer('latest-answer', 22000),
];
function summaries(messages: StreamMessage[]) {
  return deriveTranscriptTimelineItems(messages).flatMap(item =>
    item.type === 'message' && item.message.type === 'assistant' && item.completedGoals
      ? [{ uuid: item.message.uuid, goals: item.completedGoals.map(g => g.objective) }] : []);
}
const expected = [
  { uuid: 'first-answer', goals: ['first-goal'] },
  { uuid: 'second-answer', goals: ['second-goal'] },
];
assert.deepEqual(summaries(history), expected, 'late events stay with the completed answer');
assert.deepEqual(summaries(JSON.parse(JSON.stringify(history))), expected, 'rehydrated history preserves turn ownership');
assert.deepEqual(summaries([...history, first]), expected, 'duplicate native completion does not duplicate a badge');
assert.deepEqual(summaries([second, answer('latest-answer', 22000)]), [], 'unloaded older answer does not attach to the new turn');
assert.deepEqual(summaries([answer('old-answer', 1000), second]), [], 'a goal cannot attach to an answer before it started');
const anchored = { ...second, afterMessageId: 'second-answer' } as StreamMessage;
assert.deepEqual(summaries([answer('second-answer', 20500), anchored, answer('later', 20600)]),
  [{ uuid: 'second-answer', goals: ['second-goal'] }], 'persisted reply identity wins over native timestamp precision');
assert.deepEqual(summaries([answer('different-answer', 19000), anchored]), [], 'an unloaded anchor cannot move to another answer');
assert.deepEqual(summaries([answer('second-answer', 19000), { ...second, goal: { ...(second as { goal: ThreadGoal }).goal, status: 'paused' } }]), [], 'paused goals do not create completion badges');
console.log('goal completion timeline: multiple goals, queued turns, late events, history reload and subagent isolation passed');
