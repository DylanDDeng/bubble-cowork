// Real installed Claude Code + Agent SDK, with a loopback-only fake model.
// No user credentials/settings are loaded and no paid inference is requested.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { query } from '@anthropic-ai/claude-agent-sdk';
const root = await mkdtemp(join(tmpdir(), 'aegis-claude-goal-native-'));
await build({
  entryPoints: ['src/electron/libs/claude-goal.ts'],
  outfile: join(root, 'controller.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
});
const { ClaudeGoalController } = await import(join(root, 'controller.mjs'));
const home = join(root, 'home'),
  cwd = join(root, 'project');
await mkdir(home);
await mkdir(cwd);
let requests = 0;
let hold = false;
let pendingChecks = 1;
const responses = new Set();
const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!req.url.includes('/messages')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }
  const body = JSON.parse(raw);
  requests++;
  if (process.env.GOAL_DEBUG)
    console.log(
      'REQUEST',
      requests,
      JSON.stringify(body.system).slice(-1000),
      JSON.stringify(body.messages).slice(-1000),
    );
  if (hold) {
    responses.add(res);
    res.on('close', () => responses.delete(res));
    return;
  }
  const evaluating = JSON.stringify(body.messages.at(-1)).includes(
    'Based on the conversation transcript above, has the following stopping condition',
  );
  const text =
    evaluating && pendingChecks-- > 0
      ? '{"ok":false,"reason":"One more verification step is required"}'
      : '{"ok":true}';
  const message = {
    id: `msg_${randomUUID()}`,
    type: 'message',
    role: 'assistant',
    model: body.model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(message));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [event, data] of [
    [
      'message_start',
      { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
    ],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 5 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ])
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !/^(CLAUDE|ANTHROPIC|OPENAI|ELECTRON_RUN_AS_NODE)/.test(k),
  ),
);
Object.assign(env, {
  HOME: home,
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  ANTHROPIC_API_KEY: 'local-test-only',
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, label) {
  const deadline = Date.now() + 15000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await sleep(20);
  }
}
const all = [];
async function start(initial = { goal: null, supported: true }, resume, settings) {
  let wake;
  const queue = [];
  let done = false;
  const snapshots = [];
  const messages = [];
  const abort = new AbortController();
  async function* input() {
    while (!done) {
      if (queue.length) yield queue.shift();
      else await new Promise((r) => (wake = r));
    }
  }
  const send = (text) => {
    queue.push({
      type: 'user',
      uuid: randomUUID(),
      session_id: '',
      parent_tool_use_id: null,
      message: { role: 'user', content: text },
    });
    wake?.();
  };
  const ctrl = new ClaudeGoalController({
    sessionId: 'app-task',
    initial,
    resumed: Boolean(resume),
    storageDir: join(root, 'objectives'),
    publish: (s) => snapshots.push(s),
  });
  let nativeId = resume;
  let reinterrupt = false;
  const q = query({
    prompt: input(),
    options: {
      cwd,
      env,
      settings,
      settingSources: [],
      tools: [],
      mcpServers: {},
      resume,
      thinking: { type: 'disabled' },
      model: 'claude-sonnet-4-6',
      abortController: abort,
      pathToClaudeCodeExecutable: process.env.AEGIS_TEST_CLAUDE_BINARY || 'claude',
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              async (e) => {
                await ctrl.attachTranscript(e.transcript_path);
                return {};
              },
            ],
          },
        ],
      },
    },
  });
  let failure;
  const pump = (async () => {
    try {
      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') nativeId = msg.session_id;
        if (process.env.GOAL_DEBUG && msg.type !== 'system')
          console.log('WIRE', JSON.stringify(msg).slice(0, 1400));
        if (!(await ctrl.receive(msg))) {
          messages.push(msg);
          if (reinterrupt > 0 && msg.type === 'result') {
            reinterrupt--;
            void ctrl.interrupt().catch(() => {});
          }
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) {
        failure = e;
        if (process.env.GOAL_DEBUG) console.error('PUMP', e);
      }
    } finally {
      ctrl.dispose(failure);
    }
  })();
  const ready = ctrl.initialize({
    commands: () => q.supportedCommands(),
    send,
    interrupt: () => q.interrupt(),
    abort: () => abort.abort(),
  });
  await ready;
  const instance = {
    ctrl,
    snapshots,
    messages,
    get nativeId() {
      return nativeId;
    },
    get failure() {
      return failure;
    },
    setReinterrupt(value) {
      reinterrupt = value;
    },
    submit: async (text) => {
      const prepared = await ctrl.prepare(text);
      ctrl.submitted(prepared);
      send(prepared);
    },
    async stop() {
      ctrl.dispose();
      abort.abort();
      done = true;
      wake?.();
      q.close();
      await pump;
      if (failure) throw failure;
    },
  };
  all.push(instance);
  return instance;
}
try {
  const first = await start();
  assert.equal(first.ctrl.snapshot.supported, true, 'installed runtime advertises native goal');
  await first.submit('/goal Output JSON with ok true');
  await until(() => first.ctrl.snapshot.goal?.status === 'complete', 'native completion');
  assert.ok(first.ctrl.snapshot.goal.claude.iterations >= 2);
  assert.ok(requests >= 4, 'Claude natively continued after a not-yet-met check');
  assert.equal(
    first.messages.some((m) => m.local_command_source?.includes('Goal set:')),
    false,
    'command receipt stays out of chat',
  );
  console.log('native set + Stop-hook completion passed');

  hold = true;
  await first.submit('/goal Keep this goal pending until the user stops it');
  await until(() => first.ctrl.snapshot.goal?.status === 'active', 'active goal');
  await first.submit('Queued before Stop');
  first.setReinterrupt(true);
  await first.ctrl.interrupt().catch((error) => {
    assert.equal(first.ctrl.isClosed, true, 'a failed native stop closes the owned stream');
  });
  first.setReinterrupt(false);
  assert.equal(first.ctrl.snapshot.goal.status, 'paused');
  if (!first.ctrl.isClosed) {
    await until(
      async () =>
        (await readFile(first.ctrl.snapshot.transcriptPath, 'utf8')).includes(
          '"met":true,"sentinel":true,"condition":"Keep this goal',
        ),
      'native pause transcript flush',
    );
    const transcript = await readFile(first.ctrl.snapshot.transcriptPath, 'utf8');
    const goalRecords = transcript
      .split('\n')
      .filter(Boolean)
      .map((x) => JSON.parse(x))
      .filter((x) => x.attachment?.type === 'goal_status');
    assert.equal(goalRecords.at(-1).attachment.sentinel, true);
    assert.equal(
      goalRecords.at(-1).attachment.met,
      true,
      'pause really clears the native Stop hook',
    );
  }
  const saved = first.ctrl.snapshot;
  const id = first.nativeId;
  await first.stop().catch((error) => assert.match(error.message, /session_crash|AbortError/));
  const beforeBoot = requests;
  const second = await start(saved, id);
  assert.equal(second.ctrl.snapshot.goal.status, 'paused');
  assert.equal(requests, beforeBoot, 'restart preflight never starts inference');
  hold = false;
  const beforeFollowup = requests;
  await second.submit('An ordinary follow-up');
  await until(() => second.messages.some((m) => m.type === 'result'), 'ordinary follow-up');
  await sleep(150);
  assert.equal(requests - beforeFollowup, 1, 'ordinary message after pause has no Goal evaluator');
  assert.equal(second.ctrl.snapshot.goal.status, 'paused');
  await second.submit('/goal Output JSON with ok true');
  await until(() => second.ctrl.snapshot.goal?.status === 'complete', 'resume completed');
  await second.ctrl.change({ type: 'clear' });
  assert.equal(second.ctrl.snapshot.goal, null);
  console.log('native pause, restart, ordinary follow-up, resume and clear passed');

  hold = true;
  const long = '长目标😀'.repeat(1300);
  await second.submit(`/goal ${long}`);
  await until(() => second.ctrl.snapshot.goal?.status === 'active', 'long goal');
  assert.equal(second.ctrl.snapshot.goal.displayObjective, long);
  assert.ok(second.ctrl.snapshot.goal.objective.length < 4000);
  await second.ctrl.interrupt();
  console.log('native long objective passed');
  hold = false;
  const beforeRestricted = requests;
  const restricted = await start(undefined, undefined, { disableAllHooks: true });
  await restricted.submit('/goal This must be rejected by native hook policy');
  await until(() => restricted.failure, 'native hook policy rejection');
  assert.match(restricted.failure.message, /hooks are restricted/);
  assert.equal(restricted.ctrl.snapshot.goal, null);
  assert.equal(requests, beforeRestricted, 'a denied goal never reaches inference');
  console.log('native hook-policy rejection passed');
} catch (e) {
  console.error(
    'GOAL DEBUG',
    requests,
    all.map((i) => ({
      state: i.ctrl.snapshot,
      messages: i.messages
        .map((m) => ({
          type: m.type,
          subtype: m.subtype,
          result: m.result,
          source: m.local_command_source,
          content: m.message?.content,
        }))
        .slice(-6),
    })),
  );
  throw e;
} finally {
  for (const i of all.reverse()) await i.stop().catch(() => {});
  for (const res of responses) res.destroy();
  await new Promise((r) => server.close(r));
  await rm(root, { recursive: true, force: true });
}
