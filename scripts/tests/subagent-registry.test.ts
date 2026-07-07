import assert from 'node:assert/strict';
import { deriveSubagentSummaries } from '../../src/ui/utils/subagent-registry';
import type { StreamMessage } from '../../src/ui/types';

function assistant(
  content: unknown[],
  opts: { parentToolUseId?: string | null; createdAt?: number } = {}
): StreamMessage {
  return {
    type: 'assistant',
    uuid: `a-${Math.round((opts.createdAt ?? 0) + content.length + Math.random() * 1e6)}`,
    parentToolUseId: opts.parentToolUseId ?? null,
    createdAt: opts.createdAt,
    message: { content },
  } as unknown as StreamMessage;
}

function taskBlock(id: string, subagentType: string, description: string) {
  return { type: 'tool_use', id, name: 'Task', input: { subagent_type: subagentType, description } };
}

function toolResult(toolUseId: string, isError = false) {
  return { type: 'tool_result', tool_use_id: toolUseId, content: 'done', is_error: isError };
}

// ── Two parallel top-level subagents are listed, in message order ───────────
{
  const messages: StreamMessage[] = [
    assistant([
      taskBlock('toolu_A', 'Explore', '产品视角'),
      taskBlock('toolu_B', 'Explore', '工程视角'),
    ], { createdAt: 1000 }),
  ];
  const summaries = deriveSubagentSummaries(messages);
  assert.equal(summaries.length, 2, 'both top-level subagents listed');
  assert.deepEqual(summaries.map((s) => s.id), ['toolu_A', 'toolu_B']);
  assert.equal(summaries[0].subagentType, 'Explore');
  assert.equal(summaries[0].description, '产品视角');
  assert.equal(summaries[0].persona.functionalName, 'Explore · 产品视角');
}

// ── Status: pending until a matching tool_result, then success/error ───────
{
  const base = [assistant([taskBlock('toolu_A', 'Explore', 'x')], { createdAt: 1 })];
  assert.equal(deriveSubagentSummaries(base)[0].status, 'pending', 'no result → pending');

  const withResult: StreamMessage[] = [
    ...base,
    assistant([toolResult('toolu_A', false)], { createdAt: 2 }),
  ];
  assert.equal(deriveSubagentSummaries(withResult)[0].status, 'success');

  const withError: StreamMessage[] = [
    assistant([taskBlock('toolu_B', 'Explore', 'x')], { createdAt: 1 }),
    assistant([toolResult('toolu_B', true)], { createdAt: 2 }),
  ];
  assert.equal(deriveSubagentSummaries(withError)[0].status, 'error');
}

// ── Nested sub-Tasks (subagent's own Task) are NOT top-level entries ────────
{
  const messages: StreamMessage[] = [
    assistant([taskBlock('toolu_parent', 'Explore', 'main')], { createdAt: 1 }),
    // A message emitted BY the subagent (parentToolUseId set) that itself
    // issues a nested Task — must not appear as a top-level subagent.
    assistant([taskBlock('toolu_child', 'general-purpose', 'nested')], {
      parentToolUseId: 'toolu_parent',
      createdAt: 2,
    }),
  ];
  const summaries = deriveSubagentSummaries(messages);
  assert.equal(summaries.length, 1, 'only the top-level subagent is listed');
  assert.equal(summaries[0].id, 'toolu_parent');
}

// ── Timing: startedAt from earliest child; duration only once finished ─────
{
  const running: StreamMessage[] = [
    assistant([taskBlock('toolu_A', 'Explore', 'x')], { createdAt: 100 }),
    assistant([{ type: 'text', text: 'working' }], { parentToolUseId: 'toolu_A', createdAt: 150 }),
    assistant([{ type: 'text', text: 'more' }], { parentToolUseId: 'toolu_A', createdAt: 220 }),
  ];
  const s1 = deriveSubagentSummaries(running)[0];
  assert.equal(s1.startedAt, 150, 'startedAt = earliest child ts');
  assert.equal(s1.durationMs, undefined, 'no duration while running');

  const finished: StreamMessage[] = [
    ...running,
    assistant([toolResult('toolu_A')], { createdAt: 300 }),
  ];
  const s2 = deriveSubagentSummaries(finished)[0];
  assert.equal(s2.durationMs, 70, 'duration = maxChild - minChild once finished');
}

// ── Non-Task tools are ignored ─────────────────────────────────────────────
{
  const messages: StreamMessage[] = [
    assistant([{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/x' } }], { createdAt: 1 }),
  ];
  assert.equal(deriveSubagentSummaries(messages).length, 0, 'Read is not a subagent');
}

// ── The "Agent" tool (this runtime's subagent spawn) is detected, not just
//    "Task" — regression guard for the real-data bug where the subagent tool
//    is named Agent and carries a subagent_type input. ─────────────────────
{
  const agentBlock = {
    type: 'tool_use',
    id: 'toolu_agent',
    name: 'Agent',
    input: { subagent_type: 'general-purpose', description: '探查项目架构', prompt: '…' },
  };
  const messages: StreamMessage[] = [
    assistant([agentBlock], { createdAt: 1 }),
    assistant([toolResult('toolu_agent', false)], { createdAt: 2 }),
  ];
  const summaries = deriveSubagentSummaries(messages);
  assert.equal(summaries.length, 1, 'Agent-named subagent is detected');
  assert.equal(summaries[0].subagentType, 'general-purpose');
  assert.equal(summaries[0].status, 'success');
  assert.equal(summaries[0].persona.functionalName, 'General-purpose · 探查项目架构');
}

// ── A tool that merely declares subagent_type is treated as a subagent even
//    under an unknown name (runtime-agnostic fallback). ────────────────────
{
  const messages: StreamMessage[] = [
    assistant(
      [{ type: 'tool_use', id: 'toolu_x', name: 'SpawnWorker', input: { subagent_type: 'Explore' } }],
      { createdAt: 1 }
    ),
  ];
  assert.equal(deriveSubagentSummaries(messages).length, 1, 'subagent_type input alone marks a subagent');
}

// ── Empty / no-subagent sessions return [] ─────────────────────────────────
assert.deepEqual(deriveSubagentSummaries([]), []);

// ── Deduped if the same Task block somehow appears twice ───────────────────
{
  const messages: StreamMessage[] = [
    assistant([taskBlock('toolu_A', 'Explore', 'x')], { createdAt: 1 }),
    assistant([taskBlock('toolu_A', 'Explore', 'x')], { createdAt: 2 }),
  ];
  assert.equal(deriveSubagentSummaries(messages).length, 1, 'dedup by tool_use id');
}

console.log('subagent-registry.test.ts passed');
