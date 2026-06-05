#!/usr/bin/env node

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AEGIS_TERMINAL_HISTORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-terminal-history-'));

const {
  DEFAULT_TERMINAL_ID,
  validateTerminalOpenInput,
  validateTerminalResizeInput,
  validateTerminalWriteInput,
} = require('../dist-electron/shared/terminal.js');
const { parseTerminalOsc } = require('../dist-electron/shared/terminal-osc.js');
const {
  capHistoryByLimits,
  readTerminalHistory,
  writeTerminalHistory,
} = require('../dist-electron/electron/libs/terminal-history.js');
const {
  prepareManagedTerminalEnvironment,
} = require('../dist-electron/electron/libs/terminal-agent-wrapper.js');
const {
  ensureTerminalTransportServer,
  disposeTerminalTransportServer,
} = require('../dist-electron/electron/libs/terminal-transport-server.js');
const { disposeTerminalRuntime } = require('../dist-electron/electron/libs/terminal-runtime.js');

async function waitForEvent(events, predicate, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const found = events.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for terminal event.');
}

async function waitForCondition(predicate, timeoutMs = 3000, message = 'Timed out waiting for condition.') {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function readSseEvents(response, output, abortController) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const dataLine = frame
          .split('\n')
          .find((line) => line.startsWith('data: '));
        if (dataLine) {
          try {
            output.push(JSON.parse(dataLine.slice('data: '.length)));
          } catch {
            output.push(dataLine.slice('data: '.length));
          }
        }
        index = buffer.indexOf('\n\n');
      }
    }
  } catch (error) {
    if (!abortController.signal.aborted) throw error;
  }
}

