// Regression: a streaming assistant turn emits preamble text BEFORE its tool
// calls. Mid-stream the tools are committed as content blocks while the
// preamble is still in the live partial buffer. The preamble must render ABOVE
// those tools (matching the committed/final order) so it doesn't sit below the
// tools during streaming and then jump up once the text block lands.
import assert from 'node:assert/strict';
import {
  createBatchWorkstreamModel,
  type ToolResultBlock,
} from '../../src/ui/utils/workstream';
import type { StreamMessage } from '../../src/shared/types';
import type { ToolStatus } from '../../src/ui/types';

function asstWithTools(...names: string[]): StreamMessage {
  return {
    type: 'assistant',
    uuid: 'a1',
    message: {
      content: names.map((name, i) => ({
        type: 'tool_use' as const,
        id: `${name}-${i}`,
        name,
        input: {},
      })),
    },
  } as StreamMessage;
}

function asstTextThenTools(text: string, ...names: string[]): StreamMessage {
  return {
    type: 'assistant',
    uuid: 'a1',
    message: {
      content: [
        { type: 'text' as const, text },
        ...names.map((name, i) => ({
          type: 'tool_use' as const,
          id: `${name}-${i}`,
          name,
          input: {},
        })),
      ],
    },
  } as StreamMessage;
}

function resultMap(...ids: string[]): Map<string, ToolResultBlock> {
  return new Map(
    ids.map((id) => [id, { type: 'tool_result', tool_use_id: id, content: '{"output":""}' }])
  );
}

function statusMap(...ids: string[]): Map<string, ToolStatus> {
  return new Map(ids.map((id) => [id, 'success' as ToolStatus]));
}

function order(model: ReturnType<typeof createBatchWorkstreamModel>): string[] {
  return model.entries.map((e) => {
    if (e.type === 'note') return `note:${e.summary}`;
    if (e.type === 'tool') return `tool:${e.toolName}`;
    if (e.type === 'thinking') return 'think';
    return e.type;
  });
}

const PREAMBLE = '看一下项目目录结构。';
const EMPTY_RESULTS = new Map<string, ToolResultBlock>();
const EMPTY_STATUS = new Map<string, ToolStatus>();

// CASE A — preamble: committed message has only tool_use blocks (text still in
// the live partial buffer), tools pending → preamble must render ABOVE tools.
{
  const o = order(
    createBatchWorkstreamModel({
      messages: [asstWithTools('LS', 'Glob')] as any,
      toolStatusMap: EMPTY_STATUS,
      toolResultsMap: EMPTY_RESULTS,
      isSessionRunning: true,
      liveTrace: { partialText: PREAMBLE },
    })
  );
  const noteIdx = o.findIndex((x) => x.startsWith('note'));
  const firstToolIdx = o.findIndex((x) => x.startsWith('tool'));
  assert.ok(
    noteIdx >= 0 && noteIdx < firstToolIdx,
    `case A: preamble must be above tools, got ${JSON.stringify(o)}`
  );
}

// CASE B — final answer: the tools already resolved, so the live partial is a
// follow-up answer and must remain BELOW the tools.
{
  const o = order(
    createBatchWorkstreamModel({
      messages: [asstWithTools('LS', 'Glob')] as any,
      toolStatusMap: statusMap('LS-0', 'Glob-1'),
      toolResultsMap: resultMap('LS-0', 'Glob-1'),
      isSessionRunning: true,
      liveTrace: { partialText: '这个项目是一个 AI 生成的单页应用作品集。' },
    })
  );
  const noteIdx = o.findIndex((x) => x.startsWith('note'));
  const lastToolIdx = o.map((x) => x.startsWith('tool')).lastIndexOf(true);
  assert.ok(
    noteIdx > lastToolIdx,
    `case B: final answer must stay below tools, got ${JSON.stringify(o)}`
  );
}

// CASE C — completed: the text block is committed before the tools. The order
// here is the target the streaming state (case A) must match.
{
  const o = order(
    createBatchWorkstreamModel({
      messages: [asstTextThenTools(PREAMBLE, 'LS', 'Glob')] as any,
      toolStatusMap: EMPTY_STATUS,
      toolResultsMap: EMPTY_RESULTS,
      isSessionRunning: true,
      liveTrace: { partialText: PREAMBLE },
    })
  );
  assert.deepEqual(
    o,
    [`note:${PREAMBLE}`, 'tool:LS', 'tool:Glob'],
    `case C: committed text stays above tools, got ${JSON.stringify(o)}`
  );
}

