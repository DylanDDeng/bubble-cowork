import assert from 'node:assert/strict';
import { aggregateMessages } from '../../src/ui/utils/aggregated-messages';
import { deriveTranscriptTimelineItems } from '../../src/ui/utils/transcript-timeline';
import {
  createBatchWorkstreamModel,
  groupSubagentMessagesByParent,
  type ToolResultBlock,
  type WorkstreamEntry,
} from '../../src/ui/utils/workstream';
import { summarizeWorkstreamEntries } from '../../src/ui/utils/workstream-stages';
import { hasRunningToolInMessages } from '../../src/ui/utils/turn-utils';
import {
  endIndexAfterTopLevelCount,
  startIndexForTopLevelCount,
} from '../../src/electron/libs/history/page-boundaries';
import type { StreamMessage } from '../../src/shared/types';
import type { ToolStatus } from '../../src/ui/types';

type TaskEntry = Extract<WorkstreamEntry, { type: 'task' }>;

function taskToolUse(id: string, description: string, subagentType: string) {
  return {
    type: 'tool_use' as const,
    id,
    name: 'Task',
    input: {
      description,
      subagent_type: subagentType,
      prompt: `${description} — full instructions`,
    },
  };
}

// A turn where the main agent fans out two parallel Task subagents. Subagent
// messages carry parentToolUseId; top-level messages do not.
function buildFixtureMessages(): StreamMessage[] {
  return [
    { type: 'user_prompt', prompt: 'review this change', createdAt: 1_000 },
    {
      type: 'assistant',
      uuid: 'main-1',
      createdAt: 2_000,
      message: {
        content: [
          { type: 'text', text: 'Fanning out two reviewers.' },
          taskToolUse('task-1', 'Review diff for bugs', 'code-reviewer'),
          taskToolUse('task-2', 'Scan UI component usage', 'Explore'),
        ],
      },
    },
    // task-1 subagent activity
    {
      type: 'assistant',
      uuid: 'sub-1a',
      parentToolUseId: 'task-1',
      createdAt: 3_000,
      message: {
        content: [
          { type: 'tool_use', id: 'grep-1', name: 'Grep', input: { pattern: 'useAppStore' } },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'sub-1b',
      parentToolUseId: 'task-1',
      createdAt: 4_000,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'grep-1', content: '{"output": "12 matches"}' },
        ],
      },
    },
    {
      type: 'assistant',
      uuid: 'sub-1c',
      parentToolUseId: 'task-1',
      createdAt: 5_000,
      message: {
        content: [
          { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/repo/src/a.ts' } },
        ],
      },
    },
    {
      type: 'user',
      uuid: 'sub-1d',
      parentToolUseId: 'task-1',
      createdAt: 6_000,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'read-1', content: '{"output": "file body"}' },
        ],
      },
    },
    // task-2 subagent activity (still running: tool has no result yet)
    {
      type: 'assistant',
      uuid: 'sub-2a',
      parentToolUseId: 'task-2',
      createdAt: 3_500,
      message: {
        content: [
          { type: 'text', text: 'Scanning components now.' },
          { type: 'tool_use', id: 'glob-1', name: 'Glob', input: { pattern: '**/*.tsx' } },
        ],
      },
    },
    // task-1 resolves at the top level (no parentToolUseId on the result carrier)
    {
      type: 'user',
      uuid: 'main-2',
      createdAt: 7_000,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'task-1', content: '{"output": "Found 2 bugs"}' },
        ],
      },
    },
  ];
}