async function postJson(url, token, endpoint, body) {
  const response = await fetch(`${url}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

function validateContract() {
  const open = validateTerminalOpenInput({
    threadId: 'thread-a',
    cwd: process.cwd(),
    cols: 9999,
    rows: -5,
    env: { AEGIS_VALID_ENV: '1' },
  });
  assert.equal(open.ok, true);
  assert.equal(open.value.terminalId, DEFAULT_TERMINAL_ID);
  assert.equal(open.value.cols, 400);
  assert.equal(open.value.rows, 5);

  const badEnv = validateTerminalOpenInput({
    threadId: 'thread-a',
    cwd: process.cwd(),
    env: { '1BAD': 'x' },
  });
  assert.equal(badEnv.ok, false);

  const badResize = validateTerminalResizeInput({
    threadId: 'thread-a',
    terminalId: 'default',
    cols: 10,
    rows: 24,
  });
  assert.equal(badResize.ok, false);

  const badWrite = validateTerminalWriteInput({
    threadId: 'thread-a',
    terminalId: 'default',
    data: 'x'.repeat(65537),
  });
  assert.equal(badWrite.ok, false);
}

function validateHistory() {
  const capped = capHistoryByLimits('a\nb\nc\nd', { lineLimit: 2, byteLimit: 1024 });
  assert.equal(capped, 'c\nd');

  const unicode = '中'.repeat(100);
  const byteCapped = capHistoryByLimits(unicode, { byteLimit: 64, lineLimit: 1000 });
  assert.ok(Buffer.from(byteCapped, 'utf8').length <= 64);
  assert.equal(byteCapped.includes('\ufffd'), false);

  const osc = '\x1b]633;AEGIS_AGENT_EVENT={"agent":"codex","event":"start"}\x07visible';
  const oscCapped = capHistoryByLimits(`prefix${osc}`, { byteLimit: Buffer.byteLength(osc) - 3, lineLimit: 1000 });
  assert.equal(oscCapped.includes('AEGIS_AGENT_EVENT'), false);

  writeTerminalHistory('thread-history', 'one', 'persisted\nvalue');
  assert.equal(readTerminalHistory('thread-history', 'one'), 'persisted\nvalue');
}

function validateOscParser() {
  const state = {};
  const splitA = parseTerminalOsc(state, 'before \x1b]633;AEGIS_AGENT_EVENT={"agent":"claude","event":"start"');
  assert.equal(splitA.output, 'before ');
  assert.equal(splitA.activityEvents.length, 0);
  assert.ok(state.pendingControlSequence);

  const splitB = parseTerminalOsc(state, '}\x07 after');
  assert.equal(splitB.output, ' after');
  assert.deepEqual(splitB.activityEvents, [
    { agent: 'claude', event: 'start', state: 'running', exitCode: null },
  ]);

  const unknown = parseTerminalOsc({}, '\x1b]9;keep-me\x07');
  assert.equal(unknown.output, '\x1b]9;keep-me\x07');

  const invalidAegis = parseTerminalOsc({}, '\x1b]633;AEGIS_AGENT_EVENT=not-json\x07');
  assert.equal(invalidAegis.output, '\x1b]633;AEGIS_AGENT_EVENT=not-json\x07');

  const wrongAgent = parseTerminalOsc(
    {},
    '\x1b]633;AEGIS_AGENT_EVENT={"agent":"codex","event":"start"}\x07',
    { allowedAgent: 'claude' }
  );
  assert.equal(wrongAgent.activityEvents.length, 0);
  assert.equal(wrongAgent.output, '\x1b]633;AEGIS_AGENT_EVENT={"agent":"codex","event":"start"}\x07');

  const stop = parseTerminalOsc({}, '\x1b]633;AEGIS_AGENT_EVENT={"agent":"codex","event":"stop","exitCode":0}\x07');
  assert.deepEqual(stop.activityEvents, [
    { agent: 'codex', event: 'stop', state: 'idle', exitCode: 0 },
  ]);
}

function validateManagedWrapper() {
  if (process.platform === 'win32') return;

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-wrapper-'));
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const command of ['codex', 'claude']) {
    const filePath = path.join(binDir, command);
    fs.writeFileSync(filePath, `#!/bin/sh\nprintf "FAKE_${command}\\n"\n`, { mode: 0o700 });
    fs.chmodSync(filePath, 0o700);
  }

  const prepared = prepareManagedTerminalEnvironment({
    PATH: [binDir, process.env.PATH || ''].filter(Boolean).join(path.delimiter),
    HOME: root,
    TERM: 'xterm-256color',
  });
  assert.equal(prepared.ok, true);
  assert.ok(prepared.wrapperBinDir);
  assert.ok(prepared.zshDotDir);
  assert.equal(prepared.env.PATH.split(path.delimiter)[0], prepared.wrapperBinDir);
  assert.equal(prepared.env.ZDOTDIR, prepared.zshDotDir);
  assert.equal(fs.existsSync(path.join(prepared.wrapperBinDir, 'codex')), true);
  assert.equal(fs.existsSync(path.join(prepared.wrapperBinDir, 'claude')), true);
  assert.equal(fs.existsSync(path.join(prepared.zshDotDir, '.zshenv')), true);

  const codex = spawnSync(path.join(prepared.wrapperBinDir, 'codex'), [], {
    env: prepared.env,
    encoding: 'utf8',
  });
  assert.equal(codex.status, 0);
  assert.equal(codex.stdout.includes('AEGIS_AGENT_EVENT={"agent":"codex","event":"start"}'), true);
  assert.equal(codex.stdout.includes('AEGIS_AGENT_EVENT={"agent":"codex","event":"stop"'), true);
  assert.equal(codex.stdout.includes('FAKE_codex'), true);

  const claude = spawnSync(path.join(prepared.wrapperBinDir, 'claude'), [], {
    env: prepared.env,
    encoding: 'utf8',
  });
  assert.equal(claude.status, 0);
  assert.equal(claude.stdout.includes('AEGIS_AGENT_EVENT={"agent":"claude","event":"start"}'), true);
  assert.equal(claude.stdout.includes('AEGIS_AGENT_EVENT={"agent":"claude","event":"stop"'), true);
  assert.equal(claude.stdout.includes('FAKE_claude'), true);

  fs.rmSync(root, { recursive: true, force: true });
}

