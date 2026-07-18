#!/usr/bin/env node
// Fake `kimi server run --foreground --port <p>` for verify-kimi-server L2.
// Speaks just enough of the pinned 0.26.0 protocol (see the appendix in
// docs/kimi-server-adapter-plan.md): startup banner with the Token line,
// bearer-authed REST /api/v1 with the {code,msg,data} envelope, and the
// /api/v1/ws event stream with subscribe acks, cursors, and seq replay.
//
// Behavior knobs (env):
//   AEGIS_FAKE_KIMI_BEHAVIOR = ok | no-token | malformed-token | delayed-token
//                            | unhealthy | already-running | die-after-prompt
//   AEGIS_FAKE_KIMI_TOKEN    = bearer token to print/expect (default tok_fake)
//   AEGIS_FAKE_KIMI_REAL_PORT= port to report in the already-running refusal

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const PORT = portIndex >= 0 ? Number.parseInt(args[portIndex + 1], 10) : 0;
const BEHAVIOR = process.env.AEGIS_FAKE_KIMI_BEHAVIOR || 'ok';
const TOKEN = process.env.AEGIS_FAKE_KIMI_TOKEN || 'tok_fake';

if (BEHAVIOR === 'already-running') {
  process.stderr.write(
    `server already running (pid=${process.pid}, port=${process.env.AEGIS_FAKE_KIMI_REAL_PORT || PORT}, started=2026-01-01T00:00:00.000Z)\n`
  );
  process.exit(1);
}

// ── In-memory state ─────────────────────────────────────────────────────────
let sessionSeq = 0;
let promptSeq = 0;
const sessions = new Map(); // id -> {seq, epoch, buffer: frame[], busy}
const clients = new Set(); // ws -> {subscriptions:Set}

function nextFrame(sessionId, type, payload, volatile = false) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (!volatile) session.seq += 1;
  const frame = {
    type,
    seq: session.seq,
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    payload: { type, sessionId, agentId: 'main', ...payload },
    epoch: session.epoch,
    ...(volatile ? { volatile: true } : {}),
  };
  if (!volatile) session.buffer.push(frame);
  return frame;
}

function broadcast(sessionId, frame) {
  if (!frame) return;
  for (const [ws, meta] of clientEntries()) {
    if (meta.subscriptions.has(sessionId) && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }
}

const clientMeta = new Map();
function clientEntries() {
  return clientMeta.entries();
}

function emitSequence(sessionId, frames) {
  for (const [type, payload, volatile] of frames) {
    broadcast(sessionId, nextFrame(sessionId, type, payload, volatile));
  }
}

// ── REST ────────────────────────────────────────────────────────────────────
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const respond = (code, data, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code, msg: code === 0 ? 'success' : 'error', data }));
  };

  if (url.pathname === '/api/v1/healthz' || url.pathname === '/healthz') {
    if (BEHAVIOR === 'unhealthy') {
      res.writeHead(500);
      res.end('unhealthy');
      return;
    }
    respond(0, { status: 'ok' });
    return;
  }

  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${TOKEN}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 40100, msg: 'unauthorized', data: null }));
    return;
  }

  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const json = body ? JSON.parse(body) : {};

    if (url.pathname === '/api/v1/sessions' && req.method === 'POST') {
      sessionSeq += 1;
      const id = `session_fake_${sessionSeq}`;
      sessions.set(id, { seq: 1, epoch: `ep_fake_${sessionSeq}`, buffer: [], busy: false });
      respond(0, { id, metadata: json.metadata || {} });
      return;
    }
    if (url.pathname === '/api/v1/config') {
      respond(0, { default_model: 'fake-default-model' });
      return;
    }
    if (url.pathname === '/api/v1/models') {
      respond(0, { items: [{ provider: 'fake', model: 'fake-default-model', max_context_size: 100000 }] });
      return;
    }

    const skillsMatch = /^\/api\/v1\/sessions\/([^/]+)\/skills$/.exec(url.pathname);
    if (skillsMatch && req.method === 'GET') {
      respond(0, {
        skills: [
          { name: 'fake-skill', description: 'A fake skill', path: '/tmp/fake', source: 'user' },
        ],
      });
      return;
    }

    const promptMatch = /^\/api\/v1\/sessions\/([^/]+)\/prompts$/.exec(url.pathname);
    if (promptMatch && req.method === 'POST') {
      const sessionId = promptMatch[1];
      const session = sessions.get(sessionId);
      if (!session) {
        respond(40401, null);
        return;
      }
      if (!json.model) {
        respond(0, { prompt_id: '', status: 'running' });
        emitSequence(sessionId, [
          ['turn.ended', { reason: 'failed', error: { code: 'model.not_configured' } }],
        ]);
        return;
      }
      promptSeq += 1;
      const promptId = `msg_fake_${promptSeq}`;
      const queued = session.busy;
      respond(0, { prompt_id: promptId, status: queued ? 'queued' : 'running' });
      if (BEHAVIOR === 'die-after-prompt') {
        setTimeout(() => process.exit(1), 30);
        return;
      }
      if (!queued) {
        session.busy = true;
        // Scripted mini-turn.
        setTimeout(() => {
          emitSequence(sessionId, [
            ['turn.started', { turnId: promptSeq, origin: { kind: 'user' } }],
            ['assistant.delta', { turnId: promptSeq, delta: 'fake ' }, true],
            ['assistant.delta', { turnId: promptSeq, delta: 'reply' }, true],
            [
              'turn.step.completed',
              {
                turnId: promptSeq,
                usage: { inputOther: 10, output: 2, inputCacheRead: 5, inputCacheCreation: 0 },
                finishReason: 'end_turn',
              },
            ],
            ['turn.ended', { turnId: promptSeq, reason: 'completed', durationMs: 5 }],
            ['prompt.completed', { promptId, reason: 'completed' }],
          ]);
          session.busy = false;
        }, 40);
      }
      return;
    }

    const actionMatch = /^\/api\/v1\/sessions\/([^/]+):(\w+)$/.exec(url.pathname);
    if (actionMatch && req.method === 'POST') {
      const [, sessionId, action] = actionMatch;
      const session = sessions.get(sessionId);
      if (!session) {
        respond(40401, null);
        return;
      }
      if (action === 'abort') {
        respond(0, { aborted: true });
        emitSequence(sessionId, [['turn.ended', { reason: 'cancelled', durationMs: 1 }]]);
        session.busy = false;
        return;
      }
      if (action === 'archive' || action === 'compact' || action === 'undo') {
        respond(0, {});
        if (action === 'compact') {
          setTimeout(() => {
            emitSequence(sessionId, [['event.session.history_compacted', {}]]);
          }, 20);
        }
        return;
      }
      if (action === 'fork') {
        sessionSeq += 1;
        const id = `session_fake_${sessionSeq}`;
        sessions.set(id, { seq: 1, epoch: `ep_fake_${sessionSeq}`, buffer: [], busy: false });
        respond(0, { id });
        return;
      }
      respond(40400, null);
      return;
    }

    // Test control plane.
    if (url.pathname === '/__test/drop-ws' && req.method === 'POST') {
      for (const [ws] of clientEntries()) {
        ws.terminate();
      }
      respond(0, {});
      return;
    }
    if (url.pathname === '/__test/emit' && req.method === 'POST') {
      // {sessionId, frames:[{type,payload,volatile}]} — buffered for replay.
      for (const spec of json.frames || []) {
        broadcast(json.sessionId, nextFrame(json.sessionId, spec.type, spec.payload || {}, spec.volatile));
      }
      respond(0, {});
      return;
    }
    if (url.pathname === '/__test/exit' && req.method === 'POST') {
      respond(0, {});
      setTimeout(() => process.exit(1), 10);
      return;
    }

    respond(40400, null, 200);
  });
});

