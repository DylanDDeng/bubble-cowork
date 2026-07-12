import assert from 'node:assert/strict';
import type { StreamMessage } from '../../src/shared/types';
import { deriveTranscriptTimelineItems } from '../../src/ui/utils/transcript-timeline';
import { createBatchWorkstreamModel } from '../../src/ui/utils/workstream';

function completedTurn({
  promptAt,
  thinkingAt,
  answerAt,
  resultAt,
  reportedDurationMs,
}: {
  promptAt: number;
  thinkingAt: number;
  answerAt: number;
  resultAt: number;
  reportedDurationMs: number;
}): StreamMessage[] {
  return [
    { type: 'user_prompt', prompt: 'Review the project', createdAt: promptAt },
    {
      type: 'assistant',
      uuid: `thinking-${thinkingAt}`,
      createdAt: thinkingAt,
      message: { content: [{ type: 'thinking', thinking: 'Reviewing the request' }] },
    },
    {
      type: 'assistant',
      uuid: `answer-${answerAt}`,
      createdAt: answerAt,
      message: { content: [{ type: 'text', text: 'Here is the answer.' }] },
    },
    {
      type: 'result',
      subtype: 'success',
      duration_ms: reportedDurationMs,
      total_cost_usd: 0,
      usage: { input_tokens: 0, output_tokens: 0 },
      createdAt: resultAt,
    },
  ];
}

function getOnlyWorkGroup(messages: StreamMessage[]) {
  const workItems = deriveTranscriptTimelineItems(messages).filter(
    (item): item is Extract<ReturnType<typeof deriveTranscriptTimelineItems>[number], { type: 'work' }> =>
      item.type === 'work'
  );
  assert.equal(workItems.length, 1, 'the completed turn should produce one collapsed work group');
  return workItems[0].group;
}

const providerTimedGroup = getOnlyWorkGroup(
  completedTurn({
    promptAt: 1_000,
    thinkingAt: 6_000,
    answerAt: 21_000,
    resultAt: 21_100,
    reportedDurationMs: 20_472,
  })
);
assert.equal(
  providerTimedGroup.durationMs,
  20_472,
  'a non-zero provider result duration must be authoritative'
);

const fallbackTimedGroup = getOnlyWorkGroup(
  completedTurn({
    promptAt: 10_000,
    thinkingAt: 14_000,
    answerAt: 20_000,
    resultAt: 22_000,
    reportedDurationMs: 0,
  })
);
assert.equal(
  fallbackTimedGroup.durationMs,
  12_000,
  'zero-duration providers must fall back to prompt-to-result wall time'
);

const unknownDurationGroup = getOnlyWorkGroup(
  completedTurn({
    promptAt: 30_000,
    thinkingAt: 30_000,
    answerAt: 30_000,
    resultAt: 30_000,
    reportedDurationMs: 0,
  })
);
assert.equal(
  unknownDurationGroup.durationMs,
  undefined,
  'a single timestamp must remain unknown instead of becoming a misleading zero'
);

const providerTimedModel = createBatchWorkstreamModel({
  messages: providerTimedGroup.messages,
  toolStatusMap: new Map(),
  toolResultsMap: new Map(),
  isSessionRunning: false,
  durationMs: providerTimedGroup.durationMs,
});
assert.equal(providerTimedModel.durationMs, 20_472, 'timeline duration must reach the UI model');
assert.equal(providerTimedModel.noteCount, 1, 'the screenshot-shaped work group is reasoning-only');

const unknownDurationModel = createBatchWorkstreamModel({
  messages: unknownDurationGroup.messages,
  toolStatusMap: new Map(),
  toolResultsMap: new Map(),
  isSessionRunning: false,
  durationMs: unknownDurationGroup.durationMs,
});
assert.equal(
  unknownDurationModel.durationMs,
  undefined,
  'a one-message work group must not infer a zero duration'
);

console.log('workstream-duration: all assertions passed');
