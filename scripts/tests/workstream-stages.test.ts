import assert from 'node:assert/strict';
import { extractUnifiedDiffFilePath } from '../../src/shared/unified-diff';
import { buildTurnChangeContext } from '../../src/ui/utils/turn-change-records';
import {
  formatWorkstreamStageSummary,
  getStageChangeRecords,
  summarizeWorkstreamEntries,
} from '../../src/ui/utils/workstream-stages';
import type { StreamMessage } from '../../src/shared/types';
import type { WorkstreamEntry } from '../../src/ui/utils/workstream';

type ToolishEntry = Extract<WorkstreamEntry, { type: 'tool' | 'task' | 'memory' }>;

function toolEntry(
  id: string,
  name: string,
  kind: ToolishEntry['kind'],
  summary: string,
  input: Record<string, unknown>,
  status: ToolishEntry['status'] = 'success',
  resultContent = '{"output": ""}'
): ToolishEntry {
  return {
    id,
    type: 'tool',
    toolName: name,
    kind,
    summary,
    status,
    block: {
      type: 'tool_use',
      id,
      name,
      input,
    },
    result: {
      type: 'tool_result',
      tool_use_id: id,
      content: resultContent,
    },
  };
}

function buildMessagesForStructuredChanges(): StreamMessage[] {
  return [
    { type: 'user_prompt', prompt: 'change files' },
    {
      type: 'assistant',
      uuid: 'assistant-1',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'edit-1',
            name: 'Edit',
            input: {
              changes: {
                'src/a.ts': {
                  type: 'update',
                  old_content: 'const a = 1;',
                  new_content: 'const a = 2;',
                },
                'src/b.ts': {
                  type: 'create',
                  content: 'export const b = 1;',
                },
              },
            },
          },
          {
            type: 'tool_result',
            tool_use_id: 'edit-1',
            content: '{"output": "ok"}',
          },
        ],
      },
    },
  ];
}

const changeContext = buildTurnChangeContext(buildMessagesForStructuredChanges());
assert.equal(
  changeContext.changeRecordsByToolUseId.get('edit-1')?.length,
  2,
  'toolUseId must retain all change records'
);
assert.ok(
  changeContext.changeRecordByToolUseId.get('edit-1'),
  'legacy one-record lookup must remain available'
);

const extendedChangeContext = buildTurnChangeContext([
  {
    type: 'assistant',
    uuid: 'assistant-2',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'multi-1',
          name: 'MultiEdit',
          input: {
            file_path: 'src/multi.ts',
            edits: [{ old_string: 'one', new_string: 'two' }],
          },
        },
        {
          type: 'tool_result',
          tool_use_id: 'multi-1',
          content: '{"output": "ok"}',
        },
        {
          type: 'tool_use',
          id: 'notebook-1',
          name: 'NotebookEdit',
          input: {
            notebook_path: 'analysis.ipynb',
            old_source: 'print(1)',
            new_source: 'print(2)',
          },
        },
        {
          type: 'tool_result',
          tool_use_id: 'notebook-1',
          content: '{"output": "ok"}',
        },
      ],
    },
  },
]);

assert.equal(
  extendedChangeContext.changeRecordsByToolUseId.get('multi-1')?.[0]?.filePath,
  'src/multi.ts',
  'MultiEdit should produce a file change record'
);
assert.equal(
  extendedChangeContext.changeRecordsByToolUseId.get('notebook-1')?.[0]?.filePath,
  'analysis.ipynb',
  'NotebookEdit should produce a file change record'
);

const normalizedToolContext = buildTurnChangeContext([
  {
    type: 'assistant',
    uuid: 'assistant-3',
    message: {
      content: [
        {
          type: 'mcp_tool_use',
          id: 'mcp-edit-1',
          name: 'Edit',
          input: {
            file_path: 'src/mcp.ts',
            old_string: 'before',
            new_string: 'after',
          },
        },
        {
          type: 'mcp_tool_result',
          tool_use_id: 'mcp-edit-1',
          content: '{"output": "ok"}',
        },
      ] as StreamMessage extends { type: 'assistant'; message: { content: infer Blocks } } ? Blocks : never,
    },
  },
]);

