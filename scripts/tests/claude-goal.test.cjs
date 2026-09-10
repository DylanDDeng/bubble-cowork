const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-claude-goal-state-'));
const load = Module._load;
Module._load = function (id, ...args) {
  if (id === 'electron') return { app: { getPath: () => root } };
  return load.call(this, id, ...args);
};
const managerPath = require.resolve('../../dist-electron/electron/libs/claude-goal-manager.js');
const manager = require(managerPath);
const { ClaudeGoalController } = require('../../dist-electron/electron/libs/claude-goal.js');
Module._load = load;
const tick = () => new Promise((r) => setImmediate(r));
function transport(ctrl, commands = [{ name: 'goal' }]) {
  const calls = [];
  let interrupts = 0;
  return {
    calls,
    get interrupts() {
      return interrupts;
    },
    commands: async () => commands,
    interrupt: async () => {
      interrupts++;
    },
    abort: () => calls.push('abort'),
    send: (text) => {
      calls.push(text);
      void (async () => {
        assert.equal(
          await ctrl.receive({
            type: 'assistant',
            local_command_source: '<local-command-stdout>No goal set</local-command-stdout>',
          }),
          true,
        );
        assert.equal(await ctrl.receive({ type: 'result', result: 'No goal set' }), true);
      })();
    },
  };
}
(async () => {
  const ctrl = manager.createClaudeGoalController('task-a', false);
  const wire = transport(ctrl);
  await ctrl.initialize(wire);
  const text = await ctrl.prepare('/goal Finish the task');
  ctrl.submitted(text);
  await ctrl.receive({
    type: 'assistant',
    local_command_source: '<local-command-stdout>Goal set: Finish the task</local-command-stdout>',
  });
  assert.equal(manager.readClaudeGoalState('task-a').goal.status, 'active');
  // Repeating an objective must wait for a new native acknowledgement, even
  // though prompt submission republishes metadata for the old active goal.
  const repeated = manager.createClaudeGoalController('repeated', false);
  await repeated.initialize(transport(repeated));
  const repeatedPrompt = await repeated.prepare('/goal Same objective');
  const acknowledge = () => repeated.receive({
    type: 'assistant',
    local_command_source: '<local-command-stdout>Goal set: Same objective</local-command-stdout>',
  });
  repeated.submitted(repeatedPrompt);
  await acknowledge();
  let confirmed = false;
  const activation = manager.awaitClaudeGoalSet('repeated', 'Same objective', async () => {
    repeated.submitted(repeatedPrompt);
  }).then(() => { confirmed = true; });
  await tick();
  assert.equal(confirmed, false, 'metadata changes cannot confirm a repeated goal');
  await acknowledge();
  await activation;
  manager.releaseClaudeGoalController('repeated', repeated);

  const ordinary = manager.createClaudeGoalController('ordinary', true);
  const ordinaryWire = transport(ordinary);
  await ordinary.initialize(ordinaryWire);
  await ordinary.prepare('Continue ordinary work');
  assert.deepEqual(ordinaryWire.calls, [], 'ordinary task resume does not issue goal controls');
  manager.releaseClaudeGoalController('ordinary', ordinary);

  // Simulate an app process restart without a graceful dispose.
  delete require.cache[managerPath];
  Module._load = function (id, ...args) {
    if (id === 'electron') return { app: { getPath: () => root } };
    return load.call(this, id, ...args);
  };
  const restarted = require(managerPath);
  Module._load = load;
  const saved = restarted.readClaudeGoalState('task-a');
  assert.equal(saved.goal.status, 'paused');
  assert.equal(saved.resumeConfirmation, true);
  assert.equal(restarted.readClaudeGoalState('different-task').goal, null);

  // Re-interrupt a stopped queued turn without waiting behind its own pause.
  ctrl.submitted('queued follow-up');
  const paused = ctrl.interrupt();
  await tick();
  await ctrl.receive({ type: 'result' });
  await ctrl.interrupt();
  assert.equal(wire.interrupts, 2);
  await ctrl.receive({ type: 'result' });
  await paused;
  assert.equal(ctrl.snapshot.goal.status, 'paused');
  assert.deepEqual(wire.calls, ['/goal clear']);
  assert.equal(manager.readClaudeGoalState('task-a').goal.status, 'paused');
  const count = wire.calls.length;
  await ctrl.prepare('ordinary follow-up');
  assert.equal(
    wire.calls.length,
    count + 1,
    'ordinary follow-up clears any residual hook but never sets a goal',
  );

  const long = 'A detailed goal 😀'.repeat(400);
  const prepared = await ctrl.prepare('/goal ' + long);
  const file = JSON.parse(prepared.match(/described in (".*")\. Read/)[1]);
  assert.equal(fs.readFileSync(file, 'utf8'), long);
  assert.equal(ctrl.ownsObjectiveFile(file), true);
  assert.equal(ctrl.ownsObjectiveFile(path.join(root, 'settings.json')), false);
  assert.ok(prepared.length < 4006);
  assert.equal(
    ctrl.snapshot.goal.status,
    'paused',
    'preparing a cancelled prompt cannot activate a goal',
  );

  const unsupported = new ClaudeGoalController({
    sessionId: 'old',
    storageDir: root,
    initial: { goal: null, supported: true },
    resumed: false,
    publish() {},
  });
  await unsupported.initialize(transport(unsupported, []));
  await assert.rejects(unsupported.prepare('/goal Work'), /does not support/);
  assert.equal(unsupported.snapshot.goal, null);
  unsupported.dispose();
  manager.releaseClaudeGoalController('task-a', ctrl);
  console.log(
    'claude-goal: persisted restart state, session isolation, queued stop, native command filtering, long-goal access and unsupported runtimes passed',
  );
})()
  .finally(() => {
    Module._load = load;
    fs.rmSync(root, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
