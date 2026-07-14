#!/usr/bin/env node
// Fake `codex app-server` for verify-codex-app-server.mjs. Speaks newline-
// delimited JSON-RPC on stdio. Behavior switches via FAKE_CODEX_MODE:
//   normal            — handshake + threads + turns; turn/interrupt emits
//                       turn/completed(status=interrupted)
//   silent            — never answers anything (initialize timeout fixture)
//   crash-after-turn  — accepts turn/start, then exits mid-turn
//   crash-on-turn     — exits on turn/start WITHOUT responding (pending-
//                       rejection fixture)
import * as readline from 'node:readline';

const mode = process.env.FAKE_CODEX_MODE || 'normal';

if (mode === 'silent') {
  // Swallow stdin forever.
  readline.createInterface({ input: process.stdin }).on('line', () => {});
} else {
  const rl = readline.createInterface({ input: process.stdin });
  const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const respond = (id, result) => write({ jsonrpc: '2.0', id, result });
  const notify = (method, params) => write({ jsonrpc: '2.0', method, params });

  let threadCounter = 0;
  let turnCounter = 0;
  const activeTurnByThread = new Map();

  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || msg.id === undefined || !msg.method) return;

    switch (msg.method) {
      case 'initialize':
        respond(msg.id, { userAgent: 'fake-codex', codexHome: '/tmp/fake-codex-home' });
        return;
      case 'thread/start': {
        threadCounter += 1;
        const threadId = `fake-thread-${threadCounter}`;
        respond(msg.id, {
          thread: { id: threadId, model: 'fake-model' },
          model: 'fake-model',
          cwd: msg.params?.cwd || '/tmp',
        });
        return;
      }
      case 'thread/resume': {
        respond(msg.id, {
          thread: { id: msg.params?.threadId, model: 'fake-model' },
          model: 'fake-model',
          cwd: msg.params?.cwd || '/tmp',
        });
        return;
      }
      case 'model/list':
        respond(msg.id, {
          items: [
            {
              id: 'fake-model',
              model: 'fake-model',
              displayName: 'Fake Model',
              hidden: false,
              serviceTiers: [
                { id: 'standard', name: 'Standard', description: '' },
                { id: 'priority', name: 'Priority', description: 'fast' },
              ],
              defaultServiceTier: 'standard',
              supportedReasoningEfforts: [],
              defaultReasoningEffort: 'medium',
            },
          ],
          nextCursor: null,
        });
        return;
      case 'turn/start': {
        if (mode === 'crash-on-turn') {
          // Die without answering — the client's pending RPC must be rejected
          // by its crash handling, not by the request timeout.
          process.exit(1);
        }
        turnCounter += 1;
        const turnId = `fake-turn-${turnCounter}`;
        const threadId = msg.params?.threadId;
        activeTurnByThread.set(threadId, turnId);
        respond(msg.id, { turn: { id: turnId, status: 'inProgress' } });
        notify('turn/started', { threadId, turn: { id: turnId } });
        if (mode === 'crash-after-turn') {
          setTimeout(() => process.exit(1), 30);
        }
        return;
      }
      case 'turn/interrupt': {
        const threadId = msg.params?.threadId;
        const turnId = msg.params?.turnId;
        respond(msg.id, {});
        setTimeout(() => {
          notify('turn/completed', {
            threadId,
            turn: { id: turnId, status: 'interrupted', error: null },
          });
        }, 20);
        return;
      }
      default:
        write({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `fake: unsupported ${msg.method}` },
        });
    }
  });
}

// Keep the process alive until stdin closes.
process.stdin.on('close', () => process.exit(0));