function buildToolMaps(finishedTaskIds: string[]): {
  toolStatusMap: Map<string, ToolStatus>;
  toolResultsMap: Map<string, ToolResultBlock>;
} {
  const toolStatusMap = new Map<string, ToolStatus>([
    ['task-1', 'pending'],
    ['task-2', 'pending'],
    ['grep-1', 'success'],
    ['read-1', 'success'],
    ['glob-1', 'pending'],
  ]);
  const toolResultsMap = new Map<string, ToolResultBlock>([
    [
      'grep-1',
      { type: 'tool_result', tool_use_id: 'grep-1', content: '{"output": "12 matches"}' },
    ],
    [
      'read-1',
      { type: 'tool_result', tool_use_id: 'read-1', content: '{"output": "file body"}' },
    ],
  ]);
  for (const taskId of finishedTaskIds) {
    toolStatusMap.set(taskId, 'success');
    toolResultsMap.set(taskId, {
      type: 'tool_result',
      tool_use_id: taskId,
      content: '{"output": "Found 2 bugs"}',
    });
  }
  return { toolStatusMap, toolResultsMap };
}

function collectTimelineMessages(items: ReturnType<typeof deriveTranscriptTimelineItems>) {
  const inline: StreamMessage[] = [];
  const grouped: StreamMessage[] = [];
  for (const item of items) {
    if (item.type === 'message') {
      inline.push(item.message);
      if (item.inlineWorkGroup) grouped.push(...item.inlineWorkGroup.messages);
    } else {
      grouped.push(...item.group.messages);
    }
  }
  return { inline, grouped };
}

// ── Subagent messages stay out of the top-level transcript ──────────────────

const messages = buildFixtureMessages();

{
  const items = deriveTranscriptTimelineItems(messages);
  const { inline, grouped } = collectTimelineMessages(items);
  for (const message of [...inline, ...grouped]) {
    assert.equal(
      Boolean((message as { parentToolUseId?: string | null }).parentToolUseId),
      false,
      'transcript timeline must not surface subagent messages inline'
    );
  }
  const groupedText = JSON.stringify(grouped);
  assert.equal(
    groupedText.includes('Scanning components now.'),
    false,
    'subagent narration must not leak into top-level work groups'
  );
}

{
  const items = aggregateMessages(messages);
  for (const item of items) {
    const carried =
      item.type === 'message' ? [item.message] : (item.messages as StreamMessage[]);
    for (const message of carried) {
      assert.equal(
        Boolean((message as { parentToolUseId?: string | null }).parentToolUseId),
        false,
        'aggregated messages must not surface subagent messages inline'
      );
    }
  }
}

// ── Grouping by parent Task id ───────────────────────────────────────────────

const byParent = groupSubagentMessagesByParent(messages);
assert.equal(byParent.size, 2, 'two Tasks should have grouped subagent messages');
assert.equal(byParent.get('task-1')?.length, 4, 'task-1 carries four subagent messages');
assert.equal(byParent.get('task-2')?.length, 1, 'task-2 carries one subagent message');

// ── Task entries carry a nested subagent trace ──────────────────────────────

const { toolStatusMap, toolResultsMap } = buildToolMaps(['task-1']);
const mainAssistant = messages[1] as StreamMessage & { type: 'assistant' };
const model = createBatchWorkstreamModel({
  messages: [mainAssistant],
  toolStatusMap,
  toolResultsMap,
  isSessionRunning: true,
  subagentMessagesByParent: byParent,
});

const taskEntries = model.entries.filter(
  (entry): entry is TaskEntry => entry.type === 'task'
);
assert.equal(taskEntries.length, 2, 'both Task calls become task entries');

const [finishedTask, runningTask] = taskEntries;
assert.equal(finishedTask.id, 'task-1');
assert.equal(finishedTask.status, 'success');
assert.ok(finishedTask.subagent, 'finished Task exposes its subagent trace');
assert.equal(finishedTask.subagent!.agentType, 'code-reviewer');
assert.equal(finishedTask.subagent!.description, 'Review diff for bugs');
assert.equal(
  finishedTask.subagent!.toolCount,
  2,
  'finished trace counts the Grep and Read calls'
);
assert.equal(finishedTask.subagent!.durationMs, 3_000, 'duration spans child messages');
const finishedChildIds = finishedTask.subagent!.entries.map((entry) => entry.id);
assert.deepEqual(finishedChildIds, ['grep-1', 'read-1']);

