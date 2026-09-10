// Real CLI protocol smoke test. An isolated, credential-free CODEX_HOME and
// paused goals guarantee this never dispatches an inference turn.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const temporary = await mkdtemp(join(tmpdir(), 'aegis-goal-protocol-'));
const env = { ...process.env, CODEX_HOME: temporary };
for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete env[name];
const child = spawn(process.env.AEGIS_TEST_CODEX_BINARY || 'codex', ['app-server'], {
  cwd: temporary,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
let id = 0;
const notifications = [];
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && pending.has(message.id)) {
    const request = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(request.timer);
    message.error
      ? request.reject(new Error(JSON.stringify(message.error)))
      : request.resolve(message.result);
  } else if (message.method) notifications.push(message.method);
});
child.stderr.resume();
const closed = new Promise((resolve) => child.once('close', resolve));
child.on('error', (error) => {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
});
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => {
      pending.delete(key);
      reject(new Error(`Timed out: ${method}`));
    }, 20000);
    pending.set(key, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n');
  });
}
try {
  await rpc('initialize', {
    clientInfo: { name: 'aegis_goal_verify', version: '1.0.0' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
  const started = await rpc('thread/start', { cwd: temporary, ephemeral: false });
  const threadId = started.thread.id;
  assert.equal((await rpc('thread/goal/get', { threadId })).goal, null);
  await rpc('thread/settings/update', {
    threadId,
    collaborationMode: {
      mode: 'default',
      settings: {
        model: started.model,
        reasoning_effort: started.reasoningEffort ?? null,
        developer_instructions: null,
      },
    },
  });
  const set = await rpc('thread/goal/set', {
    threadId,
    objective: 'Protocol validation only; remain paused',
    status: 'paused',
    tokenBudget: 1000,
  });
  assert.equal(set.goal.status, 'paused');
  assert.equal(set.goal.tokenBudget, 1000);
  await rpc('thread/unsubscribe', { threadId });
  assert.equal((await rpc('thread/goal/get', { threadId })).goal.status, 'paused');
  const edited = await rpc('thread/goal/set', {
    threadId,
    objective: 'Edited while unloaded',
    status: 'paused',
  });
  assert.equal(edited.goal.objective, 'Edited while unloaded');
  assert.equal((await rpc('thread/goal/clear', { threadId })).cleared, true);
  assert.equal((await rpc('thread/goal/get', { threadId })).goal, null);
  assert.equal(
    notifications.includes('turn/started'),
    false,
    'control RPCs must not run a model turn',
  );
  console.log(
    'codex-goal native: real settings/get/set/clear, paused persistence, unloaded control; no inference turns',
  );
} finally {
  for (const request of pending.values()) clearTimeout(request.timer);
  child.stdin.end();
  child.kill('SIGTERM');
  await closed;
  lines.close();
  await rm(temporary, { recursive: true, force: true });
}
