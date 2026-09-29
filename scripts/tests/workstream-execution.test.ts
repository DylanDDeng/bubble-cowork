import type { ToolStatus } from '../../src/ui/types';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createBatchWorkstreamModel } from '../../src/ui/utils/workstream';
import { normalizeToolResultBlock } from '../../src/ui/utils/message-content';
import { getWorkstreamDeniedActionIds, summarizeWorkstreamEntries } from '../../src/ui/utils/workstream-stages';
import type { StreamMessage, ContentBlock } from '../../src/shared/types';
const require = createRequire(import.meta.url);
const { CodexAppServerManager } = require('../../dist-electron/electron/libs/provider/codex-app-server-manager');
const { CodexAdapter } = require('../../dist-electron/electron/libs/provider/codex-adapter');
const manager = new CodexAppServerManager('/nonexistent-trace-test');
manager.generation = 1;
manager.sessions.set('trace-test', { threadId: 'trace-test', providerThreadId: 'native', generation: 1, cwd: '/tmp', status: 'ready' });
const adapter = new CodexAdapter('/nonexistent-trace-test', { managerFactory: () => manager });
adapter.runtimeManagers.set('trace-test', manager);
adapter.setupEventForwarding(manager, 'trace-test');
const messages: StreamMessage[] = [];
adapter.events.on('event', (event: any) => { if (event.type === 'message') messages.push(event.message); });
const notify = (method: string, item: Record<string, unknown>) => manager.handleNotification({ method, params: { threadId: 'native', item } });
for (const [id, status, exitCode] of [['ok', 'completed', 0], ['failed', 'completed', 2], ['stopped', 'interrupted', null], ['denied', 'declined', null]] as const) {
  notify('item/started', { id, type: 'commandExecution', command: 'npm test', startedAtMs: 1000, status: 'inProgress' });
  notify('item/completed', { id, type: 'commandExecution', command: 'npm test', completedAtMs: 4500, durationMs: 3500, status, exitCode,
    aggregatedOutput: `actual stdout ${id}`, background: id === 'ok',
    ...(id === 'denied' ? { automaticApprovalReviews: [{ id: 'review-1', status: 'denied', reason: 'Outside selected directory' }] } : {}),
  });
}
// Exercise the actual adapter -> JSON transcript -> normalizer -> workstream path.
const saved: StreamMessage[] = JSON.parse(JSON.stringify(messages));
const uses = saved.filter((m): m is StreamMessage & { type: 'assistant' } => m.type === 'assistant');
const results = new Map<string, Extract<ContentBlock, { type: 'tool_result' }>>();
const statuses = new Map<string, ToolStatus>();
for (const message of saved) {
  if (message.type !== 'user') continue;
  for (const block of message.message.content) {
    const result = normalizeToolResultBlock(block);
    if (result) { results.set(result.tool_use_id, result); statuses.set(result.tool_use_id, result.is_error ? 'error' : 'success'); }
  }
}
const model = createBatchWorkstreamModel({ messages: uses, toolResultsMap: results, toolStatusMap: statuses, isSessionRunning: false });
const stages = summarizeWorkstreamEntries(model.entries);
assert.equal(stages.length, 4, 'each command retains an independent disclosure');
const ok = stages[0].commands[0];
assert.equal(ok.output, 'actual stdout ok', 'native aggregatedOutput must not disappear into Done');
assert.equal(ok.execution?.durationMs, 3500);
assert.equal(ok.execution?.startedAt, 1000);
assert.equal(ok.execution?.completedAt, 4500);
assert.equal(ok.execution?.exitCode, 0);
assert.match(stages[0].title, /^Finished background command/);
assert.equal(stages[1].status, 'error', 'nonzero exit code is an error even if native lifecycle says completed');
assert.equal(stages[2].status, 'interrupted', 'interrupted native result never becomes success');
assert.match(stages[2].title, /^Stopped/);
assert.match(stages[3].title, /^Denied/);
assert.deepEqual(model.entries.flatMap(getWorkstreamDeniedActionIds), ['review-1']);
console.log('workstream execution: native events, persisted metadata, independent commands, interruption and denial passed');
