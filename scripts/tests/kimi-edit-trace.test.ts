import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTurnChangeContext } from '../../src/ui/utils/turn-change-records';
import { parseUnifiedDiff } from '../../src/ui/utils/unified-diff';
import type { StreamMessage } from '../../src/shared/types';

// Observed Kimi history format, with the local path and tool ID anonymized.
const messages: StreamMessage[] = JSON.parse(readFileSync(new URL('./fixtures/kimi-edit-trace.json', import.meta.url), 'utf8'));
const record = buildTurnChangeContext(messages).changeRecordsByToolUseId.get('kimi-edit')![0];
assert.equal(record.addedLines, 1);
assert.equal(record.removedLines, 1);
const lines = parseUnifiedDiff(record.diffContent!).flatMap(hunk => hunk.lines);
assert.equal(lines.find(line => line.type === 'addition')?.newLineNumber, 7, 'use actual file position from the result');
assert.equal(lines.find(line => line.type === 'deletion')?.oldLineNumber, 7);
assert.match(record.diffContent!, /Claude · Claude 个人介绍页/);

const pending = buildTurnChangeContext(messages.slice(0, 1)).changeRecordsByToolUseId.get('kimi-edit')![0];
assert.equal(pending.addedLines, 1, 'edits[] produces a preview even before the result');
assert.equal(pending.removedLines, 1);
assert.equal(pending.state, 'pending');

function edit(input: Record<string, unknown>, content = 'Done', is_error = false) {
  return buildTurnChangeContext([
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'test', name: 'Edit', input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'test', content, is_error }] } },
  ] as StreamMessage[]).changeRecordsByToolUseId.get('test');
}
const multi = edit({ path: '/project/file.txt', edits: [
  { oldText: 'remove me', newText: '' },
  { oldText: '', newText: 'insert me' },
  { oldText: 'before', newText: 'after' },
] })![0];
assert.equal(multi.addedLines, 2);
assert.equal(multi.removedLines, 2);
assert.equal(parseUnifiedDiff(multi.diffContent!).length, 3, 'each replacement survives');
assert.equal(edit({ path: '/project/file.txt', old_string: 'x', new_string: '' })![0].removedLines, 1);
assert.equal(edit({ path: '/project/file.txt', edits: [{oldText:'x',newText:'y'}] }, 'Failed', true), undefined);
const toolResult = (messages[1] as any).message.content[0].content;
assert.equal(edit({}, toolResult)![0].filePath, '/project/index.html', 'plain Index patch can supply the path');
assert.equal(edit({ path:'/project/index.html' }, JSON.stringify({output:toolResult}))![0].addedLines, 1, 'JSON output envelope also works');
assert.equal(edit({path:'/project/index.html'}, 'Edited file successfully')![0].diffContent, null, 'do not invent a patch from status text');
console.log('kimi-edit-trace: observed history, line positions, edits arrays and empty replacements passed');
