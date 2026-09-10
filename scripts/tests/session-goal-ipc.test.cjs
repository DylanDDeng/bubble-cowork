const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const root = path.resolve(__dirname, '../../dist-electron/electron');
const handlers = new Map(),
  rows = new Map(),
  messages = [],
  broadcasts = [],
  windowEvents = [];
class Adapter {
  loaded = new Set();
  calls = [];
  saved = new Map();
  live = false;
  hasSession(id) {
    return this.loaded.has(id);
  }
  hasActiveGoalTurn() {
    return this.live;
  }
  async readGoal(id, native) {
    this.calls.push(['read', id]);
    return this.saved.get(native) ?? null;
  }
  async changeGoal(id, action) {
    this.calls.push(['loaded', id, action]);
    return this.mutate(id, rows.get(id).codex_session_id, action);
  }
  async changeUnloadedGoal(native, cwd, action) {
    this.calls.push(['unloaded', native, action]);
    return this.mutate(
      [...rows.values()].find((row) => row.codex_session_id === native).id,
      native,
      action,
    );
  }
  mutate(id, native, action) {
    const next =
      action.type === 'clear' ? null : { ...goal(native), ...this.saved.get(native), ...action };
    this.saved.set(native, next);
    service.events.emit('event', { type: 'goal_changed', threadId: id, goal: next });
    return next;
  }
  async stopSession(id) {
    this.calls.push(['stop', id]);
  }
}
class RpcError extends Error {
  constructor(code, message = 'unsupported') {
    super(message);
    this.code = code;
  }
}
const adapter = new Adapter();
const service = { events: new EventEmitter(), getAdapter: () => adapter };
const sessions = {
  getSession: (id) => rows.get(id),
  getStoredMessage: (id, uuid) => messages.find(m => m.id === id && m.uuid === uuid) ?? null,
  findGoalCompletionAnswer: () => 'native-answer',
  updateLastPrompt: (id, prompt) => {
    rows.get(id).last_prompt = prompt;
  },
  addMessage: (id, message) => {
    const index = message.uuid ? messages.findIndex(m => m.id === id && m.uuid === message.uuid) : -1;
    if (index < 0) messages.push({ id, ...message });
    else messages[index] = { id, ...message };
  },
  updateSessionStatus: (id, status) => {
    rows.get(id).status = status;
  },
  updateSessionCodexExecutionMode: (id, mode) => {
    rows.get(id).mode = mode;
  },
  updateSessionModel() {},
  updateSessionCodexPermissionMode() {},
  updateSessionCodexReasoningEffort() {},
  updateSessionCodexFastMode() {},
};
const mock = new Map([
  [path.join(root, 'util.js'), { ipcMainHandle: (name, handler) => handlers.set(name, handler) }],
  [path.join(root, 'libs/session-store.js'), sessions],
  [path.join(root, 'libs/provider/service.js'), { getProviderService: () => service }],
  [path.join(root, 'libs/provider/codex-adapter.js'), { CodexAdapter: Adapter }],
  [path.join(root, 'libs/provider/codex-app-server-manager.js'), { CodexRpcError: RpcError }],
]);
const load = Module._load;
Module._load = function (request, parent, ...args) {
  if (request === 'electron')
    return {
      BrowserWindow: {
        getAllWindows: () => [
          { isDestroyed: () => false, webContents: { send: (...args) => windowEvents.push(args) } },
        ],
      },
    };
  const resolved = Module._resolveFilename(request, parent);
  return mock.has(resolved) ? mock.get(resolved) : load.call(this, request, parent, ...args);
};
const api = require(path.join(root, 'ipc/session-goal.js'));
Module._load = load;
const goal = (threadId, status = 'paused') => ({
  threadId,
  objective: 'Native objective',
  status,
  tokenBudget: null,
  tokensUsed: 1,
  timeUsedSeconds: 1,
  createdAt: 1,
  updatedAt: 2,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));
const invoke = (name, ...args) => handlers.get(name)({}, ...args);
let starts = 0,
  failStart = false;
