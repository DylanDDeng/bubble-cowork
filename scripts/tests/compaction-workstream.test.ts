import assert from 'node:assert/strict';
import { deriveTranscriptTimelineItems } from '../../src/ui/utils/transcript-timeline';
import { createBatchWorkstreamModel, type WorkstreamEntry } from '../../src/ui/utils/workstream';
import type { StreamMessage } from '../../src/ui/types';
import type { CompactionMessage } from '../../src/ui/utils/compaction';

const prompt: StreamMessage = { type: 'user_prompt', prompt: 'Align the behavior', createdAt: 100 };
const note = (uuid: string, createdAt: number): Extract<StreamMessage, { type: 'assistant' }> => ({
  type: 'assistant', uuid, createdAt, agentId: 'profile', agentRunId: 'run-1',
  phase: 'commentary', message: { content: [{ type: 'text', text: uuid }] },
});
const start = (id = 'compact-1', createdAt = 300): Extract<CompactionMessage, { subtype: 'compact_status' }> => ({
  type: 'system', subtype: 'compact_status', uuid: `${id}:start`, compactionId: id,
  session_id: 'session', trigger: 'auto', status: 'started', createdAt,
});
const boundary = (id = 'compact-1', createdAt = 400): Extract<CompactionMessage, { subtype: 'compact_boundary' }> => ({
  type: 'system', subtype: 'compact_boundary', uuid: `${id}:end`, compactionId: id,
  session_id: 'session', compactMetadata: { trigger: 'auto', preTokens: 21699 }, createdAt,
});
const answer: StreamMessage = {
  ...note('answer', 600), phase: 'final_answer',
};
const result: StreamMessage = { type: 'result', subtype: 'success', duration_ms: 7000, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } };
function model(messages: StreamMessage[], running = false) {
  const timeline = deriveTranscriptTimelineItems(messages, { sessionRunning: running, activeTurnStartIndex: 0 });
  const groups = timeline.filter(item => item.type === 'work');
  assert.equal(groups.length, 1, 'compaction must not split an attributed assistant run');
  assert(!timeline.some(item => item.type === 'message' && item.message.type === 'system' &&
    ['compact_status', 'compact_boundary'].includes(item.message.subtype)), 'no outer compaction divider');
  const group = groups[0];
  return { timeline, group, model: createBatchWorkstreamModel({ messages: group.group.messages,
    toolStatusMap: new Map(), toolResultsMap: new Map(), isSessionRunning: group.active }) };
}

function compactionState(entry: WorkstreamEntry | undefined) {
  assert(entry?.type === 'compaction');
  return entry.state;
}
const live = model([prompt, note('Before compaction', 200), start()], true);
assert.deepEqual(live.model.entries.map(e => e.type), ['note', 'compaction']);
assert.equal(compactionState(live.model.entries.at(-1)), 'inProgress');
const finishedMessages = [prompt, note('Before compaction', 200), start(), boundary(), note('After compaction', 500), answer, result];
const finished = model(finishedMessages);
assert.deepEqual(finished.model.entries.map(e => e.type), ['note', 'compaction', 'note']);
assert.equal(finished.model.entries[1].id, live.model.entries[1].id, 'completion updates the same row');
assert.equal(compactionState(finished.model.entries[1]), 'completed');
assert.equal(finished.group.defaultExpanded, false);
assert.equal(finished.group.group.durationMs, 7000);
assert.equal(finished.model.entries[1].summary, 'Context automatically compacted');
assert.deepEqual(model(JSON.parse(JSON.stringify(finishedMessages))).model.entries, finished.model.entries, 'history replay preserves position and status');
assert.deepEqual(model(finishedMessages.slice(0, -1), true).model.entries.map(e => e.type), ['note', 'compaction', 'note'], 'streaming final answer collapses the completed work');
const legacy = boundary(); delete legacy.compactionId;
assert.deepEqual(model([prompt, note('Before', 200), legacy, note('After', 500), answer, result]).model.entries.map(e => e.type), ['note', 'compaction', 'note']);
const legacyStart = start(); delete legacyStart.compactionId;
assert.equal(model([prompt, legacyStart, legacy, result]).model.entries.length, 1, 'legacy hook/boundary pair merges');
const manual = boundary(); manual.compactMetadata.trigger = 'manual';
assert.equal(model([prompt, manual, result]).model.entries[0].summary, 'Context compacted');
assert.equal(compactionState(model([prompt, start()]).model.entries[0]), 'interrupted', 'uncompleted historical start must not spin forever');
const interruption = { ...start(), uuid: 'interrupted', status: 'interrupted' as const, createdAt: 400 };
assert.equal(compactionState(model([prompt, start(), interruption, note('resumed', 500)], true).model.entries[0]), 'interrupted');
assert.equal(model([prompt, start(), boundary(), start('compact-2', 500), boundary('compact-2', 550), result]).model.entries.length, 2, 'distinct compactions in one turn survive');
assert.equal(model([prompt, start(), boundary(), boundary(), result]).model.entries.length, 1, 'same native item is deduped on replay');
console.log('compaction workstream: ordering, lifecycle, attribution, final streaming and history passed');