assert.equal(runningTask.id, 'task-2');
assert.equal(runningTask.status, 'pending');
assert.ok(runningTask.subagent, 'running Task exposes its subagent trace');
assert.equal(runningTask.subagent!.agentType, 'Explore');
assert.equal(runningTask.subagent!.startedAt, 3_500);
assert.equal(runningTask.subagent!.durationMs, undefined, 'no duration while running');
const runningChild = runningTask.subagent!.entries.find((entry) => entry.id === 'glob-1');
assert.ok(runningChild && runningChild.type === 'tool', 'running trace lists the Glob call');
assert.equal(
  runningChild.type === 'tool' ? runningChild.status : null,
  'pending',
  'unresolved subagent tool stays pending while the Task runs'
);

// ── Parallel Tasks group into a single task stage, even on failure ──────────

{
  const stages = summarizeWorkstreamEntries(model.entries);
  const taskStages = stages.filter((stage) => stage.kind === 'task');
  assert.equal(taskStages.length, 1, 'parallel Tasks merge into one task stage');
  assert.equal(taskStages[0].entries.length, 2);
}

{
  const failedEntries: WorkstreamEntry[] = [
    { ...finishedTask, status: 'error' },
    runningTask,
  ];
  const stages = summarizeWorkstreamEntries(failedEntries);
  assert.equal(stages.length, 1, 'a failed Task stays in the task stage');
  assert.equal(stages[0].kind, 'task');
  assert.equal(stages[0].status, 'error', 'stage status still reports the failure');
}

// ── All unresolved parallel Tasks stay pending while the session runs ───────
// Regression: the old fallback only kept the *last* unresolved tool pending,
// so with two Tasks in flight the first lane rendered as already done.

{
  const { toolStatusMap: bothPendingStatus } = buildToolMaps([]);
  const bothRunningModel = createBatchWorkstreamModel({
    messages: [mainAssistant],
    toolStatusMap: bothPendingStatus,
    toolResultsMap: new Map<string, ToolResultBlock>(),
    isSessionRunning: true,
    subagentMessagesByParent: byParent,
  });
  const bothRunningTasks = bothRunningModel.entries.filter(
    (entry): entry is TaskEntry => entry.type === 'task'
  );
  assert.equal(bothRunningTasks.length, 2);
  for (const entry of bothRunningTasks) {
    assert.equal(
      entry.status,
      'pending',
      `unresolved parallel Task ${entry.id} must stay pending while the session runs`
    );
    assert.equal(
      entry.subagent?.durationMs,
      undefined,
      `Task ${entry.id} must not report a duration while still running`
    );
  }
  const stages = summarizeWorkstreamEntries(bothRunningModel.entries);
  const taskStage = stages.find((stage) => stage.kind === 'task');
  assert.ok(taskStage, 'the parallel run still forms one task stage');
  assert.equal(taskStage!.entries.length, 2);
  assert.equal(
    taskStage!.status,
    'pending',
    'board status reflects 2 running / 0 done'
  );

  // Once the session stops, interrupted tools fall back to settled so stale
  // spinners do not linger in finished transcripts.
  const interruptedModel = createBatchWorkstreamModel({
    messages: [mainAssistant],
    toolStatusMap: buildToolMaps([]).toolStatusMap,
    toolResultsMap: new Map<string, ToolResultBlock>(),
    isSessionRunning: false,
  });
  for (const entry of interruptedModel.entries) {
    if (entry.type === 'task') {
      assert.equal(entry.status, 'success', 'interrupted Tasks settle when the session stops');
    }
  }
}

// ── Sequential Tasks never merge into a "parallel" board ────────────────────
// Only Tasks fanned out by the same assistant message share a stage.