async function validateProcessTreeStop(info, events) {
  if (process.platform === 'win32') return;

  const threadId = `validate-process-tree-${Date.now()}`;
  const terminalId = 'tree';
  let childPid = null;
  try {
    const open = await postJson(info.url, info.token, '/terminal/open', {
      threadId,
      terminalId,
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
    });
    assert.equal(open.status, 200);
    assert.equal(open.body.ok, true);

    const nodeCommand = shellQuote(process.execPath);
    const childScript = shellQuote('setTimeout(() => {}, 60000)');
    const write = await postJson(info.url, info.token, '/terminal/write', {
      threadId,
      terminalId,
      data: [
        `${nodeCommand} -e ${childScript} &`,
        'child_pid=$!',
        'printf "AEGIS_TERMINAL_CHILD_PID:%s\\n" "$child_pid"',
        'wait "$child_pid"',
        '',
      ].join('\n'),
    });
    assert.equal(write.status, 200);
    assert.equal(write.body.ok, true);

    const childEvent = await waitForEvent(
      events,
      (event) =>
        event?.type === 'output' &&
        event.threadId === threadId &&
        event.terminalId === terminalId &&
        /AEGIS_TERMINAL_CHILD_PID:\d+/.test(event.data),
      5000
    );
    childPid = Number(childEvent.data.match(/AEGIS_TERMINAL_CHILD_PID:(\d+)/)?.[1]);
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    assert.equal(isProcessAlive(childPid), true);

    const close = await postJson(info.url, info.token, '/terminal/close', { threadId, terminalId });
    assert.equal(close.status, 200);
    assert.equal(close.body.ok, true);

    await waitForCondition(
      () => !isProcessAlive(childPid),
      5000,
      `Terminal close did not terminate descendant process ${childPid}.`
    );
  } finally {
    await postJson(info.url, info.token, '/terminal/close', { threadId, terminalId }).catch(() => {});
    if (childPid && isProcessAlive(childPid)) {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {
        // process may already be gone
      }
    }
  }
}

