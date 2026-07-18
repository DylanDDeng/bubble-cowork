#!/usr/bin/env node
/**
 * M0 protocol probes for the kimi server runtime (docs/kimi-server-adapter-plan.md).
 *
 * Usage:
 *   node scripts/probe-kimi-server.mjs            # run the cheap probes (no model turn)
 *   node scripts/probe-kimi-server.mjs --with-turn # also run :abort / steer timing probes
 *                                                  # (submits tiny real prompts — costs tokens)
 *
 * Doubles as the post-CLI-upgrade canary: run it after upgrading Kimi Code and
 * diff the report against docs/kimi-server-adapter-plan.md's verified surface.
 */
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const KIMI = process.env.KIMI_CODE_PATH || path.join(homedir(), '.kimi-code', 'bin', 'kimi');
const WITH_TURN = process.argv.includes('--with-turn');
const results = [];

function report(name, outcome, detail) {
  results.push({ name, outcome, detail });
  const mark = outcome === 'ok' ? '✅' : outcome === 'warn' ? '⚠️' : '❌';
  console.log(`${mark} ${name}: ${detail}`);
}

function randPort() {
  return 20000 + Math.floor(Math.random() * 20000);
}

/** Spawn `kimi server run --foreground --port <p>` and wait for the token line. */
async function spawnServer(port, extraArgs = []) {
  const proc = spawn(KIMI, ['server', 'run', '--foreground', '--port', String(port), ...extraArgs], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stdout.on('data', (c) => (stdout += c));
  proc.stderr.on('data', (c) => (stderr += c));
  const deadline = Date.now() + 15000;
  let token = null;
  while (Date.now() < deadline) {
    const match = /(?:token|Token)[^\n]*?([A-Za-z0-9_-]{16,})/.exec(stdout);
    if (match) {
      token = match[1];
      break;
    }
    if (proc.exitCode !== null) break;
    await delay(100);
  }
  return { proc, port, get stdout() { return stdout; }, get stderr() { return stderr; }, token };
}

async function rest(server, method, pathName, body) {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/v1${pathName}`, {
    method,
    headers: {
      authorization: `Bearer ${server.token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}

function killServer(server) {
  try {
    server.proc.kill('SIGTERM');
  } catch {
    /* already dead */
  }
}

/** Open a WS, do the hello handshake, subscribe, and collect events. */
function openWs(server, sessionIds, cursors) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/ws`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    const events = [];
    let subscribeAck = null;
    let serverHello = null;
    const waiters = [];
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'server_hello') {
        serverHello = msg;
        ws.send(JSON.stringify({ type: 'client_hello', payload: {} }));
        ws.send(
          JSON.stringify({
            type: 'subscribe',
            id: 'sub-1',
            payload: { session_ids: sessionIds, ...(cursors ? { cursors } : {}) },
          })
        );
        return;
      }
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', payload: msg.payload }));
        return;
      }
      if (msg.type === 'subscribe_ack' || (msg.id === 'sub-1' && msg.type !== 'ping')) {
        subscribeAck = msg;
        resolve({
          ws,
          events,
          get ack() {
            return subscribeAck;
          },
          get hello() {
            return serverHello;
          },
          waitFor(pred, timeoutMs = 20000) {
            const found = events.find(pred);
            if (found) return Promise.resolve(found);
            return new Promise((res2, rej2) => {
              const t = setTimeout(() => rej2(new Error('waitFor timeout')), timeoutMs);
              waiters.push({ pred, resolve: (e) => (clearTimeout(t), res2(e)) });
            });
          },
        });
        return;
      }
      events.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(msg)) {
          const w = waiters.splice(i, 1)[0];
          w.resolve(msg);
        }
      }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS handshake timeout')), 15000).unref();
  });
}

async function main() {
  console.log(`kimi binary: ${KIMI}`);
  console.log(`kimi version: ${execFileSync(KIMI, ['--version']).toString().trim()}`);

  // ── Probe A: --foreground semantics + token line format ──────────────────
  const portA = randPort();
  const serverA = await spawnServer(portA);
  if (!serverA.token) {
    report('A. token parse', 'fail', `no token in stdout after 15s.\nstdout:\n${serverA.stdout}\nstderr:\n${serverA.stderr}`);
    killServer(serverA);
    process.exit(1);
  }
  report('A. token parse', 'ok', `token=${serverA.token.slice(0, 8)}… stdout line format captured`);
  console.log('--- raw startup stdout (for regex pinning) ---');
  console.log(serverA.stdout);
  console.log('---------------------------------------------');

  const health = await fetch(`http://127.0.0.1:${portA}/healthz`).then(
    (r) => r.status,
    () => 'ECONNREFUSED'
  );
  const healthApi = await fetch(`http://127.0.0.1:${portA}/api/v1/healthz`).then(
    (r) => r.status,
    () => 'ECONNREFUSED'
  );
  report('A. healthz', health === 200 || healthApi === 200 ? 'ok' : 'fail', `/healthz=${health} /api/v1/healthz=${healthApi}`);

  // Child pid == serving pid? Kill the child and see if the port dies.
  const models = await rest(serverA, 'GET', '/models');
  report('A. GET /models', models.status === 200 ? 'ok' : 'fail', `status=${models.status} count=${models.json?.data?.items?.length ?? '?'} sample=${JSON.stringify(models.json?.data)?.slice(0, 200)}`);

  // ── Probe B: session create + REST stub fields ───────────────────────────
  const created = await rest(serverA, 'POST', '/sessions', { metadata: { cwd: process.cwd() } });
  const sid = created.json?.data?.session_id || created.json?.data?.id;
  report('B. POST /sessions', sid ? 'ok' : 'fail', `status=${created.status} id=${sid} raw=${JSON.stringify(created.json)?.slice(0, 300)}`);

  const listed = await rest(serverA, 'GET', '/sessions');
  const listedItem = (listed.json?.data?.items || []).find?.((s) => s.id === sid);
  report('B. GET /sessions stub fields', 'ok', `item=${JSON.stringify(listedItem)?.slice(0, 400)}`);

  // ── Probe C: WS handshake, subscribe ack cursor shape ────────────────────
  const wsA = await openWs(serverA, [sid]);
  report('C. WS subscribe ack', wsA.ack ? 'ok' : 'fail', JSON.stringify(wsA.ack)?.slice(0, 400));
  const cursorFromAck = wsA.ack?.payload?.cursors?.[sid];

  // ── Probe D: ACP ↔ server session-id space visibility ────────────────────
  // server-created id resumable over ACP?
  const acpProbe = await probeAcpResume(sid);
  report('D. server id → ACP resume', acpProbe.ok ? 'ok' : 'warn', acpProbe.detail);
  // ACP-created session visible in server store?
  const acpSid = await probeAcpNewSession();
  if (acpSid) {
    const after = await rest(serverA, 'GET', '/sessions');
    const items = after.json?.data?.items || [];
    const found = items.find?.((s) => s.id === acpSid);
    report('D. ACP id → server store', found ? 'ok' : 'warn', found ? `ACP session ${acpSid} visible via GET /sessions` : `ACP session ${acpSid} NOT in GET /sessions of live daemon (${items.length} items; shared disk store is only re-read at daemon boot)`);
  } else {
    report('D. ACP id → server store', 'warn', 'could not create ACP session (auth?)');
  }

  // ── Probe E: second daemon → the server is a machine-wide singleton ──────
  const portE = randPort();
  const serverE = await spawnServer(portE);
  if (serverE.token) {
    report('E. second daemon', 'warn', 'a second daemon STARTED — singleton semantics changed since 0.26.0!');
  } else {
    const running = /server already running \(pid=(\d+), port=(\d+)/.exec(serverE.stderr);
    report(
      'E. second daemon refused (singleton)',
      running ? 'ok' : 'fail',
      running
        ? `refused with parseable pid=${running[1]} port=${running[2]} — adopt-existing path pinned`
        : `refused with UNPARSEABLE output: ${serverE.stdout} ${serverE.stderr}`
    );
  }
  killServer(serverE);

  // ── Probe F: cursors across daemon restart ───────────────────────────────
  wsA.ws.close();
  killServer(serverA);
  await delay(500);
  const exitedCleanly = serverA.proc.exitCode !== null || serverA.proc.signalCode !== null;
  report('A. SIGTERM stops --foreground child', exitedCleanly ? 'ok' : 'warn', `exitCode=${serverA.proc.exitCode} signal=${serverA.proc.signalCode}`);

  const portF = randPort();
  const serverF = await spawnServer(portF);
  if (serverF.token) {
    report('F. token persistent across restarts', serverF.token === serverA.token ? 'ok' : 'warn', serverF.token === serverA.token ? 'same token' : 'token CHANGED across restart');
    try {
      const wsF = await openWs(serverF, [sid], cursorFromAck ? { [sid]: cursorFromAck } : undefined);
      report('F. resubscribe with pre-restart cursor', 'ok', `ack=${JSON.stringify(wsF.ack)?.slice(0, 400)}`);
      wsF.ws.close();
    } catch (error) {
      report('F. resubscribe with pre-restart cursor', 'warn', String(error));
    }
  }

  // ── Probe G (--with-turn): :abort timing + steer race ────────────────────
  if (WITH_TURN && serverF.token) {
    await probeTurnBehaviors(serverF);
  } else {
    report('G. turn probes', 'warn', 'skipped (pass --with-turn to run; submits tiny real prompts)');
  }

  // cleanup: archive probe sessions
  await rest(serverF, 'POST', `/sessions/${sid}:archive`).catch(() => {});
  killServer(serverF);

  console.log('\n===== PROBE SUMMARY =====');
  for (const r of results) console.log(`${r.outcome.toUpperCase().padEnd(4)} ${r.name}`);
  process.exit(results.some((r) => r.outcome === 'fail') ? 1 : 0);
}

/** Try `kimi acp` session/load|resume with a server-created session id. */
function probeAcpResume(sessionId) {
  return new Promise((resolve) => {
    const proc = spawn(KIMI, ['acp'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    let id = 0;
    const send = (method, params) => {
      id += 1;
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return id;
    };
    const finish = (ok, detail) => {
      try {
        proc.kill('SIGTERM');
      } catch {}
      resolve({ ok, detail });
    };
    const timer = setTimeout(() => finish(false, 'timeout'), 10000);
    let resumeId = null;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          resumeId = send('session/resume', { sessionId, cwd: process.cwd(), mcpServers: [] });
        } else if (msg.id === resumeId) {
          clearTimeout(timer);
          if (msg.error) finish(false, `session/resume error: ${JSON.stringify(msg.error).slice(0, 200)}`);
          else finish(true, `resumed server-created session over ACP: ${JSON.stringify(msg.result).slice(0, 150)}`);
        }
      }
    });
    proc.on('error', () => finish(false, 'spawn error'));
    send('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'aegis-probe', title: 'Aegis probe', version: '0.0.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
  });
}

