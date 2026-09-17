const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { applyGrokPermissionMode } = require('../../dist-electron/electron/libs/provider/grok-acp-permissions.js');

const processes = [];
let failNextStart = false;
function spawnFake() {
  const proc = new EventEmitter();
  Object.assign(proc, {
    stdout: new PassThrough(), stderr: new PassThrough(), killed: false, exitCode: null, signalCode: null,
    calls: [], yolo: false, ignoreUpdates: failNextStart, failList: false,
  });
  failNextStart = false;
  proc.kill = () => { proc.killed = true; proc.exitCode = 0; proc.emit('exit', 0); };
  proc.stdin = new Writable({ write(chunk, _, done) {
    const msg = JSON.parse(String(chunk));
    proc.calls.push(msg);
    queueMicrotask(() => {
      let result = {};
      let error;
      switch (msg.method) {
        case 'session/new':
          proc.yolo = proc.ignoreUpdates ? false : msg.params._meta?.yoloMode === true;
          result = { sessionId: 'native-session' };
          break;
        case 'session/resume': // Native resume ignores _meta permission flags.
          result = { sessionId: msg.params.sessionId };
          break;
        case '_x.ai/yolo_mode_changed':
          if (!proc.ignoreUpdates) proc.yolo = msg.params.yolo_mode;
          break;
        case '_x.ai/sessions/list':
          if (proc.failList) error = { code: -32601, message: 'Unsupported extension' };
          result = { result: { sessions: [{ sessionId: 'native-session', yolo: proc.yolo }] } };
          break;
        case 'session/set_config_option':
          error = { code: -32602, message: 'unknown config option: mode' };
          break;
      }
      if (msg.id !== undefined) proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...(error ? { error } : { result }) }) + '\n');
    });
    done();
  }});
  processes.push(proc);
  return proc;
}

// Mock external dependencies, retaining the real adapter and JSON-RPC client.
const load = Module._load;
Module._load = function (id, parent, ...rest) {
  if (parent?.filename.endsWith('/grok-acp-adapter.js')) {
    if (id === 'child_process') return { spawn: spawnFake };
    if (id === '../session-http-server') return { SESSION_MCP_SERVER_NAME: 'sessions', getSessionReaderHttpConfig: async () => ({ url: 'http://localhost/test', headers: {} }) };
    if (id === '../browser-use-http-server') return { getBrowserUseMcpDescriptor: () => null };
    if (id === '../grok-cli') return { resolveGrokBinary: async () => '/fake/grok', buildGrokEnv: () => ({}) };
    if (id === '../grok-session-files') return { readGrokSessionSignals: () => null };
  }
  return load.call(this, id, parent, ...rest);
};
const { GrokAcpAdapter } = require('../../dist-electron/electron/libs/provider/grok-acp-adapter.js');
Module._load = load;

async function main() {
  for (const resumeSessionId of [undefined, 'native-session']) {
    const adapter = new GrokAcpAdapter();
    const events = [];
    adapter.events.on('event', event => events.push(event));
    await adapter.startSession({ threadId: 'test', cwd: '/tmp', grokPermissionMode: 'yolo', resumeSessionId });
    const proc = processes.at(-1);
    const start = proc.calls.find(c => c.method === (resumeSessionId ? 'session/resume' : 'session/new'));
    assert.deepEqual(start.params._meta, { yoloMode: true, autoMode: false });
    assert.equal(start.params.permissionMode, undefined);
    assert.equal(proc.yolo, true, 'native state is YOLO after start/resume');
    assert.equal(adapter.sessions.get('test').permissionMode, 'yolo');

    for (const mode of ['default', 'yolo']) {
      await adapter.sendTurn({ threadId: 'test', prompt: 'edit image', grokPermissionMode: mode });
      assert.equal(proc.yolo, mode === 'yolo');
      assert.equal(proc.calls.at(-1).method, 'session/prompt');
    }
    proc.yolo = false; // Native state drift, picker unchanged.
    await adapter.sendTurn({ threadId: 'test', prompt: 'edit image' });
    assert.equal(proc.yolo, true, 'omitted turn mode re-applies last confirmed choice');

    const sent = proc.calls.filter(c => c.method === 'session/prompt').length;
    proc.ignoreUpdates = true;
    await adapter.sendTurn({ threadId: 'test', prompt: 'must not send', grokPermissionMode: 'default' });
    assert.equal(proc.calls.filter(c => c.method === 'session/prompt').length, sent);
    assert.equal(adapter.sessions.get('test').permissionMode, 'yolo', 'failed update never changes cached mode');
    assert.ok(events.some(e => e.type === 'error'));
    proc.failList = true;
    await adapter.sendTurn({ threadId: 'test', prompt: 'must not send', grokPermissionMode: 'yolo' });
    assert.equal(proc.calls.filter(c => c.method === 'session/prompt').length, sent);
    adapter.disposeSession('test');
    assert.equal(proc.killed, true);
  }

  const adapter = new GrokAcpAdapter();
  failNextStart = true;
  await assert.rejects(adapter.startSession({ threadId: 'failure', cwd: '/tmp', grokPermissionMode: 'yolo', prompt: 'never sent' }), /did not confirm/);
  assert.equal(processes.at(-1).killed, true, 'failed startup kills the new process');
  assert.equal(adapter.hasSession('failure'), false);
  assert.ok(!processes.at(-1).calls.some(c => c.method === 'session/prompt'));

  const normal = new GrokAcpAdapter();
  await normal.startSession({ threadId: 'normal', cwd: '/tmp', grokPermissionMode: 'default' });
  assert.equal(processes.at(-1).yolo, false);
  await normal.sendTurn({ threadId: 'normal', prompt: 'plan must not run as default', grokPermissionMode: 'plan' });
  assert.ok(!processes.at(-1).calls.some(c => c.method === 'session/prompt'), 'unsupported plan mode cannot silently execute');
  normal.disposeSession('normal');

  for (const payload of [{}, { result: { sessions: [] } }, { result: { sessions: [{ sessionId: 'other', yolo: true }] } }, { result: { sessions: [{ sessionId: 's', yolo: 'true' }] } }]) {
    await assert.rejects(applyGrokPermissionMode({ notify() {}, request: async () => payload }, 's', 'yolo'), /did not confirm/);
  }
  await assert.rejects(applyGrokPermissionMode({ notify() {}, request: () => new Promise(() => {}) }, 's', 'yolo', 10), /timed out/);
  console.log('Grok permissions: native-state confirmation, new/resume/warm turns, drift, failure and timeout passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