// CASE D — multi-turn: turn 1 is fully resolved (text + tool result); turn 2 is
// streaming with its tool committed but preamble still partial. The preamble
// must sit above turn 2's tool only — not above turn 1's resolved tool.
{
  const turn1: StreamMessage = {
    type: 'assistant',
    uuid: 'a1',
    message: {
      content: [
        { type: 'text', text: 'First I will list files.' },
        { type: 'tool_use', id: 'LS-0', name: 'LS', input: {} },
      ],
    },
  } as StreamMessage;
  const o = order(
    createBatchWorkstreamModel({
      messages: [turn1, asstWithTools('Glob')] as any,
      toolStatusMap: statusMap('LS-0'),
      toolResultsMap: resultMap('LS-0'),
      isSessionRunning: true,
      liveTrace: { partialText: '现在看一下目录结构。' },
    })
  );
  const idxLS = o.indexOf('tool:LS');
  const idxNote2 = o.findIndex((x) => x.startsWith('note:现在'));
  const idxGlob = o.indexOf('tool:Glob');
  assert.ok(
    idxLS >= 0 && idxLS < idxNote2 && idxNote2 < idxGlob,
    `case D: second preamble must sit between LS and Glob, got ${JSON.stringify(o)}`
  );
}

// CASE E — preamble THINKING (not just text): committed message has only the
// tool, the live partial is the reasoning that preceded it. The thinking must
// render above the tool, same as the committed order.
{
  const msg: StreamMessage = {
    type: 'assistant',
    uuid: 'a1',
    message: { content: [{ type: 'tool_use', id: 'LS-0', name: 'LS', input: {} }] },
  } as StreamMessage;
  const o = order(
    createBatchWorkstreamModel({
      messages: [msg] as any,
      toolStatusMap: EMPTY_STATUS,
      toolResultsMap: EMPTY_RESULTS,
      isSessionRunning: true,
      liveTrace: { partialThinking: '我在分析项目结构' },
    })
  );
  const thinkIdx = o.findIndex((x) => x === 'think');
  const toolIdx = o.findIndex((x) => x.startsWith('tool'));
  assert.ok(
    thinkIdx >= 0 && thinkIdx < toolIdx,
    `case E: preamble thinking must be above its pending tool, got ${JSON.stringify(o)}`
  );
}

// CASE F — interleaved thinking (reasoning AFTER a resolved tool, e.g. the next
// turn thinks before answering). The live thinking must stay BELOW the resolved
// tool — it did not precede it — and must not be hoisted above it.
{
  const msg: StreamMessage = {
    type: 'assistant',
    uuid: 'a1',
    message: { content: [{ type: 'tool_use', id: 'LS-0', name: 'LS', input: {} }] },
  } as StreamMessage;
  const o = order(
    createBatchWorkstreamModel({
      messages: [msg] as any,
      toolStatusMap: statusMap('LS-0'),
      toolResultsMap: resultMap('LS-0'),
      isSessionRunning: true,
      liveTrace: { partialThinking: '现在我来组织答案' },
    })
  );
  const thinkIdx = o.findIndex((x) => x === 'think');
  const lastToolIdx = o.map((x) => x.startsWith('tool')).lastIndexOf(true);
  assert.ok(
    thinkIdx > lastToolIdx,
    `case F: post-tool thinking must stay below the resolved tool, got ${JSON.stringify(o)}`
  );
}

// CASE G — out-of-order commit (the real bug from production logs): a preamble
// text block is committed to the store AFTER the tool it preceded, but carries
// an earlier createdAt. The work group must render in createdAt order (text
// above the tool) in BOTH streaming and completed, so it doesn't snap on finish.
{
  const think: StreamMessage = {
    type: 'assistant', uuid: 'e5df', createdAt: 28658,
    message: { content: [{ type: 'thinking', thinking: '让我看看' }] },
  } as StreamMessage;
  const bash: StreamMessage = {
    type: 'assistant', uuid: '43f0', createdAt: 30474,
    message: { content: [{ type: 'tool_use', id: 'B-0', name: 'Bash', input: {} }] },
  } as StreamMessage;
  // Preamble text — earlier createdAt than Bash, but appended last (arrival order).
  const preamble: StreamMessage = {
    type: 'assistant', uuid: 'e432', createdAt: 28714,
    message: { content: [{ type: 'text', text: '看看项目里有什么' }] },
  } as StreamMessage;

  const arrivalOrder = [think, bash, preamble]; // what the store holds mid-stream
  const o = order(
    createBatchWorkstreamModel({
      messages: arrivalOrder as any,
      toolStatusMap: statusMap('B-0'),
      toolResultsMap: resultMap('B-0'),
      isSessionRunning: true,
    })
  );
  assert.deepEqual(
    o,
    ['think', 'note:看看项目里有什么', 'tool:Bash'],
    `case G: out-of-order preamble must render in createdAt order, got ${JSON.stringify(o)}`
  );
}

console.log('workstream-preamble-order: all cases passed');
