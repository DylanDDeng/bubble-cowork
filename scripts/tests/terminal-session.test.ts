import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IPty } from 'node-pty';
import type { TerminalEvent } from '../../src/shared/terminal';

// Process-tree parsing and PtySession bookkeeping, with a fake pty.
const historyDir = mkdtempSync(path.join(tmpdir(), 'aegis-terminal-session-'));
process.env.AEGIS_TERMINAL_HISTORY_DIR = historyDir;

async function main() {
  const { ProcessTable, agentCliForCommand } = await import('../../src/electron/libs/terminal-process-tree');
  const { PtySession } = await import('../../src/electron/libs/terminal-pty-session');

  // ── ProcessTable ───────────────────────────────────────────────────────────
  const table = ProcessTable.parse(
    [
      '  100     1 /bin/zsh',
      '  200   100 /usr/local/bin/node /opt/codex/bin/codex.js',
      '  201   200 git',
      '  300   100 sleep',
      '  999     1 other',
      'garbage line',
      '  400   201 /bin/sh',
    ].join('\n')
  );
  assert.deepEqual(table.descendants(100).map((p) => p.pid).sort(), [200, 201, 300, 400]);
  assert.deepEqual(table.descendants(999), []);
  assert.deepEqual(table.descendants(12345), []);
  assert.equal(agentCliForCommand('/Users/me/.local/bin/claude'), 'claude');
  assert.equal(agentCliForCommand('codex'), 'codex');
  assert.equal(agentCliForCommand('/opt/homebrew/bin/opencode'), 'opencode');
  assert.equal(agentCliForCommand('/bin/zsh'), null);

  // ── PtySession ─────────────────────────────────────────────────────────────
  const writes: string[] = [];
  const resizes: Array<[number, number]> = [];
  const pty = {
    pid: 4242,
    write: (data: string) => writes.push(data),
    resize: (cols: number, rows: number) => resizes.push([cols, rows]),
    kill: () => undefined,
  } as unknown as IPty;
  const events: TerminalEvent[] = [];
  const session = new PtySession({
    scope: 'scope',
    tabId: 'tab',
    cwd: '/tmp',
    agent: 'shell',
    pty,
    history: 'earlier\r\n',
    launchCommands: {},
    cols: 80,
    rows: 24,
    emit: (event) => events.push(event),
  });
  const ofType = <T extends TerminalEvent['type']>(type: T) =>
    events.filter((event): event is Extract<TerminalEvent, { type: T }> => event.type === type);

  // Output is batched into one event and appended to history; agent OSC is lifted out.
  session.receive('one ');
  session.receive('two \x1b]633;AEGIS_AGENT_EVENT={"agent":"claude","event":"PostToolUse"}\x07three');
  assert.equal(ofType('output').length, 0, 'output waits for the batch window');
  const activity = ofType('activity');
  assert.equal(activity.length, 1);
  assert.equal(activity[0].cliKind, 'claude');
  assert.equal(activity[0].agentState, 'running');
  assert.equal(activity[0].hasRunningSubprocess, true);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(ofType('output').map((event) => event.data), ['one two three']);
  assert.equal(session.snapshot().history, 'earlier\r\none two three');

  // A large burst is sent at once.
  session.receive('x'.repeat(130 * 1024));
  assert.equal(ofType('output').length, 2);

  // History reaches disk shortly after output.
  await new Promise((resolve) => setTimeout(resolve, 80));
  const files = readdirSync(historyDir).filter((file) => file.endsWith('.log'));
  assert.equal(files.length, 1);
  assert.ok(readFileSync(path.join(historyDir, files[0]), 'utf8').startsWith('earlier'));

  // Resizes only reach the pty when the size changes.
  assert.equal(session.resize(80, 24), false);
  assert.equal(session.resize(100, 30), true);
  assert.deepEqual(resizes, [[100, 30]]);
  assert.deepEqual([session.snapshot().cols, session.snapshot().rows], [100, 30]);

  // Polling: a stop event clears the agent; children keep the shell busy.
  session.receive('\x1b]633;AEGIS_AGENT_EVENT={"agent":"claude","event":"stop","exitCode":0}\x07');
  assert.equal(ofType('activity').at(-1)!.agentState, null);
  const before = ofType('activity').length;
  const now = Date.now();
  session.sample([], now + 10 * 60_000);
  assert.equal(ofType('activity').length, before + 0, 'nothing changed: no event');
  session.sample([{ pid: 9, command: 'make' }], now + 10 * 60_000);
  assert.equal(ofType('activity').at(-1)!.hasRunningSubprocess, true);
  assert.equal(session.idle, false);
  session.sample([], now + 10 * 60_000);
  assert.equal(ofType('activity').at(-1)!.hasRunningSubprocess, false);
  assert.equal(session.idle, true);
  // A recently active agent CLI counts as busy between child processes.
  session.receive('working...');
  session.sample([], Date.now());
  assert.equal(ofType('activity').at(-1)!.agentState, 'running');

  // Exit flushes pending output before the exit event and keeps the history.
  session.receive('last words');
  session.exited(0, undefined);
  const tail = events.slice(-2).map((event) => event.type);
  assert.deepEqual(tail, ['output', 'exited']);
  assert.equal(session.snapshot().status, 'exited');
  assert.equal(ofType('exited')[0].exitCode, 0);

  // Clearing empties the history on disk.
  session.clearHistory();
  assert.equal(readFileSync(path.join(historyDir, files[0]), 'utf8'), '');

  session.release();
  console.log('terminal-session.test.ts passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => rmSync(historyDir, { recursive: true, force: true }));