assert.equal(
  normalizedToolContext.changeRecordsByToolUseId.get('mcp-edit-1')?.[0]?.filePath,
  'src/mcp.ts',
  'normalized MCP tool blocks should produce file change records'
);

const authoritativePatch = `diff --git a/src/changed.ts b/src/changed.ts
index 1111111..2222222 100644
--- a/src/changed.ts
+++ b/src/changed.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
diff --git a/src/created.ts b/src/created.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/created.ts
@@ -0,0 +1 @@
+export const created = true;
diff --git a/src/deleted.ts b/src/deleted.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/deleted.ts
+++ /dev/null
@@ -1 +0,0 @@
-export const deleted = true;
`;

const patchBackedContext = buildTurnChangeContext([
  { type: 'user_prompt', prompt: 'apply a multi-file patch' },
  {
    type: 'assistant',
    uuid: 'assistant-patch',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'false-redirection',
          name: 'Bash',
          input: { command: 'sed -n "1,20p" README.md >/dev/null"' },
        },
        {
          type: 'tool_result',
          tool_use_id: 'false-redirection',
          content: '{"output": ""}',
        },
      ],
    },
  },
  {
    type: 'system',
    subtype: 'turn_changes',
    uuid: 'turn-patch',
    session_id: 'session-patch',
    turnChanges: { patch: authoritativePatch, truncated: false },
  },
]);

assert.equal(patchBackedContext.turns.length, 1);
assert.equal(
  patchBackedContext.turns[0].totalFiles,
  3,
  'completed turn cards must count paths from the Git snapshot'
);
assert.deepEqual(
  patchBackedContext.turns[0].records.map((record) => [record.filePath, record.status]),
  [
    ['src/changed.ts', 'M'],
    ['src/created.ts', 'A'],
    ['src/deleted.ts', 'D'],
  ],
  'Git snapshot records must preserve real paths and create/delete status'
);
assert.equal(
  patchBackedContext.turns[0].records.some((record) => record.filePath.includes('/dev/null')),
  false,
  '/dev/null sentinels and quoted shell redirections must never appear as files'
);
assert.equal(
  patchBackedContext.changeRecordsByToolUseId.has('false-redirection'),
  false,
  'shell redirections to a quoted /dev/null sentinel must not create tool change records'
);

const truncatedPatchContext = buildTurnChangeContext([
  { type: 'user_prompt', prompt: 'change more files than the patch snapshot can hold' },
  {
    type: 'assistant',
    uuid: 'assistant-truncated-patch',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'truncated-edit-a',
          name: 'Edit',
          input: {
            file_path: 'src/complete-a.ts',
            old_string: 'a',
            new_string: 'A',
          },
        },
        {
          type: 'tool_result',
          tool_use_id: 'truncated-edit-a',
          content: '{"output": "ok"}',
        },
        {
          type: 'tool_use',
          id: 'truncated-edit-b',
          name: 'Edit',
          input: {
            file_path: 'src/complete-b.ts',
            old_string: 'b',
            new_string: 'B',
          },
        },
        {
          type: 'tool_result',
          tool_use_id: 'truncated-edit-b',
          content: '{"output": "ok"}',
        },
      ],
    },
  },
  {
    type: 'system',
    subtype: 'turn_changes',
    uuid: 'turn-truncated-patch',
    session_id: 'session-truncated-patch',
    turnChanges: {
      patch: authoritativePatch.split('diff --git a/src/created.ts')[0],
      truncated: true,
    },
  },
]);

assert.deepEqual(
  truncatedPatchContext.turns[0].records.map((record) => record.filePath),
  ['src/complete-a.ts', 'src/complete-b.ts'],
  'a truncated Git snapshot must fall back to the complete tool record list'
);

const quotedPathPatch = `diff --git "a/scripts/run me.sh" "b/scripts/run moved.sh"
similarity index 100%
rename from scripts/run me.sh
rename to scripts/run moved.sh
diff --git "a/scripts/keep mode.sh" "b/scripts/keep mode.sh"
old mode 100644
new mode 100755
`;
const quotedPathContext = buildTurnChangeContext([
  { type: 'user_prompt', prompt: 'rename a script and update another script mode' },
  {
    type: 'system',
    subtype: 'turn_changes',
    uuid: 'turn-quoted-path',
    session_id: 'session-quoted-path',
    turnChanges: { patch: quotedPathPatch, truncated: false },
  },
]);

