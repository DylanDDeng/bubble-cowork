import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Protocol-level test for the Bubble subagent wire shape: verify that a
 * spawn_agent lane emitted by the adapter (nested messages keyed by
 * parentToolUseId) is picked up by the SAME UI layers the Claude/Codex
 * subagent board uses — classifyToolUse / isSubagentTaskBlock /
 * deriveSubagentSummaries / groupSubagentMessagesByParent. This pins the
 * adapter↔UI contract without spinning Electron.
 */

async function main() {
  const home = mkdtempSync(path.join(tmpdir(), 'bubble-subagent-test-'));
  try {
    // ── Shared fixtures: one spawn_agent tool_use + nested child messages ──
    const SPAWN_ID = 'call-spawn-001';
    const CHILD_TOOL_ID = 'child-tool-9';

    const spawnUseBlock = {
      type: 'tool_use',
      id: SPAWN_ID,
      name: 'spawn_agent',
      input: { agent_type: 'explorer', message: 'Find all TODO comments' },
    } as const;
    const spawnResultBlock = {
      type: 'tool_result',
      tool_use_id: SPAWN_ID,
      content: 'agent_id: ag-1 (Fernando)',
      is_error: false,
    };

    const messages = [
      {
        type: 'assistant',
        uuid: 'm1',
        message: { content: [spawnUseBlock] },
      },
      {
        type: 'user',
        uuid: 'm2',
        message: { content: [spawnResultBlock] },
      },
      // Nested child narration (adapter emits with parentToolUseId).
      {
        type: 'assistant',
        uuid: 'm3',
        parentToolUseId: SPAWN_ID,
        message: { content: [{ type: 'text', text: 'Scanning files…' }] },
      },
      {
        type: 'assistant',
        uuid: 'm4',
        parentToolUseId: SPAWN_ID,
        message: {
          content: [
            { type: 'tool_use', id: CHILD_TOOL_ID, name: 'Grep', input: { pattern: 'TODO' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'm5',
        parentToolUseId: SPAWN_ID,
        message: {
          content: [
            { type: 'tool_result', tool_use_id: CHILD_TOOL_ID, content: '3 matches', is_error: false },
          ],
        },
      },
    ];

    // ── 1. classifyToolUse: spawn_agent / run_workflow must be 'subagent' ──
    const { classifyToolUse } = await import('../../src/ui/utils/tool-summary');
    assert.equal(classifyToolUse('spawn_agent', { agent_type: 'explorer' }), 'subagent');
    assert.equal(classifyToolUse('run_workflow', { steps: [] }), 'subagent');
    console.log('ok - classifyToolUse recognizes spawn_agent / run_workflow');

    // ── 2. isSubagentTaskBlock: the board detects the lane ──
    const { isSubagentTaskBlock } = await import('../../src/ui/utils/workstream');
    assert.equal(isSubagentTaskBlock(spawnUseBlock), true);
    console.log('ok - isSubagentTaskBlock detects the spawn_agent block');

    // ── 3. deriveSubagentSummaries: lane appears with type + description ──
    const { deriveSubagentSummaries } = await import('../../src/ui/utils/subagent-registry');
    const summaries = deriveSubagentSummaries(messages as never);
    assert.equal(summaries.length, 1, 'exactly one top-level subagent lane');
    const lane = summaries[0];
    assert.equal(lane.id, SPAWN_ID);
    assert.equal(lane.subagentType, 'explorer', 'agent_type surfaced as subagentType');
    assert.equal(lane.description, 'Find all TODO comments', 'message surfaced as description');
    assert.equal(lane.status, 'success', 'resolved tool_result marks the lane done');
    assert.equal(lane.childMessageCount, 3, 'nested child messages attributed to the lane');
    assert.ok(lane.durationMs === undefined || typeof lane.durationMs === 'number');
    console.log('ok - deriveSubagentSummaries extracts type/description/status/children');

    // ── 4. groupSubagentMessagesByParent: nested messages hide from the main
    //      transcript and appear in the scoped panel view ──
    const { groupSubagentMessagesByParent } = await import('../../src/ui/utils/workstream');
    const byParent = groupSubagentMessagesByParent(messages as never);
    const nested = byParent.get(SPAWN_ID) ?? [];
    assert.equal(nested.length, 3, 'child messages nested under the spawn id');
    assert.ok(
      nested.every((m) => (m as { parentToolUseId?: string }).parentToolUseId === SPAWN_ID),
      'every nested message carries parentToolUseId'
    );
    console.log('ok - groupSubagentMessagesByParent nests the child trace');

    // ── 5. Source-pin: the adapter actually routes subagent_update through the
    //      nesting path (guards against regressions dropping the case) ──
    const fs = await import('node:fs');
    const adapterSource = fs.readFileSync(
      path.resolve(import.meta.dirname ?? '.', '../../src/electron/libs/provider/bubble-sdk-adapter.ts'),
      'utf8'
    );
    assert.ok(
      adapterSource.includes("case 'subagent_update'"),
      'adapter handles the subagent_update event'
    );
    assert.ok(
      adapterSource.includes('parentToolUseId: parentToolCallId'),
      'nested child messages re-keyed to the spawning tool_use id'
    );
    assert.ok(
      adapterSource.includes('flushSubagentStream'),
      'buffered child narration commits on terminal status'
    );
    assert.ok(
      adapterSource.includes('type BubbleSubagentUpdate') || adapterSource.includes('BubbleSubagentUpdate'),
      'loader declares the subagent_update payload type'
    );
    assert.ok(
    adapterSource.includes('heldSpawnResults'),
    'fire-and-forget spawn results are held until the child terminal status (UI lane stays running, not instantly Done)'
  );
  // Wire-shape pin: the SDK flattens subagent_update at the event top level
  // (agent.js drainToolUpdates yields buildSubagentUpdate's return as-is) —
  // the earlier `event.update` wrapper read silently never fired.
  assert.ok(
    /case 'subagent_update':\s*\{[\s\S]{0,200}handleSubagentUpdate\(session, event as unknown as BubbleSubagentUpdate\)/.test(
      adapterSource.replace(/\n\s*\/\/[^\n]*/g, '\n')
    ),
    'subagent_update handler reads the FLATTENED event, not event.update'
  );
  assert.ok(
    adapterSource.includes("case 'tool_update':"),
    'tool_update frames (spawn/wait execution drains) are routed to the subagent lane too'
  );
  console.log('ok - adapter source pins the subagent wire translation');

    console.log('bubble subagent protocol tests passed');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  }

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