async function validateTransport() {
  const info = await ensureTerminalTransportServer();
  assert.equal(info.ok, true);
  assert.ok(info.url);
  assert.ok(info.token);

  const unauthorized = await fetch(`${info.url}/terminal/health?token=bad`);
  assert.equal(unauthorized.status, 401);

  const health = await fetch(`${info.url}/terminal/health?token=${encodeURIComponent(info.token)}`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const events = [];
  const abortController = new AbortController();
  const eventResponse = await fetch(
    `${info.url}/terminal/events?token=${encodeURIComponent(info.token)}`,
    { signal: abortController.signal }
  );
  assert.equal(eventResponse.status, 200);
  const eventReader = readSseEvents(eventResponse, events, abortController);

  await waitForEvent(events, (event) => event && event.ok === true);

  const threadId = `validate-terminal-${Date.now()}`;
  const terminalId = 'main';
  const open = await postJson(info.url, info.token, '/terminal/open', {
    threadId,
    terminalId,
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  });
  assert.equal(open.status, 200);
  assert.equal(open.body.ok, true);
  assert.equal(open.body.snapshot.threadId, threadId);
  assert.equal(open.body.snapshot.terminalId, terminalId);
  assert.equal(open.body.snapshot.status, 'running');
  assert.ok(Number.isInteger(open.body.snapshot.pid));

  await waitForEvent(
    events,
    (event) => event?.type === 'started' && event.threadId === threadId && event.terminalId === terminalId,
    5000
  );

  const resize = await postJson(info.url, info.token, '/terminal/resize', {
    threadId,
    terminalId,
    cols: 100,
    rows: 30,
  });
  assert.equal(resize.status, 200);
  assert.equal(resize.body.ok, true);

  const write = await postJson(info.url, info.token, '/terminal/write', {
    threadId,
    terminalId,
    data: [
      'printf "AEGIS_TERMINAL_VALIDATE\\n"',
      'printf "\\033]633;AEGIS_AGENT_EVENT={\\"agent\\":\\"codex\\",\\"event\\":\\"start\\"}\\007"',
      'printf "AEGIS_TERMINAL_AFTER_OSC\\n"',
      'exit',
      '',
    ].join('\n'),
  });
  assert.equal(write.status, 200);
  assert.equal(write.body.ok, true);

  const dataEvent = await waitForEvent(
    events,
    (event) =>
      event?.type === 'output' &&
      event.threadId === threadId &&
      event.terminalId === terminalId &&
      event.data.includes('AEGIS_TERMINAL_VALIDATE'),
    5000
  );
  assert.equal(dataEvent.type, 'output');

  const activityEvent = await waitForEvent(
    events,
    (event) =>
      event?.type === 'activity' &&
      event.threadId === threadId &&
      event.terminalId === terminalId &&
      event.cliKind === 'codex' &&
      event.agentState === 'running',
    5000
  );
  assert.equal(activityEvent.type, 'activity');

  const afterOsc = await waitForEvent(
    events,
    (event) =>
      event?.type === 'output' &&
      event.threadId === threadId &&
      event.terminalId === terminalId &&
      event.data.includes('AEGIS_TERMINAL_AFTER_OSC'),
    5000
  );
  assert.equal(afterOsc.data.includes('\x1b]633;AEGIS_AGENT_EVENT='), false);

  const exitEvent = await waitForEvent(
    events,
    (event) => event?.type === 'exited' && event.threadId === threadId && event.terminalId === terminalId,
    5000
  );
  assert.equal(exitEvent.type, 'exited');

  const replay = await postJson(info.url, info.token, '/terminal/open', {
    threadId,
    terminalId,
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.ok, true);
  assert.equal(replay.body.snapshot.history.includes('AEGIS_TERMINAL_VALIDATE'), true);

  const clear = await postJson(info.url, info.token, '/terminal/clear', { threadId, terminalId });
  assert.equal(clear.status, 200);
  assert.equal(clear.body.ok, true);
  await waitForEvent(
    events,
    (event) => event?.type === 'cleared' && event.threadId === threadId && event.terminalId === terminalId,
    5000
  );

  const closeAfterClear = await postJson(info.url, info.token, '/terminal/close', { threadId, terminalId });
  assert.equal(closeAfterClear.status, 200);
  assert.equal(closeAfterClear.body.ok, true);

  const restartThreadId = `validate-restart-${Date.now()}`;
  const restartTerminalId = 'restart';
  const firstOpen = await postJson(info.url, info.token, '/terminal/open', {
    threadId: restartThreadId,
    terminalId: restartTerminalId,
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  });
  assert.equal(firstOpen.status, 200);
  assert.equal(firstOpen.body.ok, true);

  const restart = await postJson(info.url, info.token, '/terminal/restart', {
    threadId: restartThreadId,
    terminalId: restartTerminalId,
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  });
  assert.equal(restart.status, 200);
  assert.equal(restart.body.ok, true);
  await waitForEvent(
    events,
    (event) =>
      event?.type === 'restarted' &&
      event.threadId === restartThreadId &&
      event.terminalId === restartTerminalId,
    5000
  );

  const restartWrite = await postJson(info.url, info.token, '/terminal/write', {
    threadId: restartThreadId,
    terminalId: restartTerminalId,
    data: 'printf "AEGIS_TERMINAL_RESTART_VALIDATE\\n"\nexit\n',
  });
  assert.equal(restartWrite.status, 200);
  assert.equal(restartWrite.body.ok, true);
  await waitForEvent(
    events,
    (event) =>
      event?.type === 'output' &&
      event.threadId === restartThreadId &&
      event.terminalId === restartTerminalId &&
      event.data.includes('AEGIS_TERMINAL_RESTART_VALIDATE'),
    5000
  );

  await validateProcessTreeStop(info, events);

  const legacySessionId = `legacy-${Date.now()}`;
  const legacyOpen = await postJson(info.url, info.token, '/terminal/start', {
    sessionId: legacySessionId,
    cwd: process.cwd(),
    cols: 80,
    rows: 24,
  });
  assert.equal(legacyOpen.status, 200);
  assert.equal(legacyOpen.body.ok, true);
  const legacyClose = await postJson(info.url, info.token, '/terminal/stop', { sessionId: legacySessionId });
  assert.equal(legacyClose.status, 200);
  assert.equal(legacyClose.body.ok, true);

  abortController.abort();
  await Promise.race([
    eventReader.catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 50)),
  ]);
}

async function main() {
  try {
    validateContract();
    validateHistory();
    validateOscParser();
    validateManagedWrapper();
    await validateTransport();
    console.log('terminal runtime validation passed');
  } finally {
    disposeTerminalTransportServer();
    disposeTerminalRuntime();
    fs.rmSync(process.env.AEGIS_TERMINAL_HISTORY_DIR, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
