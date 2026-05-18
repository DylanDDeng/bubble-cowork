import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AegisBuiltinAgentCore } from '../dist-electron/electron/libs/builtin-agent/agent.js';
import { BuiltinExecutionGovernor } from '../dist-electron/electron/libs/builtin-agent/governance/execution-governor.js';
import { createBashTool } from '../dist-electron/electron/libs/builtin-agent/tools/bash.js';
import { createEditTool } from '../dist-electron/electron/libs/builtin-agent/tools/edit.js';
import { createPatchTool } from '../dist-electron/electron/libs/builtin-agent/tools/patch.js';
import { createReadTool } from '../dist-electron/electron/libs/builtin-agent/tools/read.js';
import { createWriteTool } from '../dist-electron/electron/libs/builtin-agent/tools/write.js';

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-agent-check-'));
const abortController = new AbortController();
const approval = {
  requestCommand: async () => ({ behavior: 'allow' }),
  requestFileChange: async () => ({ behavior: 'allow' }),
};
const children = new Set();
const ctx = {
  cwd,
  abortSignal: abortController.signal,
  toolCall: { id: 'tool-check', name: 'check' },
};

const write = createWriteTool(cwd, approval);
const writeResult = await write.execute({ path: 'new.txt', content: 'alpha\nbeta\n' }, ctx);
assert.equal(writeResult.status, 'success');
assert.match(writeResult.metadata.diff, /\+alpha/);
assert.equal(writeResult.metadata.addedLines, 2);

const duplicateWrite = await write.execute({ path: 'new.txt', content: 'again\n' }, ctx);
assert.equal(duplicateWrite.status, 'command_error');

const read = createReadTool(cwd);
const firstRead = await read.execute({ path: 'new.txt' }, ctx);
const secondRead = await read.execute({ path: 'new.txt' }, ctx);
assert.match(firstRead.content, /alpha/);
assert.equal(secondRead.metadata.repeated, true);

fs.writeFileSync(path.join(cwd, 'normalize.txt'), 'hello\u00a0world  \nquote \u201cx\u201d\n', 'utf8');
const edit = createEditTool(cwd, approval);
const editResult = await edit.execute({
  path: 'normalize.txt',
  oldText: 'hello world\nquote "x"\n',
  newText: 'done\n',
}, ctx);
assert.equal(editResult.status, 'success');
assert.equal(fs.readFileSync(path.join(cwd, 'normalize.txt'), 'utf8'), 'done\n');

const patch = createPatchTool(cwd, approval);
const patchResult = await patch.execute({
  diff: [
    '--- a/new.txt',
    '+++ b/new.txt',
    '@@ -1,2 +1,2 @@',
    ' alpha',
    '-beta',
    '+gamma',
    '',
  ].join('\n'),
}, ctx);
assert.equal(patchResult.status, 'success');
assert.equal(fs.readFileSync(path.join(cwd, 'new.txt'), 'utf8'), 'alpha\ngamma\n');

const bash = createBashTool(cwd, approval, children);
const dangerous = await bash.execute({ command: 'rm -rf /' }, ctx);
assert.equal(dangerous.status, 'blocked');
assert.equal(dangerous.metadata.kind, 'security');
const sedRead = await bash.execute({ command: "sed -n '1,1p' new.txt" }, ctx);
assert.equal(sedRead.status, 'success');
assert.equal(sedRead.metadata.kind, 'read');
assert.equal(typeof sedRead.metadata.readSignature, 'string');

const governor = new BuiltinExecutionGovernor('implementation');
governor.beforeToolCall('read', { path: 'new.txt', offset: 1, limit: 10 });
governor.afterToolResult('read', { path: 'new.txt', offset: 1, limit: 10 }, {
  content: 'alpha',
  status: 'success',
  metadata: { kind: 'read', path: 'new.txt' },
});
governor.beforeToolCall('read', { path: 'new.txt', offset: 1, limit: 10 });
assert.equal(governor.consumePendingReminders().some((item) => item.includes('exact file range was already read')), true);

let completeCalls = 0;
const toolResults = [];
const core = new AegisBuiltinAgentCore({
  cwd,
  tools: [{
    name: 'needs_arg',
    description: 'test tool',
    parameters: { type: 'object', properties: { foo: { type: 'string' } }, required: ['foo'] },
    execute: async () => {
      throw new Error('tool should not run');
    },
  }],
  complete: async () => {
    completeCalls += 1;
    if (completeCalls === 1) {
      return {
        content: '',
        reasoning: '',
        toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'needs_arg', arguments: '{}' } }],
      };
    }
    return { content: 'done', reasoning: '', toolCalls: [] };
  },
  callbacks: {
    onText: () => undefined,
    onStreamStop: () => undefined,
    onAssistantMessage: () => undefined,
    onToolResult: (_id, content, isError, metadata) => toolResults.push({ content, isError, metadata }),
  },
  signal: abortController.signal,
  getSystemPrompt: () => 'system',
  getPermissionMode: () => 'default',
});
await core.runTurn('implement this');
assert.equal(toolResults[0].isError, true);
assert.equal(toolResults[0].metadata.reason, 'missing_required_args');

console.log('builtin agent checks passed');