/** Create a session over ACP and return its id. */
function probeAcpNewSession() {
  return new Promise((resolve) => {
    const proc = spawn(KIMI, ['acp'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    let id = 0;
    const send = (method, params) => {
      id += 1;
      proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return id;
    };
    const finish = (value) => {
      try {
        proc.kill('SIGTERM');
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 10000);
    let newId = null;
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id === 1) {
          newId = send('session/new', { cwd: process.cwd(), mcpServers: [] });
        } else if (msg.id === newId) {
          clearTimeout(timer);
          finish(msg.result?.sessionId || null);
        }
      }
    });
    proc.on('error', () => finish(null));
    send('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'aegis-probe', title: 'Aegis probe', version: '0.0.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
  });
}

/** Live-turn probes: submit → :abort timing; queue + steer race. */
async function probeTurnBehaviors(server) {
  const modelsRes = await rest(server, 'GET', '/models');
  const modelList = modelsRes.json?.data?.items || [];
  const model =
    modelList.find((m) => m.model === 'kimi-for-coding')?.model || modelList[0]?.model;
  if (!model) {
    report('G. turn probes', 'warn', 'no model available from GET /models');
    return;
  }

  // Fresh session on THIS daemon: subscribing to a session id the daemon does
  // not know yields not_found and delivers no events even if the session comes
  // alive later (pinned by the earlier F/G run).
  const createdG = await rest(server, 'POST', '/sessions', { metadata: { cwd: process.cwd() } });
  const sid = createdG.json?.data?.id;
  if (!sid) {
    report('G. turn probes', 'fail', `could not create session: ${createdG.text?.slice(0, 200)}`);
    return;
  }

  const ws = await openWs(server, [sid]);
  report('G. subscribe on live daemon', 'ok', JSON.stringify(ws.ack?.payload)?.slice(0, 200));
  const seenTypes = new Map();
  let dumpIndex = 0;
  const dumpTimer = setInterval(() => {
    for (; dumpIndex < ws.events.length; dumpIndex++) {
      const e = ws.events[dumpIndex];
      const count = (seenTypes.get(e.type) || 0) + 1;
      seenTypes.set(e.type, count);
      if (count <= 2) {
        console.log(`  [ws] seq=${e.seq} ${e.type} ${JSON.stringify(e.payload)?.slice(0, 240)}`);
      }
    }
  }, 200);

  // :abort ack-vs-terminal ordering
  const submit = await rest(server, 'POST', `/sessions/${sid}/prompts`, {
    content: [{ type: 'text', text: 'Count slowly from 1 to 200, one number per line.' }],
    model,
  });
  report('G. prompt submit', submit.status === 200 ? 'ok' : 'fail', `status=${submit.status} data=${JSON.stringify(submit.json?.data)?.slice(0, 200)}`);
  await ws.waitFor((e) => e.type === 'turn.started', 30000).catch(() => null);
  const tAbort = Date.now();
  const abortRes = await rest(server, 'POST', `/sessions/${sid}:abort`);
  const ackMs = Date.now() - tAbort;
  const ended = await ws.waitFor((e) => e.type === 'turn.ended', 30000).catch(() => null);
  const terminalMs = Date.now() - tAbort;
  report(
    'G. :abort ack vs terminal',
    ended ? 'ok' : 'warn',
    `ack=${ackMs}ms (${JSON.stringify(abortRes.json?.data)}) → turn.ended reason=${ended?.payload?.reason} after ${terminalMs}ms`
  );

  // steer race: queue a prompt, let the turn end, then steer the queued prompt
  const submit2 = await rest(server, 'POST', `/sessions/${sid}/prompts`, {
    content: [{ type: 'text', text: 'Reply with exactly: PONG' }],
    model,
  });
  const p2 = submit2.json?.data?.prompt_id;
  // queue while busy
  const submit3 = await rest(server, 'POST', `/sessions/${sid}/prompts`, {
    content: [{ type: 'text', text: 'Reply with exactly: QUEUED' }],
    model,
  });
  const p3 = submit3.json?.data?.prompt_id;
  report('G. queue while busy', 'ok', `p2=${submit2.json?.data?.status} p3=${submit3.json?.data?.status}`);
  // wait for the first turn to end, then steer p3 into a (possibly ended) turn
  await ws.waitFor((e) => e.type === 'turn.ended', 60000).catch(() => null);
  const steerRes = await rest(server, 'POST', `/sessions/${sid}/prompts:steer`, { prompt_ids: [p3] });
  report('G. steer after turn end (race window)', 'ok', `status=${steerRes.status} data=${JSON.stringify(steerRes.json)?.slice(0, 300)}`);
  // drain: wait for remaining turn(s) to finish so archive is clean
  await ws.waitFor((e) => e.type === 'turn.ended' && Date.now() > 0, 60000).catch(() => null);
  clearInterval(dumpTimer);
  console.log(`  [ws] event types seen: ${JSON.stringify(Object.fromEntries(seenTypes))}`);
  ws.ws.close();
  await rest(server, 'POST', `/sessions/${sid}:archive`).catch(() => {});
}

main().catch((error) => {
  console.error('probe crashed:', error);
  process.exit(1);
});