assert.deepEqual(
  quotedPathContext.turns[0].records.map((record) => [record.filePath, record.status]),
  [
    ['scripts/run moved.sh', 'R'],
    ['scripts/keep mode.sh', 'M'],
  ],
  'pure renames and quoted mode-only paths must be recovered from Git headers'
);

const octalQuotedPathContext = buildTurnChangeContext([
  { type: 'user_prompt', prompt: 'change a non-ASCII file' },
  {
    type: 'system',
    subtype: 'turn_changes',
    uuid: 'turn-octal-path',
    session_id: 'session-octal-path',
    turnChanges: {
      patch: 'diff --git "a/src/und\\303\\244rst.ts" "b/src/und\\303\\244rst.ts"\nold mode 100644\nnew mode 100755\n',
      truncated: false,
    },
  },
]);

assert.equal(
  octalQuotedPathContext.turns[0].records[0]?.filePath,
  'src/undärst.ts',
  'Git octal escapes in quoted non-ASCII paths must decode as UTF-8 bytes'
);
assert.equal(
  extractUnifiedDiffFilePath('Index: a/actual-prefix.ts\n==================================================================='),
  'a/actual-prefix.ts',
  'Index paths must not lose a real leading a/ directory'
);

const alternateToolContext = buildTurnChangeContext([
  { type: 'user_prompt', prompt: 'change files with Codex tools' },
  {
    type: 'assistant',
    uuid: 'assistant-alternate-tools',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'apply-patch-1',
          name: 'apply_patch',
          input: {
            changes: {
              'src/applied.ts': {
                type: 'create',
                content: 'export const applied = true;',
              },
            },
          },
        },
        {
          type: 'tool_result',
          tool_use_id: 'apply-patch-1',
          content: '{"output": "ok"}',
        },
        {
          type: 'tool_use',
          id: 'exec-command-1',
          name: 'exec_command',
          input: { cmd: 'touch src/executed.ts' },
        },
        {
          type: 'tool_result',
          tool_use_id: 'exec-command-1',
          content: '{"output": "ok"}',
        },
      ],
    },
  },
]);

assert.deepEqual(
  alternateToolContext.turns[0].records.map((record) => record.filePath),
  ['src/applied.ts', 'src/executed.ts'],
  'apply_patch and exec_command must produce fallback file records'
);

const subagentOwnedContext = buildTurnChangeContext([
  { type: 'user_prompt', prompt: 'change a main-agent and subagent file' },
  {
    type: 'assistant',
    uuid: 'assistant-main-owner',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'main-owner-edit',
          name: 'Edit',
          input: {
            file_path: 'src/main-owned.ts',
            old_string: 'before',
            new_string: 'after',
          },
        },
        {
          type: 'tool_result',
          tool_use_id: 'main-owner-edit',
          content: '{"output": "ok"}',
        },
      ],
    },
  },
  {
    type: 'assistant',
    uuid: 'assistant-subagent-owner',
    parentToolUseId: 'subagent-task-1',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'subagent-owner-edit',
          name: 'Edit',
          input: {
            file_path: 'src/subagent-owned.ts',
            old_string: 'before',
            new_string: 'after',
          },
        },
        {
          type: 'tool_result',
          tool_use_id: 'subagent-owner-edit',
          content: '{"output": "ok"}',
        },
      ],
    },
  },
  {
    type: 'system',
    subtype: 'turn_changes',
    uuid: 'turn-mixed-ownership',
    session_id: 'session-mixed-ownership',
    turnChanges: {
      patch: authoritativePatch.replaceAll('src/changed.ts', 'src/subagent-owned.ts'),
      truncated: false,
    },
  },
]);

assert.deepEqual(
  subagentOwnedContext.turns[0].records.map((record) => record.filePath),
  ['src/main-owned.ts'],
  'a main turn card must not absorb subagent-owned files from the Git snapshot'
);

