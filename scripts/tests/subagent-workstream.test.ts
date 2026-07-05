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

console.log('subagent-workstream.test.ts passed');
