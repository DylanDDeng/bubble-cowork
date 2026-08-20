import assert from 'node:assert/strict';
import {
  createDeepseekSubagentRuntime,
  isDeepseekSubagentToolName,
  namespaceDeepseekToolId,
  registerDeepseekChildHint,
  registerDeepseekSpawn,
  registerDeepseekStarted,
  spawnFromToolInput,
} from '../../src/electron/libs/provider/deepseek-subagent-trace';

function spawn(
  parentSessionId: string,
  rawCallId: string,
  input: Record<string, unknown>
) {
  return spawnFromToolInput(parentSessionId, rawCallId, input);
}

{
  assert.equal(isDeepseekSubagentToolName('subagent'), true);
  assert.equal(isDeepseekSubagentToolName('SubAgent'), true);
  assert.equal(isDeepseekSubagentToolName('Task'), false);
  assert.equal(
    namespaceDeepseekToolId('sess-root', 'call-1'),
    'sess-root:call-1'
  );
  console.log('ok - tool name and namespaced ids');
}

{
  const state = createDeepseekSubagentRuntime();
  registerDeepseekSpawn(
    state,
    spawn('root', 'call-a', { description: 'Explore', prompt: 'look around' })
  );
  const bound = registerDeepseekStarted(state, 'root', 'child-a');
  assert.equal(bound, 'root:call-a');
  assert.equal(state.parents.get('child-a'), 'root:call-a');
  console.log('ok - lone spawn binds on started');
}

{
  const state = createDeepseekSubagentRuntime();
  const bound = registerDeepseekStarted(state, 'root', 'child-a');
  assert.equal(bound, null);
  const later = registerDeepseekSpawn(
    state,
    spawn('root', 'call-a', { description: 'Explore', prompt: 'look around' })
  );
  assert.equal(later, 'root:call-a');
  assert.equal(state.parents.get('child-a'), 'root:call-a');
  console.log('ok - started before tool/call still binds uniquely');
}

{
  const state = createDeepseekSubagentRuntime();
  registerDeepseekSpawn(
    state,
    spawn('root', 'call-a', { description: 'Explore files', prompt: 'find todos' })
  );
  registerDeepseekSpawn(
    state,
    spawn('root', 'call-b', { description: 'Write tests', prompt: 'add coverage' })
  );
  assert.equal(registerDeepseekStarted(state, 'root', 'child-1'), null);
  assert.equal(registerDeepseekStarted(state, 'root', 'child-2'), null);
  assert.equal(state.parents.size, 0);

  const first = registerDeepseekChildHint(state, 'child-1', { label: 'Write tests' });
  assert.equal(first, 'root:call-b');
  const second = registerDeepseekChildHint(state, 'child-2', { prompt: 'find todos' });
  assert.equal(second, 'root:call-a');
  assert.equal(state.parents.get('child-1'), 'root:call-b');
  assert.equal(state.parents.get('child-2'), 'root:call-a');
  console.log('ok - parallel siblings bind by unique label/prompt, not FIFO');
}

{
  const state = createDeepseekSubagentRuntime();
  registerDeepseekSpawn(state, spawn('root', 'call-a', { prompt: 'same' }));
  registerDeepseekSpawn(state, spawn('root', 'call-b', { prompt: 'same' }));
  registerDeepseekStarted(state, 'root', 'child-1');
  registerDeepseekStarted(state, 'root', 'child-2');
  assert.equal(registerDeepseekChildHint(state, 'child-1', { prompt: 'same' }), null);
  assert.equal(state.parents.size, 0);
  console.log('ok - identical fingerprints stay unbound instead of misfiling');
}

{
  const state = createDeepseekSubagentRuntime();
  registerDeepseekSpawn(
    state,
    spawn('child-a', 'nested-1', { description: 'Nested', prompt: 'go deeper' })
  );
  const bound = registerDeepseekStarted(state, 'child-a', 'grandchild');
  assert.equal(bound, 'child-a:nested-1');
  console.log('ok - nested spawn namespaces against the child session');
}

console.log('deepseek-subagent-trace: ok');