{
  const sequentialAssistant = {
    type: 'assistant',
    uuid: 'main-3',
    createdAt: 8_000,
    message: {
      content: [taskToolUse('task-3', 'Verify the fixes', 'code-reviewer')],
    },
  } as StreamMessage & { type: 'assistant' };
  const { toolStatusMap: seqStatusMap, toolResultsMap: seqResultsMap } = buildToolMaps(['task-1']);
  seqStatusMap.set('task-3', 'pending');
  const sequentialModel = createBatchWorkstreamModel({
    messages: [mainAssistant, sequentialAssistant],
    toolStatusMap: seqStatusMap,
    toolResultsMap: seqResultsMap,
    isSessionRunning: true,
    subagentMessagesByParent: byParent,
  });
  const stages = summarizeWorkstreamEntries(sequentialModel.entries);
  const taskStages = stages.filter((stage) => stage.kind === 'task');
  assert.equal(
    taskStages.length,
    2,
    'Tasks from different assistant messages get separate stages'
  );
  assert.equal(taskStages[0].entries.length, 2, 'same-message fan-out still merges');
  assert.equal(taskStages[1].entries.length, 1, 'the sequential Task stands alone');
}

// ── Lowercase `task` tools become task entries too ──────────────────────────
// classifyToolUse normalizes case; the entry builder must match it so the
// subagent stage never drops a tool row it claimed.

{
  const lowercaseAssistant = {
    type: 'assistant',
    uuid: 'main-4',
    createdAt: 9_000,
    message: {
      content: [
        {
          type: 'tool_use' as const,
          id: 'task-lc',
          name: 'task',
          input: { description: 'Provider subagent', subagent_type: 'general' },
        },
      ],
    },
  } as StreamMessage & { type: 'assistant' };
  const lowercaseModel = createBatchWorkstreamModel({
    messages: [lowercaseAssistant],
    toolStatusMap: new Map<string, ToolStatus>([['task-lc', 'pending']]),
    toolResultsMap: new Map<string, ToolResultBlock>(),
    isSessionRunning: true,
  });
  const lowercaseEntry = lowercaseModel.entries.find((entry) => entry.id === 'task-lc');
  assert.ok(
    lowercaseEntry && lowercaseEntry.type === 'task',
    "a lowercase 'task' tool maps to a task entry, matching classifyStageKind"
  );
  const stages = summarizeWorkstreamEntries(lowercaseModel.entries);
  assert.equal(stages.length, 1);
  assert.equal(stages[0].kind, 'task');
  assert.equal(
    stages[0].entries.filter((entry) => entry.type === 'task').length,
    1,
    'the subagent stage keeps an entry to render'
  );
}

// ── Nested Tasks carry their own trace for the recursive lane renderer ──────

{
  const outerAssistant = {
    type: 'assistant',
    uuid: 'main-5',
    createdAt: 2_000,
    message: {
      content: [taskToolUse('task-outer', 'Outer task', 'general-purpose')],
    },
  } as StreamMessage & { type: 'assistant' };
  const nestedByParent = groupSubagentMessagesByParent([
    {
      type: 'assistant',
      uuid: 'sub-n1',
      parentToolUseId: 'task-outer',
      createdAt: 3_000,
      message: {
        content: [taskToolUse('task-inner', 'Nested explore', 'Explore')],
      },
    },
    {
      type: 'assistant',
      uuid: 'sub-n2',
      parentToolUseId: 'task-inner',
      createdAt: 3_200,
      message: {
        content: [
          { type: 'tool_use', id: 'grep-nested', name: 'Grep', input: { pattern: 'foo' } },
        ],
      },
    },
  ] as StreamMessage[]);
  const nestedModel = createBatchWorkstreamModel({
    messages: [outerAssistant],
    toolStatusMap: new Map<string, ToolStatus>([
      ['task-outer', 'pending'],
      ['task-inner', 'pending'],
      ['grep-nested', 'pending'],
    ]),
    toolResultsMap: new Map<string, ToolResultBlock>(),
    isSessionRunning: true,
    subagentMessagesByParent: nestedByParent,
  });
  const outerEntry = nestedModel.entries.find(
    (entry): entry is TaskEntry => entry.type === 'task'
  );
  assert.ok(outerEntry?.subagent, 'outer Task carries its trace');
  const innerEntry = outerEntry!.subagent!.entries.find(
    (entry): entry is TaskEntry => entry.type === 'task'
  );
  assert.ok(innerEntry, 'the nested Task appears inside the outer trace');
  assert.ok(
    innerEntry!.subagent,
    'the nested Task carries its own trace so the lane renderer can expand it'
  );
  assert.equal(innerEntry!.subagent!.entries[0]?.id, 'grep-nested');
}

