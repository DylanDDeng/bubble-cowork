import assert from 'node:assert/strict';
import { deriveTranscriptTimelineItems } from '../../src/ui/utils/transcript-timeline';
import type { StreamMessage } from '../../src/ui/types';

function msg(
  content: unknown[],
  opts: { parentToolUseId?: string | null } = {}
): StreamMessage {
  return {
    type: 'assistant',
    uuid: `u-${content.length}-${Math.round(Math.random() * 1e9)}`,
    parentToolUseId: opts.parentToolUseId ?? null,
    createdAt: 1,
    message: { content },
  } as unknown as StreamMessage;
}

// ── Default: subagent (parentToolUseId) messages are skipped ────────────────
{
  const items = deriveTranscriptTimelineItems([
    msg([{ type: 'text', text: 'main' }]),
    msg([{ type: 'text', text: 'sub' }], { parentToolUseId: 'toolu_A' }),
  ]);
  const s = JSON.stringify(items);
  assert.ok(s.includes('main'), 'main rendered by default');
  assert.equal(s.includes('"sub"'), false, 'subagent message skipped by default');
}

// ── Scoped: only that subagent's own messages, not top-level or siblings ────
{
  const items = deriveTranscriptTimelineItems(
    [
      msg([{ type: 'text', text: 'main' }]),
      msg([{ type: 'text', text: 'subA' }], { parentToolUseId: 'toolu_A' }),
      msg([{ type: 'text', text: 'subB' }], { parentToolUseId: 'toolu_B' }),
    ],
    { subagentScopeId: 'toolu_A' }
  );
  const s = JSON.stringify(items);
  assert.ok(s.includes('subA'), 'scope A message kept');
  assert.equal(s.includes('subB'), false, 'other subagent skipped in scope');
  assert.equal(s.includes('"main"'), false, 'top-level skipped in scope');
}

// ── Scoped with a nested sub-Task: the Task block stays (renders as a nested
//    board via the render layer's subagentMessagesByParent) ─────────────────
{
  const items = deriveTranscriptTimelineItems(
    [
      msg([{ type: 'text', text: 'subA-start' }], { parentToolUseId: 'toolu_A' }),
      msg([{ type: 'tool_use', id: 'toolu_nested', name: 'Task', input: { subagent_type: 'Explore' } }], {
        parentToolUseId: 'toolu_A',
      }),
      // grandchild message belongs to the nested task, not directly to A
      msg([{ type: 'text', text: 'grandchild' }], { parentToolUseId: 'toolu_nested' }),
    ],
    { subagentScopeId: 'toolu_A' }
  );
  const s = JSON.stringify(items);
  assert.ok(s.includes('toolu_nested'), 'nested Task block kept in scope');
  assert.equal(s.includes('grandchild'), false, 'grandchild not inlined at this scope level');
}

// ── Live scoped trace: narration stays in chronological order (no tentative
//    answer promotion — the SubagentPanel passes activeTurnStartIndex: -1) ──
{
  const messages = [
    msg([{ type: 'text', text: 'narration-before-spawn' }], { parentToolUseId: 'toolu_A' }),
    msg([{ type: 'tool_use', id: 'tool_spawn', name: 'Agent', input: { subagent_type: 'explore' } }], {
      parentToolUseId: 'toolu_A',
    }),
    msg([{ type: 'text', text: 'trailing-live-text' }], { parentToolUseId: 'toolu_A' }),
  ];
  // LIVE: the trailing text must NOT be promoted to a terminal answer — it
  // folds into the work region in order, so nothing jumps when more
  // activity arrives after it.
  const live = deriveTranscriptTimelineItems(messages, {
    subagentScopeId: 'toolu_A',
    sessionRunning: true,
    activeTurnStartIndex: -1,
  });
  const liveAnswer = live.find(
    (item) => item.type === 'message' && (item as { assistantPresentation?: string }).assistantPresentation === 'answer'
  );
  assert.equal(
    Boolean(liveAnswer && JSON.stringify(liveAnswer).includes('trailing-live-text')),
    false,
    'live trailing text is not presented as the answer'
  );
  const liveOrder = JSON.stringify(live);
  assert.ok(
    liveOrder.indexOf('narration-before-spawn') < liveOrder.indexOf('tool_spawn'),
    'live narration keeps its chronological position before the spawn'
  );

  // SETTLED: once the trace stops running and its tools resolved, the
  // closing text presents as the answer below the collapsed work. (With an
  // UNRESOLVED tool the settle path freezes the trace instead — that is the
  // interrupted case, covered by the collapse logic itself.)
  const settledMessages = [
    ...messages,
    {
      type: 'user',
      uuid: 'u-result',
      parentToolUseId: 'toolu_A',
      createdAt: 2,
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool_spawn', content: 'done' }] },
    } as unknown as StreamMessage,
  ];
  const done = deriveTranscriptTimelineItems(settledMessages, {
    subagentScopeId: 'toolu_A',
    sessionRunning: false,
    activeTurnStartIndex: -1,
  });
  const doneStr = JSON.stringify(done);
  const answerItem = done.find(
    (item) => item.type === 'message' && JSON.stringify(item).includes('trailing-live-text')
  );
  assert.ok(answerItem, 'closing text renders once settled');
  assert.ok(doneStr.includes('trailing-live-text'), 'closing text present after settle');
}

console.log('subagent-scope.test.ts passed');
