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

console.log('subagent-scope.test.ts passed');
