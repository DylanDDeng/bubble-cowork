#!/usr/bin/env node
/**
 * v2 probes for docs/kimi-server-fixes-plan.md (Phase 0, probes 1/2/4/5/7).
 * Self-contained sibling of probe-kimi-server.mjs; submits tiny real prompts
 * (costs tokens). Spawns its OWN daemon on a random port and kills it after.
 *
 *   node scripts/probe-kimi-server-v2.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const KIMI = process.env.KIMI_CODE_PATH || path.join(homedir(), '.kimi-code', 'bin', 'kimi');
const results = [];

function report(name, outcome, detail) {
  results.push({ name, outcome, detail });
  const mark = outcome === 'ok' ? '✅' : outcome === 'warn' ? '⚠️' : '❌';
  console.log(`${mark} ${name}: ${detail}`);
}

function randPort() {
  return 20000 + Math.floor(Math.random() * 20000);
}

async function spawnServer(port) {
  const proc = spawn(KIMI, ['server', 'run', '--foreground', '--port', String(port)], {
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
  let adoptedPort = null;
  while (Date.now() < deadline) {
    const running = /server already running \(pid=\d+, port=(\d+)/.exec(stderr);
    if (running) {
      adoptedPort = Number.parseInt(running[1], 10);
      try {
        token = readFileSync(path.join(homedir(), '.kimi-code', 'server.token'), 'utf8').trim() || null;
      } catch {
        token = null;
      }
      break;
    }
    const match = /(?:token|Token)[^\n]*?([A-Za-z0-9_-]{16,})/.exec(stdout);
    if (match) {
      token = match[1];
      break;
    }
    if (proc.exitCode !== null) break;
    await delay(100);
  }
  if (!token) {
    try {
      token = readFileSync(path.join(homedir(), '.kimi-code', 'server.token'), 'utf8').trim() || null;
    } catch {
      /* none */
    }
  }
  return {
    proc,
    pid: proc.pid,
    port: adoptedPort ?? port,
    adopted: adoptedPort !== null,
    get stderr() { return stderr; },
    token,
  };
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

