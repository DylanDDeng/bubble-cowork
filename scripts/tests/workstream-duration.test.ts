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

// Disclosure identity belongs to the turn, not its message count or lifecycle.
const prompt: StreamMessage = { type: 'user_prompt', prompt: 'Inspect the project', createdAt: 1000 };
const reasoning: StreamMessage = { type: 'assistant', uuid: 'r1', createdAt: 1100,
  message: { content: [{ type: 'thinking', thinking: 'Inspecting files' }] } };
const commentary: StreamMessage = { type: 'assistant', uuid: 'c1', createdAt: 1200, phase: 'commentary',
  message: { content: [{ type: 'text', text: 'I will inspect the files.' }] } };
const final: StreamMessage = { type: 'assistant', uuid: 'f1', createdAt: 2500, streaming: true, phase: 'final_answer',
  message: { content: [{ type: 'text', text: 'The implementation' }] } };
const runningOptions = { sessionRunning: true, activeTurnStartIndex: 0 };
const before = deriveTranscriptTimelineItems([prompt, reasoning], runningOptions);
const during = deriveTranscriptTimelineItems([prompt, reasoning, commentary], runningOptions);
const answering = deriveTranscriptTimelineItems([prompt, reasoning, commentary, final], runningOptions);
const work = (items: ReturnType<typeof deriveTranscriptTimelineItems>) => items.find(item => item.type === 'work')!;
assert.equal(work(before).disclosureResetKey, work(during).disclosureResetKey, 'new messages keep disclosure identity');
assert.equal(work(during).disclosureResetKey, work(answering).disclosureResetKey, 'final answer keeps disclosure identity');
assert.equal(work(during).active, true, 'commentary keeps work active');
assert.equal(work(answering).active, false, 'explicit final answer settles the trace before the runtime ends');
assert.equal(work(answering).defaultExpanded, false);
assert(answering.some(item => item.type === 'message' && item.message.type === 'assistant' && item.message.uuid === 'f1'));
const unphased = deriveTranscriptTimelineItems([prompt, reasoning, { ...final, phase: undefined }], runningOptions);
assert.equal(work(unphased).active, true, 'unphased providers do not collapse during a tool-idle gap');
const tool: StreamMessage = { type: 'assistant', uuid: 'pending', createdAt: 1400,
  message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } };
const interrupted = deriveTranscriptTimelineItems([prompt, reasoning, tool], { ...runningOptions, sessionRunning: false });
assert.equal(work(interrupted).defaultExpanded, true, 'stopping a pending tool keeps the trace visible');
const noFinal = deriveTranscriptTimelineItems([prompt, reasoning, commentary], { sessionRunning: false });
assert(!noFinal.some(item => item.type === 'message' && item.message.type === 'assistant'), 'explicit commentary never becomes a final answer');
assert.equal(work(noFinal).canCollapse, false, 'a stopped commentary-only turn does not acquire a completed disclosure');
const stoppedThinking = deriveTranscriptTimelineItems([prompt, reasoning], { sessionRunning: false });
assert.equal(work(stoppedThinking).canCollapse, false, 'a stopped thinking-only turn stays visible');
assert.equal(work(answering).canCollapse, true, 'native final answer permits completed disclosure');

console.log('workstream-duration: all assertions passed');