const editStages = summarizeWorkstreamEntries(
  [
    toolEntry('edit-1', 'Edit', 'file_change', 'Edited files', {
      changes: {
        'src/a.ts': {},
        'src/b.ts': {},
      },
    }),
  ],
  { changeRecordsByToolUseId: changeContext.changeRecordsByToolUseId }
);

assert.equal(editStages.length, 1, 'single edit tool should produce one edit stage');
assert.equal(editStages[0].kind, 'edit');
assert.equal(editStages[0].title, 'Edited 2 files');
assert.equal(editStages[0].files.length, 2, 'edit stage must list every changed file');
assert.equal(getStageChangeRecords(editStages[0]).length, 2, 'edit stage must expose diff records');
assert.ok(editStages[0].addedLines > 0, 'edit stage must aggregate added lines');

const exploreAndCommandStages = summarizeWorkstreamEntries(
  [
    {
      id: 'thinking-1',
      type: 'thinking',
      summary: 'The user is asking what this project does',
      detail: 'The user is asking what this project does',
      state: 'completed',
    },
    toolEntry('read-1', 'Read', 'file_read', 'Read workstream.ts', {
      file_path: 'src/ui/utils/workstream.ts',
    }),
    toolEntry('grep-1', 'Grep', 'pattern_search', 'Searched for Workstream', {
      pattern: 'Workstream',
    }),
    toolEntry('cmd-1', 'Bash', 'command_execution', 'Ran npm run build', {
      command: 'npm run build',
    }),
  ],
  { changeRecordsByToolUseId: changeContext.changeRecordsByToolUseId }
);

assert.equal(exploreAndCommandStages.length, 2, 'explore entries should merge but command should remain separate');
assert.equal(
  exploreAndCommandStages.some((stage) => stage.title.includes('The user is asking')),
  false,
  'thinking entries must not render as workstream stages'
);
assert.equal(exploreAndCommandStages[0].kind, 'explore');
assert.equal(exploreAndCommandStages[0].title, 'Explored 1 file');
assert.equal(exploreAndCommandStages[1].kind, 'command');
assert.equal(exploreAndCommandStages[1].title, 'Ran npm run build');
assert.equal(exploreAndCommandStages[1].commands[0].outputSummary, 'No output');

const separatedStages = summarizeWorkstreamEntries([
  toolEntry('cmd-2', 'Bash', 'command_execution', 'Ran npm test', {
    command: 'npm test',
  }),
  toolEntry(
    'cmd-3',
    'Bash',
    'command_execution',
    'Ran npm run lint',
    { command: 'npm run lint' },
    'error',
    '{"output": "lint failed"}'
  ),
  {
    id: 'approval-1',
    type: 'approval',
    summary: 'Waiting for permission',
    state: 'waiting',
  },
]);

assert.equal(separatedStages.length, 3, 'error and approval stages must not be swallowed');
assert.equal(separatedStages[1].kind, 'error');
assert.equal(separatedStages[1].defaultExpanded, true);
assert.equal(separatedStages[2].kind, 'approval');
assert.equal(separatedStages[2].status, 'waiting');
assert.equal(separatedStages[2].defaultExpanded, true);

const pendingStageBeforeAppend = summarizeWorkstreamEntries([
  toolEntry(
    'cmd-pending-1',
    'Bash',
    'command_execution',
    'Running npm test',
    { command: 'npm test' },
    'pending'
  ),
]);
const pendingStageAfterAppend = summarizeWorkstreamEntries([
  toolEntry(
    'cmd-pending-1',
    'Bash',
    'command_execution',
    'Running npm test',
    { command: 'npm test' },
    'pending'
  ),
  toolEntry('cmd-success-2', 'Bash', 'command_execution', 'Ran node smoke.js', {
    command: 'node smoke.js',
  }),
]);

assert.equal(pendingStageBeforeAppend[0].status, 'pending');
assert.equal(
  pendingStageBeforeAppend[0].id,
  pendingStageAfterAppend[0].id,
  'stage id should stay stable while adjacent streaming entries append'
);

const summary = formatWorkstreamStageSummary([
  ...editStages,
  ...exploreAndCommandStages,
]);
assert.equal(
  summary,
  'edited 2 files · ran 1 command · explored 1 file',
  'collapsed workstream summary should surface high-signal activity'
);

console.log('workstream stage verification passed');
