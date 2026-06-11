import assert from 'node:assert/strict';
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