service.events.on('event', (event) => {
  if (event.type === 'goal_changed')
    api.publishSessionGoal(event.threadId, event.goal, true, event.resumeConfirmation);
});
api.setupSessionGoalIPC({
  broadcast: (event) => broadcasts.push(event),
  startGoalRunner: (row, action) => {
    starts++;
    if (failStart) {
      api.rejectSessionGoalStart(row.id, new Error('Native startup failed'));
      return;
    }
    // Ignore unrelated/stale hydrated notifications until this activation lands.
    service.events.emit('event', {
      type: 'goal_changed',
      threadId: row.id,
      goal: goal(row.codex_session_id),
    });
    adapter.loaded.add(row.id);
    adapter.mutate(row.id, row.codex_session_id, action);
  },
});
(async () => {
  for (const id of ['a', 'b', 'c'])
    rows.set(id, { id, provider: 'codex', cwd: '/tmp', codex_session_id: 'native-' + id });
  adapter.saved.set('native-a', goal('native-a'));
  assert.equal((await invoke('get-session-goal', 'a')).goal.status, 'paused');
  assert.equal(starts, 0);
  await invoke('change-session-goal', 'a', { type: 'set', status: 'paused' });
  assert.equal(adapter.calls.at(-1)[0], 'unloaded');
  assert.equal(starts, 0);
  const started = await invoke(
    'change-session-goal',
    'a',
    { type: 'set', objective: 'Pursue this', status: 'active' },
    { appendTranscript: true },
  );
  assert.equal(started.goal.objective, 'Pursue this');
  assert.equal(started.goal.status, 'active');
  assert.equal(starts, 1);
  assert.equal(rows.get('a').mode, 'execute');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].prompt, '/goal Pursue this');
  assert.equal(broadcasts.filter((e) => e.type === 'stream.user_prompt').length, 1);
  await invoke('change-session-goal', 'a', { type: 'set', objective: 'Edited', status: 'active' });
  assert.equal(messages.length, 1, 'editor does not append a user turn');
  const old = adapter.readGoal;
  adapter.readGoal = async () => {
    api.publishSessionGoal('a', goal('native-a', 'blocked'));
    return goal('native-a', 'active');
  };
  assert.equal((await invoke('get-session-goal', 'a')).goal.status, 'blocked');
  adapter.readGoal = old;
  adapter.readGoal = async () => {
    throw new RpcError(-32601);
  };
  assert.equal((await invoke('get-session-goal', 'b')).supported, false);
  adapter.readGoal = old;
  failStart = true;
  await assert.rejects(
    invoke(
      'change-session-goal',
      'c',
      { type: 'set', objective: 'Fails', status: 'active' },
      { appendTranscript: true },
    ),
    /Native startup failed/,
  );
  await tick();
  assert.ok(adapter.calls.some((c) => c[0] === 'stop' && c[1] === 'c'));
  assert.equal(messages.length, 1);
  failStart = false;
  const completed = { ...goal('native-a', 'complete'), objective: 'Edited', updatedAt: 10 };
  api.publishSessionGoal('a', completed);
  await tick();
  await tick();
  assert.equal(api.getCachedSessionGoal('a').goal, null);
  assert.equal(api.getCachedSessionGoal('a').completedGoal.objective, 'Edited');
  const completion = messages.find(m => m.type === 'goal_completed');
  assert.equal(completion.goal.objective, 'Edited');
  assert.equal(completion.afterMessageId, 'native-answer');
  assert.equal(completion.createdAt, 10000, 'completion keeps native time for turn ownership');
  api.publishSessionGoal('a', { ...completed });
  assert.equal(messages.filter(m => m.type === 'goal_completed').length, 1, 'rehydration upserts the same history record');
  await invoke('change-session-goal', 'a', { type: 'clear' });
  assert.equal(api.getCachedSessionGoal('a').completedGoal, undefined);
  assert.ok(messages.some(m => m.uuid === completion.uuid), 'clear preserves historical completion');
  // Completion queued behind a replacement cannot clear the newer objective.
  const replacement = invoke('change-session-goal', 'a', {
    type: 'set',
    objective: 'New objective',
    status: 'active',
  });
  api.publishSessionGoal('a', { ...completed, updatedAt: 20 });
  await replacement;
  await tick();
  assert.equal(api.getCachedSessionGoal('a').goal.objective, 'New objective');
  assert.ok(messages.some(m => m.uuid === completion.uuid), 'replacement preserves the prior goal result');
  adapter.loaded.delete('a');
  await invoke('change-session-goal', 'a', { type: 'clear' });
  assert.equal(adapter.calls.at(-1)[0], 'unloaded');
  rows.set('fresh', { id: 'fresh', provider: 'codex', cwd: '/tmp' });
  await invoke('change-session-goal', 'fresh', { type: 'clear' });
  assert.equal(starts, 2, 'clearing an empty draft never starts a native task');
  assert.ok(windowEvents.length > 0);
  assert.equal(service.events.listenerCount('event'), 1, 'cold start listeners are cleaned up');
  console.log(
    'session-goal IPC: unloaded reads/control, native activation, transcripts, stale reads, errors, completion/replacement races passed',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
