#!/usr/bin/env node
// Verification for cross-agent delegation (docs/delegate-mcp-plan.md):
//   L1 static  — the wiring in runner.ts / ipc-handlers.ts / codex-adapter.ts
//                that can't be exercised without a live Electron app.
//   L2 runtime — scripts/tests/delegate-mcp.test.ts (service core + renderer
//                predicates), compiled with tsc and run under node.
//   L3 HTTP    — the real loopback streamable-HTTP MCP server from
//                dist-electron: auth, initialize, tools/list, tools/call.
// Requires `npm run transpile:electron` for L3.

import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();

// ── L1: static wiring guards ────────────────────────────────────────────────

const runnerSource = fs.readFileSync(path.join(root, 'src', 'electron', 'libs', 'runner.ts'), 'utf8');
assert.ok(
  runnerSource.includes('createDelegateMcpServer(session.id)'),
  'runner.ts must inject the delegate MCP server with the parent session id'
);
assert.ok(
  runnerSource.includes('!isDelegateExecutionSession(session.id)'),
  'runner.ts must not inject the delegate server into delegate execution sessions (depth limit)'
);
assert.ok(
  runnerSource.includes('MCP_TOOL_TIMEOUT'),
  'runner.ts must lift the MCP tool timeout above the delegate ceiling'
);

const ipcSource = fs.readFileSync(path.join(root, 'src', 'electron', 'ipc-handlers.ts'), 'utf8');
assert.ok(
  ipcSource.includes('mirrorDelegateMessage(session.id, sanitizedStreamMessage.message)'),
  'ipc-handlers must redirect delegate execution messages into the parent stream'
);
assert.ok(
  ipcSource.includes('hasActiveDelegationForParent(sessionId)'),
  'handleSessionContinue must refuse steering while a delegation is in flight'
);
assert.ok(
  ipcSource.includes('stopDelegationsForParent(sessionId)'),
  'handleSessionStop must cascade to delegate executions'
);
assert.ok(
  ipcSource.includes('delegateTarget?.parentSessionId ?? session.id'),
  'permission requests from delegate executions must route to the parent composer'
);
assert.ok(
  ipcSource.includes('initializeDelegateService('),
  'the delegate service host must be initialized'
);
assert.ok(
  ipcSource.includes('ensureDelegateHttpServer()'),
  'the delegate HTTP transport must be started'
);
assert.ok(
  ipcSource.includes('disposeDelegateHttpServer()'),
  'cleanup must dispose the delegate HTTP server'
);
assert.ok(
  ipcSource.includes('!isDelegateExecutionSession(session.id)') ,
  'environment recap must skip hidden delegate executions'
);

const codexAdapterSource = fs.readFileSync(
  path.join(root, 'src', 'electron', 'libs', 'provider', 'codex-adapter.ts'),
  'utf8'
);
assert.ok(
  codexAdapterSource.includes('mcp__${mcpServer}__${mcpTool}'),
  'codex-adapter must compose Claude-style mcp__server__tool names for mcpToolCall items'
);

const promptInputSource = fs.readFileSync(
  path.join(root, 'src', 'ui', 'components', 'PromptInput.tsx'),
  'utf8'
);
assert.ok(
  promptInputSource.includes('!delegationPending'),
  'the composer steer gate must include the delegation lock'
);

console.log('PASS: static wiring guards');

// ── L2: compiled runtime tests ──────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-delegate-mcp-'));
const tscBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

const compile = spawnSync(
  tscBin,
  [
    '--target', 'ES2022',
    '--module', 'CommonJS',
    '--moduleResolution', 'Node',
    '--jsx', 'react-jsx',
    '--skipLibCheck',
    '--esModuleInterop',
    '--strict',
    '--noEmitOnError', 'true',
    '--outDir', tmpDir,
    'scripts/tests/delegate-mcp.test.ts',
  ],
  { cwd: root, stdio: 'inherit' }
);
if (compile.status !== 0) process.exit(compile.status ?? 1);

const run = spawnSync(
  process.execPath,
  [path.join(tmpDir, 'scripts', 'tests', 'delegate-mcp.test.js')],
  { cwd: root, stdio: 'inherit' }
);
fs.rmSync(tmpDir, { recursive: true, force: true });
if (run.status !== 0) process.exit(run.status ?? 1);

// ── L3: live HTTP transport ─────────────────────────────────────────────────

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-delegate-home-'));
process.env.HOME = fakeHome;
delete process.env.KIMI_CODE_HOME; // must resolve inside the fake home
fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });

const serviceMod = await import(
  path.join(root, 'dist-electron', 'electron', 'libs', 'delegate-service.js')
);
const httpMod = await import(
  path.join(root, 'dist-electron', 'electron', 'libs', 'delegate-http-server.js')
);
const service = serviceMod.default ?? serviceMod;
const httpServer = httpMod.default ?? httpMod;

service.initializeDelegateService({
  startSession: async () => null,
  stopSession: () => {},
  getSession: () => null,
  getSessionHistory: () => [],
  listRunningSessionIds: () => [],
  addMessageToSession: () => {},
});

