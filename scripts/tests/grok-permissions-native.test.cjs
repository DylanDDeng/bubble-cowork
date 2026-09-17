// Explicit opt-in native verification. Creates empty temporary sessions, never
// sends a model prompt or edits user/global permission configuration.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { once } = require('node:events');
const { AcpJsonRpcClient } = require('../../dist-electron/electron/libs/provider/acp-json-rpc-client.js');
const { applyGrokPermissionMode, grokPermissionMeta } = require('../../dist-electron/electron/libs/provider/grok-acp-permissions.js');
const { resolveGrokBinary, buildGrokEnv } = require('../../dist-electron/electron/libs/grok-cli.js');

async function withRuntime(binary, cwd, isolated, callback) {
  const proc = spawn(binary, ['agent', ...(isolated ? ['--no-leader'] : []), 'stdio'], {
    cwd, env: buildGrokEnv(), stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stderr.resume();
  // Notifications may contain MCP credentials; intentionally never log them.
  const rpc = new AcpJsonRpcClient(proc, () => {}, request => rpc.respond(request.id, undefined, { code: -32601, message: 'No model/tool calls in this probe' }), () => {});
  const timeout = setTimeout(() => proc.kill('SIGKILL'), 60_000);
  try {
    await rpc.request('initialize', { protocolVersion: 1, clientInfo: { name: 'aegis-permissions-test', version: '1' }, clientCapabilities: {} });
    return await callback(rpc);
  } finally {
    clearTimeout(timeout);
    if (proc.exitCode === null && proc.signalCode === null) {
      const exit = once(proc, 'exit');
      proc.kill('SIGTERM');
      const kill = setTimeout(() => proc.kill('SIGKILL'), 3000);
      await exit;
      clearTimeout(kill);
    }
  }
}
async function readYolo(rpc, sessionId) {
  const response = await rpc.request('_x.ai/sessions/list', {});
  const entry = (response.result ?? response).sessions.find(row => row.sessionId === sessionId);
  assert.ok(entry, 'native session must be present');
  return entry.yolo;
}
async function main() {
  const binary = await resolveGrokBinary();
  assert.ok(binary, 'Install Grok Build before running the native check');
  for (const isolated of [true, false]) {
    const cwd = mkdtempSync(join(tmpdir(), 'aegis-grok-permissions-'));
    try {
      const sessionId = await withRuntime(binary, cwd, isolated, async rpc => {
        const created = await rpc.request('session/new', { cwd, mcpServers: [], _meta: grokPermissionMeta('yolo') });
        assert.equal(await readYolo(rpc, created.sessionId), true, 'native _meta enables YOLO');
        for (const mode of ['yolo', 'default', 'yolo']) {
          await applyGrokPermissionMode(rpc, created.sessionId, mode);
          assert.equal(await readYolo(rpc, created.sessionId), mode === 'yolo');
        }
        return created.sessionId;
      });
      await withRuntime(binary, cwd, isolated, async rpc => {
        await rpc.request('session/resume', { cwd, mcpServers: [], sessionId, _meta: grokPermissionMeta('default') });
        for (const mode of ['default', 'yolo', 'default']) {
          await applyGrokPermissionMode(rpc, sessionId, mode);
          assert.equal(await readYolo(rpc, sessionId), mode === 'yolo');
        }
      });
      console.log(`Native Grok ${isolated ? 'isolated' : 'default transport'}: new, process restart/resume, YOLO on/off passed; no model prompts`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
