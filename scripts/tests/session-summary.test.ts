import assert from 'node:assert/strict';
import type { StreamMessage } from '../../src/shared/types';
import {
  SESSION_SUMMARY_CHUNK_MAX_CHARS,
  SESSION_SUMMARY_SOURCE_VERSION,
  buildSessionSummarySourceIds,
  chunkSessionSummaryEntries,
  collectSessionSummaryEntries,
  digestSessionSummaryEntries,
  isAppendOnlySessionSummaryUpdate,
  isSessionSummaryCurrent,
  parseSessionSummarySourceIds,
  type SessionSummaryEntry,
} from '../../src/electron/libs/session-summary';

const userPrompt: StreamMessage = {
  type: 'user_prompt',
  prompt: 'Fix the sidebar width bug',
};

const assistantReply: StreamMessage = {
  type: 'assistant',
  uuid: 'assistant-1',
  message: {
    content: [{ type: 'text', text: 'I will inspect the sidebar width utilities.' }],
  },
};

const utilityAssistant: StreamMessage = {
  type: 'assistant',
  uuid: 'assistant-utility',
  message: {
    content: [{ type: 'text', text: '**Session usage** 12k tokens' }],
  },
};

const subagentAssistant: StreamMessage = {
  type: 'assistant',
  uuid: 'assistant-subagent',
  parentToolUseId: 'tool-1',
  message: {
    content: [{ type: 'text', text: 'Subagent output should be ignored.' }],
  },
};

const proposedPlan: StreamMessage = {
  type: 'proposed_plan',
  uuid: 'plan-1',
  planMarkdown: '## Plan\n- Update sidebar width',
};

const planUpdate: StreamMessage = {
  type: 'plan_update',
  uuid: 'plan-update-1',
  turnId: 'turn-1',
  steps: [
    { step: 'Inspect width helpers', status: 'completed' },
    { step: 'Update tests', status: 'inProgress' },
  ],
};

const toolUse: StreamMessage = {
  type: 'assistant',
  uuid: 'assistant-tool',
  message: {
    content: [
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'Read',
        input: { path: 'src/ui/utils/sidebar-width.ts' },
      },
    ],
  },
};

const toolResult: StreamMessage = {
  type: 'user',
  uuid: 'tool-result-1',
  message: {
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: 'export const SIDEBAR_WIDTH = 280;',
      },
    ],
  },
};

const failedResult: StreamMessage = {
  type: 'result',
  subtype: 'error',
  duration_ms: 1200,
  total_cost_usd: 0,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
};

const entries = collectSessionSummaryEntries([
  userPrompt,
  assistantReply,
  utilityAssistant,
  subagentAssistant,
  proposedPlan,
  planUpdate,
  toolUse,
  toolResult,
  failedResult,
]);

assert.deepEqual(
  entries.map((entry) => entry.role),
  ['user', 'assistant', 'plan', 'plan', 'tool', 'tool_result', 'event'],
  'collectSessionSummaryEntries should keep top-level roles and skip utility/subagent noise'
);
assert.equal(entries[0]?.text, 'Fix the sidebar width bug');
assert.match(entries[1]?.text || '', /sidebar width utilities/);
assert.match(entries[2]?.text || '', /## Plan/);
assert.match(entries[3]?.text || '', /\[completed\]/);
assert.match(entries[4]?.text || '', /^Read\n/);
assert.match(entries[5]?.text || '', /Result for tool-1/);
assert.equal(entries[6]?.text, 'The turn ended with an error.');

const longEntry: SessionSummaryEntry = {
  role: 'assistant',
  text: 'x'.repeat(SESSION_SUMMARY_CHUNK_MAX_CHARS + 500),
};
const chunks = chunkSessionSummaryEntries([longEntry], 1_000);
assert.ok(chunks.length > 1, 'chunkSessionSummaryEntries should split oversized rendered entries');
assert.ok(
  chunks.every((chunk) => chunk.length <= 1_000),
  'every chunk should respect the max character limit'
);

const sourceIds = buildSessionSummarySourceIds(entries, 2);
assert.equal(sourceIds[0], SESSION_SUMMARY_SOURCE_VERSION);
assert.equal(sourceIds[1], `entries:${entries.length}`);
assert.equal(sourceIds[3], 'increments:2');

const metadata = parseSessionSummarySourceIds(sourceIds);
assert.ok(metadata);
assert.equal(metadata?.entryCount, entries.length);
assert.equal(metadata?.digest, digestSessionSummaryEntries(entries));
assert.equal(metadata?.incrementalUpdates, 2);

const appendedEntries: SessionSummaryEntry[] = [
  ...entries,
  { role: 'user', text: 'Ship the recap summary feature.' },
];
assert.equal(
  isSessionSummaryCurrent(entries, metadata),
  true,
  'current metadata should match unchanged entries'
);
assert.equal(
  isSessionSummaryCurrent(appendedEntries, metadata),
  false,
  'metadata should be stale after new entries arrive'
);
assert.equal(
  isAppendOnlySessionSummaryUpdate(appendedEntries, metadata),
  true,
  'append-only updates should preserve the prior digest prefix'
);
assert.equal(
  isAppendOnlySessionSummaryUpdate(
    [{ role: 'user', text: 'Different conversation' }] satisfies SessionSummaryEntry[],
    metadata
  ),
  false,
  'non-append updates should not qualify for incremental refresh'
);

console.log('session summary: checks passed');