// ── WS ──────────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/api/v1/ws' });
wss.on('connection', (ws, req) => {
  if ((req.headers.authorization || '') !== `Bearer ${TOKEN}`) {
    ws.close();
    return;
  }
  clientMeta.set(ws, { subscriptions: new Set() });
  ws.on('close', () => clientMeta.delete(ws));
  ws.send(JSON.stringify({ type: 'server_hello', payload: { protocol: 2 } }));
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const meta = clientMeta.get(ws);
    if (!meta) return;
    if (msg.type === 'subscribe') {
      const requested = msg.payload?.session_ids || [];
      const cursors = msg.payload?.cursors || {};
      const accepted = [];
      const notFound = [];
      const resync = [];
      const ackCursors = {};
      for (const sessionId of requested) {
        const session = sessions.get(sessionId);
        if (!session) {
          notFound.push(sessionId);
          continue;
        }
        accepted.push(sessionId);
        meta.subscriptions.add(sessionId);
        ackCursors[sessionId] = { seq: session.seq, epoch: session.epoch };
        const cursor = cursors[sessionId];
        if (cursor && typeof cursor.seq === 'number') {
          if (cursor.epoch !== session.epoch) {
            resync.push({ session_id: sessionId, reason: 'epoch_changed' });
          } else if (session.buffer.length && cursor.seq < session.buffer[0].seq - 1) {
            resync.push({ session_id: sessionId, reason: 'buffer_overflow' });
          } else {
            // Replay everything after the cursor.
            for (const frame of session.buffer) {
              if (frame.seq > cursor.seq) ws.send(JSON.stringify(frame));
            }
          }
        }
      }
      ws.send(
        JSON.stringify({
          type: 'ack',
          id: msg.id || '',
          code: 0,
          msg: 'success',
          payload: { accepted, not_found: notFound, resync_required: resync, cursors: ackCursors },
        })
      );
      return;
    }
    if (msg.type === 'unsubscribe') {
      for (const sessionId of msg.payload?.session_ids || []) {
        meta.subscriptions.delete(sessionId);
      }
      return;
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const emitBanner = () => {
    if (BEHAVIOR === 'no-token') {
      process.stdout.write('\n  Kimi server ready  0.26.0-fake\n\n');
      return;
    }
    if (BEHAVIOR === 'malformed-token') {
      process.stdout.write('\n  Kimi server ready  0.26.0-fake\n  Token:\n\n');
      return;
    }
    process.stdout.write(
      `\n  ▐█▛█▛█▌  Kimi server ready  0.26.0-fake\n\n  Local:    http://127.0.0.1:${PORT}/#token=${TOKEN}\n\n  Token:    ${TOKEN}\n\n  Stop:     kimi server kill\n\n`
    );
  };
  if (BEHAVIOR === 'delayed-token') {
    setTimeout(emitBanner, 800);
  } else {
    emitBanner();
  }
});

process.on('SIGTERM', () => process.exit(0));
