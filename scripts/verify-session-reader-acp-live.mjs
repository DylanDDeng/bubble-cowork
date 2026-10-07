#!/usr/bin/env node
// Live check that ACP agents can read a referenced Aegis conversation
// through read_session — REAL `devin acp` + login, real Aegis
// session MCP server over HTTP, scratch session database.
// Not part of `npm test`: makes small real model requests.
// Run after `npm run transpile:electron`:
//   node scripts/verify-session-reader-acp-live.mjs [devin]
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = process.cwd();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-reader-live-'));
const userData = path.join(scratch, 'user-data');
const cwd = path.join(scratch, 'workspace');
fs.mkdirSync(userData);
fs.mkdirSync(cwd);

const Module = require('module');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === 'electron') {
    return { app: { getPath: () => userData, isPackaged: false }, BrowserWindow: { getAllWindows: () => [] } };
  }
  return originalLoad.call(this, request, ...rest);
};

const dist = (file) => path.join(root, 'dist-electron/electron', file);
const sessions = require(dist('libs/session-store.js'));
const { appendSessionReferences } = require(dist('libs/session-reference.js'));
const { disposeSessionHttpServer } = require(dist('libs/session-http-server.js'));
sessions.initialize();

const codeWord = `AEGIS-${randomBytes(4).toString('hex').toUpperCase()}`;
const source = sessions.createSession({ title: 'Reader live source', cwd, provider: 'claude' });
sessions.addMessage(source.id, { type: 'user_prompt', prompt: 'Remember the release code word for later.', createdAt: Date.now() - 2000 });
sessions.addMessage(source.id, {
  type: 'assistant',
  uuid: randomBytes(8).toString('hex'),
  message: { role: 'assistant', content: [{ type: 'text', text: `Noted. The release code word is ${codeWord}.` }] },
  createdAt: Date.now() - 1000,
});

const providers = {
  devin: { file: 'libs/provider/devin-acp-adapter.js', exportName: 'DevinAcpAdapter', options: {} },
};
const selected = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(providers);

function withTimeout(promise, label, ms = 240_000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function check(provider) {
  const spec = providers[provider];
  if (!spec) throw new Error(`Unknown provider ${provider}`);
  const Adapter = require(dist(spec.file))[spec.exportName];
  const adapter = new Adapter();
  const threadId = `reader-live-${provider}`;
  const events = [];
  adapter.events.on('event', (event) => {
    events.push(event);
    if (event.type === 'permission_request') {
      void adapter.respondToRequest(threadId, event.requestId, { behavior: 'allow', updatedInput: {} });
    }
  });

  // Same prompt shape the composer produces: the user's text with the link,
  // plus the reference block appended for the runner.
  const userPrompt = `What is the release code word in aegis://sessions/${source.id} ? Reply with only the code word.`;
  const runnerPrompt = userPrompt + appendSessionReferences('', userPrompt, undefined, provider);

  try {
    await withTimeout(adapter.startSession({ threadId, cwd, prompt: '', ...spec.options }), `${provider} startSession`, 60_000);
    await withTimeout(adapter.sendTurn({ threadId, prompt: runnerPrompt, ...spec.options }), `${provider} turn`);

    const messages = events.filter((event) => event.type === 'message').map((event) => event.message);
    const blocks = messages
      .filter((message) => message.type === 'assistant')
      .flatMap((message) => (Array.isArray(message.message?.content) ? message.message.content : []));
    const toolNames = [...new Set(blocks.filter((block) => block.type === 'tool_use').map((block) => block.name))];
    const reply = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('');
    const errors = events.filter((event) => event.type === 'error').map((event) => event.error?.message || String(event.error));
    console.log(`[${provider}] tools: ${JSON.stringify(toolNames)}`);
    console.log(`[${provider}] reply: ${JSON.stringify(reply.slice(0, 300))}`);
    if (errors.length) console.log(`[${provider}] errors: ${JSON.stringify(errors)}`);

    assert.ok(toolNames.some((name) => /read_session/.test(String(name))), `${provider} must call read_session`);
    assert.ok(reply.includes(codeWord), `${provider} must answer with the code word read from the conversation`);
    console.log(`[${provider}] read_session OK`);
  } finally {
    await adapter.stopAll?.().catch(() => undefined);
  }
}

let failed = false;
try {
  for (const provider of selected) {
    try {
      await check(provider);
    } catch (error) {
      failed = true;
      console.error(`[${provider}] FAILED: ${error instanceof Error ? error.message : error}`);
    }
  }
} finally {
  disposeSessionHttpServer();
  Module._load = originalLoad;
  fs.rmSync(scratch, { recursive: true, force: true });
}
console.log(failed ? 'session reader live: FAILED' : 'session reader live: all providers passed');
process.exit(failed ? 1 : 0);