function openWs(server, sessionIds) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/ws`, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    const events = [];
    const waiters = [];
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.type === 'server_hello') {
        ws.send(JSON.stringify({ type: 'client_hello', payload: {} }));
        ws.send(JSON.stringify({ type: 'subscribe', id: 'sub-1', payload: { session_ids: sessionIds } }));
        return;
      }
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', payload: msg.payload }));
        return;
      }
      if (msg.id === 'sub-1') {
        resolve({
          ws,
          events,
          waitFor(pred, timeoutMs = 30000) {
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

async function pickModel(server) {
  const modelsRes = await rest(server, 'GET', '/models');
  const modelList = modelsRes.json?.data?.items || [];
  return modelList.find((m) => m.model === 'kimi-for-coding')?.model || modelList[0]?.model;
}

async function main() {
  const scratch = mkdtempSync(path.join(tmpdir(), 'kimi-probe-v2-'));
  writeFileSync(path.join(scratch, 'alpha.txt'), 'alpha contents\n');
  writeFileSync(path.join(scratch, 'beta.txt'), 'beta contents\n');

  const server = await spawnServer(randPort());
  if (!server.token) {
    report('spawn', 'fail', `no token; stderr=${server.stderr.slice(0, 300)}`);
    process.exit(1);
  }
  report('spawn', 'ok', `port=${server.port} adopted=${server.adopted} pid=${server.pid}`);
  const model = await pickModel(server);
  report('model', model ? 'ok' : 'fail', String(model));

  // ── Probe 1: :abort vs a queued prompt; does the queue drain or auto-advance? ──
  {
    const created = await rest(server, 'POST', '/sessions', { metadata: { cwd: scratch } });
    const sid = created.json?.data?.id;
    const ws = await openWs(server, [sid]);
    const a = await rest(server, 'POST', `/sessions/${sid}/prompts`, {
      content: [{ type: 'text', text: 'Count slowly from 1 to 100, one number per line.' }],
      model,
    });
    await ws.waitFor((e) => e.type === 'turn.started');
    const b = await rest(server, 'POST', `/sessions/${sid}/prompts`, {
      content: [{ type: 'text', text: 'Reply with exactly: B-RAN' }],
      model,
    });
    const bId = b.json?.data?.prompt_id;
    report('P1 queue', 'ok', `a=${a.json?.data?.status} b=${b.json?.data?.status} bId=${bId}`);

    // Discover a dequeue route before aborting (harmless 404s if absent).
    const del = await rest(server, 'DELETE', `/sessions/${sid}/prompts/${bId}`);
    const cancel = await rest(server, 'POST', `/sessions/${sid}/prompts/${bId}:cancel`);
    report('P1 dequeue routes', 'ok', `DELETE=${del.status}/${del.json?.code ?? ''} :cancel=${cancel.status}/${cancel.json?.code ?? ''}`);

    const abortRes = await rest(server, 'POST', `/sessions/${sid}:abort`);
    const ended = await ws.waitFor((e) => e.type === 'turn.ended', 30000).catch(() => null);
    // Watch 12s for the queued prompt auto-advancing after the abort.
    const restarted = await ws
      .waitFor((e) => e.type === 'turn.started', 12000)
      .catch(() => null);
    const promptFrames = ws.events
      .filter((e) => e.type?.startsWith('prompt.'))
      .map((e) => `${e.type}:${e.payload?.prompt_id === bId ? 'B' : 'A'}:${e.payload?.status ?? ''}`);
    report(
      'P1 :abort vs queued',
      'ok',
      `abort=${JSON.stringify(abortRes.json?.data)} ended=${ended?.payload?.reason} B-auto-advanced=${Boolean(restarted)} promptFrames=${JSON.stringify(promptFrames)}`
    );
    if (restarted) {
      await ws.waitFor((e) => e.type === 'turn.ended' && ws.events.indexOf(e) > ws.events.indexOf(restarted), 60000).catch(() => null);
    }
    ws.ws.close();
    await rest(server, 'POST', `/sessions/${sid}:archive`).catch(() => {});
  }

  // ── Probe 2: live turn-state field on GET /sessions/{id} ──
  {
    const created = await rest(server, 'POST', '/sessions', { metadata: { cwd: scratch } });
    const sid = created.json?.data?.id;
    const ws = await openWs(server, [sid]);
    await rest(server, 'POST', `/sessions/${sid}/prompts`, {
      content: [{ type: 'text', text: 'Count slowly from 1 to 60, one number per line.' }],
      model,
    });
    await ws.waitFor((e) => e.type === 'turn.started');
    const during = await rest(server, 'GET', `/sessions/${sid}`);
    await rest(server, 'POST', `/sessions/${sid}:abort`);
    await ws.waitFor((e) => e.type === 'turn.ended', 30000).catch(() => null);
    await delay(500);
    const after = await rest(server, 'GET', `/sessions/${sid}`);
    report('P2 session detail (running)', 'ok', JSON.stringify(during.json?.data)?.slice(0, 600));
    report('P2 session detail (idle)', 'ok', JSON.stringify(after.json?.data)?.slice(0, 600));
    ws.ws.close();
    await rest(server, 'POST', `/sessions/${sid}:archive`).catch(() => {});
  }

  // ── Probe 4: assistant.delta offset semantics across a tool-call boundary ──
  {
    const created = await rest(server, 'POST', '/sessions', { metadata: { cwd: scratch } });
    const sid = created.json?.data?.id;
    const ws = await openWs(server, [sid]);
    await rest(server, 'POST', `/sessions/${sid}/prompts`, {
      content: [
        {
          type: 'text',
          text:
            'First write one short sentence about listing files. Then use your directory listing tool on the current directory. Then write one short sentence naming the files you saw.',
        },
      ],
      model,
      permission_mode: 'auto',
    });
    await ws.waitFor((e) => e.type === 'turn.ended', 120000).catch(() => null);
    const deltas = ws.events.filter((e) => e.type === 'assistant.delta');
    const tools = ws.events.filter((e) => e.type === 'tool.call.started');
    const trace = deltas.map((e) => ({
      offset: e.offset ?? e.payload?.offset ?? null,
      len: (e.payload?.delta || '').length,
    }));
    let cumulative = 0;
    let perTurn = true;
    let perSegmentResets = 0;
    for (const t of trace) {
      if (t.offset === null) continue;
      if (t.offset === 0 && cumulative > 0) perSegmentResets += 1;
      if (t.offset !== cumulative && t.offset !== null) perTurn = false;
      cumulative += t.len;
    }
    report(
      'P4 offset semantics',
      'ok',
      `deltas=${deltas.length} toolCalls=${tools.length} offsets=${JSON.stringify(trace.slice(0, 12))}${trace.length > 12 ? '…' : ''} monotonic-per-turn=${perTurn} zero-resets-after-start=${perSegmentResets}`
    );
    const messages = await rest(server, 'GET', `/sessions/${sid}/messages`);
    const rows = messages.json?.data?.items || messages.json?.data?.messages || [];
    report(
      'P4 messages rows',
      'ok',
      `count=${rows.length} shapes=${JSON.stringify(rows.map((r) => ({ role: r.role, id: r.id, keys: Object.keys(r) })))?.slice(0, 700)}`
    );
    ws.ws.close();
    await rest(server, 'POST', `/sessions/${sid}:archive`).catch(() => {});
  }

  // ── Probe 5: double-resolve and post-turn (expired) approval resolution ──
  {
    const created = await rest(server, 'POST', '/sessions', { metadata: { cwd: scratch } });
    const sid = created.json?.data?.id;
    const ws = await openWs(server, [sid]);
    await rest(server, 'POST', `/sessions/${sid}/prompts`, {
      content: [{ type: 'text', text: 'Create a file named probe-approval.txt containing the word hello. Use your file tools.' }],
      model,
      permission_mode: 'manual',
    });
    const approval = await ws
      .waitFor((e) => e.type === 'event.approval.requested' || e.type === 'permission.approval.requested', 90000)
      .catch(() => null);
    if (!approval) {
      report('P5 approval', 'warn', 'no approval frame arrived (model may not have used a tool)');
    } else {
      const aid = approval.payload?.approval_id || approval.payload?.tool_call_id;
      const first = await rest(server, 'POST', `/sessions/${sid}/approvals/${aid}`, { decision: 'approved' });
      const second = await rest(server, 'POST', `/sessions/${sid}/approvals/${aid}`, { decision: 'approved' });
      report(
        'P5 double resolve',
        'ok',
        `first=${first.status}/${JSON.stringify(first.json)?.slice(0, 160)} second=${second.status}/${JSON.stringify(second.json)?.slice(0, 200)}`
      );
      await ws.waitFor((e) => e.type === 'turn.ended', 120000).catch(() => null);
      const postTurn = await rest(server, 'POST', `/sessions/${sid}/approvals/${aid}`, { decision: 'rejected' });
      report('P5 post-turn resolve', 'ok', `status=${postTurn.status} body=${JSON.stringify(postTurn.json)?.slice(0, 200)}`);
    }
    ws.ws.close();
    await rest(server, 'POST', `/sessions/${sid}:abort`).catch(() => {});
    await rest(server, 'POST', `/sessions/${sid}:archive`).catch(() => {});
  }

  // ── Probe 7: dead-pidfile behavior (kill -9 our own daemon, then respawn) ──
  if (!server.adopted) {
    let pidfileBefore = '';
    try {
      pidfileBefore = readFileSync(path.join(homedir(), '.kimi-code', 'server'), 'utf8').slice(0, 200);
    } catch (e) {
      pidfileBefore = `unreadable: ${e.code}`;
    }
    process.kill(server.pid, 'SIGKILL');
    await delay(500);
    const second = await spawnServer(randPort());
    report(
      'P7 dead-pidfile respawn',
      'ok',
      `pidfile-before=${JSON.stringify(pidfileBefore)} second-spawn adopted=${second.adopted} token=${Boolean(second.token)} stderr=${second.stderr.slice(0, 200)}`
    );
    try {
      second.proc.kill('SIGTERM');
    } catch {
      /* dead */
    }
  } else {
    report('P7', 'warn', 'daemon was adopted, skipping kill probe');
  }

  try {
    server.proc.kill('SIGTERM');
  } catch {
    /* dead */
  }
  console.log('\nDONE');
  process.exit(0);
}

main().catch((error) => {
  console.error('probe crashed:', error);
  process.exit(1);
});