const info = await httpServer.ensureDelegateHttpServer();
assert.match(info.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/, 'loopback URL');
assert.ok(info.token.length >= 16, 'bearer token present');

// codex config entry written with auth + timeout extras
const codexConfig = fs.readFileSync(path.join(fakeHome, '.codex', 'config.toml'), 'utf8');
assert.ok(codexConfig.includes('[mcp_servers.aegis-delegate]'), 'codex config gets the delegate entry');
assert.ok(codexConfig.includes(`url = "${info.url}"`), 'entry carries the live URL');
assert.ok(codexConfig.includes('bearer_token_env_var = "AEGIS_DELEGATE_TOKEN"'), 'entry references the token env var');
assert.ok(codexConfig.includes('tool_timeout_sec = 2100'), 'entry lifts the codex tool timeout');
assert.equal(process.env.AEGIS_DELEGATE_TOKEN, info.token, 'token exported for spawned CLIs');

// kimi lead entry: BOTH the legacy CLI path (~/.kimi/mcp.json) and the
// kimi-code server runtime path (~/.kimi-code/mcp.json) get the endpoint —
// the daemon only reads the latter.
for (const rel of [['.kimi', 'mcp.json'], ['.kimi-code', 'mcp.json']]) {
  const kimiConfig = JSON.parse(fs.readFileSync(path.join(fakeHome, ...rel), 'utf8'));
  const kimiEntry = kimiConfig.mcpServers?.['aegis-delegate'];
  assert.ok(kimiEntry, `${rel.join('/')} gets the delegate entry`);
  assert.equal(kimiEntry.url, info.url, `${rel.join('/')} carries the live URL`);
  assert.equal(kimiEntry.headers?.Authorization, `Bearer ${info.token}`, `${rel.join('/')} carries the bearer header`);
  assert.equal(
    kimiEntry.toolTimeoutMs,
    2100 * 1000,
    `${rel.join('/')} lifts kimi's MCP tool timeout above the 60s SDK default`
  );
}

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

async function mcpPost(body, withAuth = true) {
  const response = await fetch(info.url, {
    method: 'POST',
    headers: withAuth ? { ...MCP_HEADERS, Authorization: `Bearer ${info.token}` } : MCP_HEADERS,
    body: JSON.stringify(body),
  });
  return response;
}

// Auth: no token → 401
const unauthorized = await mcpPost(
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  false
);
assert.equal(unauthorized.status, 401, 'requests without the bearer token are refused');

// initialize
const initResponse = await mcpPost({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'verify', version: '0.0.0' },
  },
});
assert.equal(initResponse.status, 200, 'initialize succeeds');
const initResult = await initResponse.json();
assert.equal(initResult.result?.serverInfo?.name, 'aegis-delegate', 'server identifies itself');

// tools/list
const listResponse = await mcpPost({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
assert.equal(listResponse.status, 200);
const listResult = await listResponse.json();
const toolNames = (listResult.result?.tools ?? []).map((tool) => tool.name).sort();
assert.deepEqual(
  toolNames,
  ['delegate_status', 'delegate_task'],
  'delegate_task + the two-phase polling tool are exposed'
);

// delegate_status with an unknown handle → tool-level error
const statusResponse = await mcpPost({
  jsonrpc: '2.0',
  id: 5,
  method: 'tools/call',
  params: { name: 'delegate_status', arguments: { handle: 'nope' } },
});
assert.equal(statusResponse.status, 200);
const statusResult = await statusResponse.json();
assert.equal(statusResult.result?.isError, true, 'unknown handle surfaces as a tool error');
assert.match(statusResult.result?.content?.[0]?.text ?? '', /Unknown delegation handle/);

// tools/call with an out-of-enum agent → schema-level validation error the
// model can read (the zod enum rejects before the handler runs)
const badAgentResponse = await mcpPost({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: { name: 'delegate_task', arguments: { agent: 'nonsense', prompt: 'x' } },
});
assert.equal(badAgentResponse.status, 200);
const badAgentResult = await badAgentResponse.json();
assert.equal(badAgentResult.result?.isError, true, 'out-of-enum agent surfaces as a tool error');
assert.match(badAgentResult.result?.content?.[0]?.text ?? '', /Invalid|expected one of/);

// tools/call reaching the handler: empty prompt → service-level rejection
const callResponse = await mcpPost({
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: { name: 'delegate_task', arguments: { agent: 'codex', prompt: '   ' } },
});
assert.equal(callResponse.status, 200);
const callResult = await callResponse.json();
assert.equal(callResult.result?.isError, true, 'empty prompt surfaces as a tool error');
assert.match(callResult.result?.content?.[0]?.text ?? '', /prompt must not be empty/i);

httpServer.disposeDelegateHttpServer();
fs.rmSync(fakeHome, { recursive: true, force: true });
console.log('PASS: HTTP transport (auth, initialize, tools/list, tools/call)');

console.log('\nverify-delegate-mcp: ALL PASS');