// ── Stuck subagent tools never pin the turn indicator ───────────────────────

{
  const stuckSubagentMessage = {
    type: 'assistant',
    uuid: 'sub-stuck',
    parentToolUseId: 'task-9',
    createdAt: 1_000,
    message: {
      content: [
        { type: 'tool_use', id: 'stuck-1', name: 'Bash', input: { command: 'sleep 999' } },
      ],
    },
  } as StreamMessage;
  const stuckStatusMap = new Map<string, ToolStatus>([['stuck-1', 'pending']]);
  assert.equal(
    hasRunningToolInMessages([stuckSubagentMessage], stuckStatusMap),
    false,
    'a stuck subagent tool must not report the turn as tool_active'
  );
  const topLevelMessage = {
    ...(stuckSubagentMessage as object),
    parentToolUseId: null,
  } as StreamMessage;
  assert.equal(
    hasRunningToolInMessages([topLevelMessage], stuckStatusMap),
    true,
    'top-level pending tools still count as running'
  );
}

// ── Old histories (no parent info) keep working ─────────────────────────────

{
  const legacyModel = createBatchWorkstreamModel({
    messages: [mainAssistant],
    toolStatusMap,
    toolResultsMap,
    isSessionRunning: false,
  });
  const legacyTasks = legacyModel.entries.filter(
    (entry): entry is TaskEntry => entry.type === 'task'
  );
  assert.equal(legacyTasks.length, 2);
  for (const entry of legacyTasks) {
    assert.equal(entry.subagent, undefined, 'no trace is attached without parent data');
  }
}

// ── History pages budget only top-level rows ─────────────────────────────────
// Hidden subagent messages ride along with their slice instead of consuming
// the page limit, so a chatty Task can't push the visible prompt/Task row out
// of a reopened session's first page.

{
  const topLevel = { parentToolUseId: null };
  const parented = { parentToolUseId: 'task-1' };
  // [prompt, task assistant, 6 subagent internals, task result]
  const rows = [topLevel, topLevel, ...Array.from({ length: 6 }, () => parented), topLevel];

  assert.equal(
    startIndexForTopLevelCount(rows, rows.length, 2),
    1,
    'a 2-message page starts at the Task-launching message, children ride along'
  );
  assert.equal(
    startIndexForTopLevelCount(rows, rows.length, 100),
    0,
    'a large budget returns the whole history even when children outnumber it'
  );
  assert.equal(
    startIndexForTopLevelCount(rows, 1, 1),
    0,
    'loadBefore from the Task message pages back to the prompt'
  );
  assert.equal(
    endIndexAfterTopLevelCount(rows, 2, 0),
    8,
    "an anchor's trailing subagent children ride along with it"
  );
  assert.equal(
    endIndexAfterTopLevelCount(rows, 2, 1),
    rows.length,
    'one top-level message after the anchor reaches the end of history'
  );

  // The regression this guards: with 6 hidden rows and a raw budget of 4,
  // index-based slicing would have started inside the subagent internals and
  // dropped both visible rows before the result.
  const start = startIndexForTopLevelCount(rows, rows.length, 3);
  assert.equal(start, 0, 'three top-level rows span the whole fixture');
}

console.log('subagent-workstream.test.ts passed');
