import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildTurnChangeContext } from '../../src/ui/utils/turn-change-records';
import { summarizeWorkstreamEntries } from '../../src/ui/utils/workstream-stages';
import type { WorkstreamEntry } from '../../src/ui/utils/workstream';
import type { StreamMessage } from '../../src/shared/types';
const require = createRequire(import.meta.url);
const { editTraceFixture } = require('./codex-edit-trace.fixture.cjs');
const messages: StreamMessage[] = JSON.parse(JSON.stringify(editTraceFixture()));
const context = buildTurnChangeContext(messages);
const first = context.changeRecordsByToolUseId.get('edit-one')!;
assert.equal(first.length, 1);
assert.equal(first[0].filePath, '/project/src/example.ts');
assert.equal(first[0].addedLines, 1);
assert.equal(first[0].removedLines, 1);
assert.match(first[0].diffContent!, /toolName: string/);
const second = context.changeRecordsByToolUseId.get('edit-two')!;
assert.equal(second.length, 3, 'completion supplies all files even when start was empty');
assert.deepEqual(second.map(r => r.operation), ['write', 'delete', 'renamed']);
assert.equal(second[2].filePath, '/project/src/after.ts');
assert.equal(context.changeRecordsByToolUseId.has('edit-failed'), false, 'failed patch is not presented as an applied change');
const blocks = messages.flatMap((m: any) => m.message?.content || []);
assert.equal(blocks.filter((b: any) => b.type === 'tool_use' && b.id === 'edit-one').length, 1, 'start/completion do not duplicate the edit');
const entries: WorkstreamEntry[] = blocks.filter((b: any) => b.type === 'tool_use' && b.id !== 'edit-failed').map((block: any) => ({
  id: block.id, type: 'tool', toolName: block.name, block, kind: 'file_change', status: 'success', summary: 'Edited',
  result: blocks.find((b: any) => b.type === 'tool_result' && b.tool_use_id === block.id),
}));
const stages = summarizeWorkstreamEntries(entries, context);
assert.equal(stages.length, 2, 'each edit call retains its own inline patch');
assert.equal(stages[0].title, 'Edited example.ts');
assert.equal(stages[1].title, 'Edited 3 files');
console.log('codex-edit-trace: protocol, persistence roundtrip, file records and stages passed');
