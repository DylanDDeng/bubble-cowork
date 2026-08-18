// Real Codex app-server E2E for Aegis Computer Use.
//
// Verifies the structured door: Aegis injects `aegis-computer-use` under a
// non-colliding name, Codex can spawn the signed client, and a read-only
// `list_apps` call authenticates. Mutating tools are not invoked.

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const realHome = homedir();
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '../..');
const testRoot = mkdtempSync(path.join(tmpdir(), 'aegis-codex-computer-use-e2e-'));
const privateCatalog = path.join(testRoot, 'aegis-codex-config.toml');
process.env.AEGIS_CODEX_MCP_CONFIG_PATH = privateCatalog;
mkdirSync(path.join(testRoot, 'home'), { recursive: true });
writeFileSync(
  privateCatalog,
  `[mcp_servers.node_repl]
command = "/Applications/Codex.app/Contents/Resources/cua_node/bin/node_repl"
startup_timeout_sec = 120
`
);

const require = createRequire(import.meta.url);
const settingsMod = require(
  path.join(projectRoot, 'dist-electron/electron/libs/codex-mcp-settings.js')
);
const computerUseMod = require(
  path.join(projectRoot, 'dist-electron/electron/libs/codex-computer-use.js')
);
const { buildCodexMcpConfigOverrideArgs } = settingsMod.default ?? settingsMod;
const computerUse = computerUseMod.default ?? computerUseMod;
const {
  resolveComputerUseClientPath,
  persistComputerUseMedia,
  resolveComputerUseArtifact,
  hydrateComputerUseFramesFromMessages,
  environmentHasComputerUseSection,
} = computerUse;
const elicitationMod = require(
  path.join(projectRoot, 'dist-electron/electron/libs/codex-computer-use-elicitation.js')
);
const grantsMod = require(
  path.join(projectRoot, 'dist-electron/electron/libs/codex-computer-use-grants.js')
);
const { parseMcpToolApprovalElicitation, wrappedComputerUseElicitationFixture } =
  elicitationMod.default ?? elicitationMod;
const { ComputerUseGrantRegistry } = grantsMod.default ?? grantsMod;

{
  const wrapped = parseMcpToolApprovalElicitation(
    'mcpServer/elicitation/request',
    wrappedComputerUseElicitationFixture({
      threadId: 'p-e2e',
      tool: 'click',
      app: 'com.apple.finder',
    })
  );
  assert.equal(wrapped?.grantEligible, true);
  const registry = new ComputerUseGrantRegistry();
  registry.createFromElicitation({ threadId: 't-e2e', generation: 1, elicitation: wrapped });
  assert.ok(registry.match({ threadId: 't-e2e', generation: 1, elicitation: wrapped }));
  const typeText = parseMcpToolApprovalElicitation(
    'mcpServer/elicitation/request',
    wrappedComputerUseElicitationFixture({
      threadId: 'p-e2e',
      tool: 'type_text',
      app: 'com.apple.finder',
    })
  );
  assert.equal(registry.match({ threadId: 't-e2e', generation: 1, elicitation: typeText }), null);
  console.log('codex computer-use grant e2e passed');
}

{
  const jpeg = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBUQEBIVFRUVFRUVFRUVFRUVFRUWFhUVFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDg0OGxAQGy0lHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAbAAACAwEBAQAAAAAAAAAAAAADBAECBQYAB//EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAhEAACAgICAwEBAAAAAAAAAAABAgADEQQSITEFQ Rig/9oACAEBAAE/AN7n/9k=',
    'base64'
  );
  const sessionId = 'e2e-hydrate-session';
  const persisted = persistComputerUseMedia({
    userDataDir: testRoot,
    sessionId,
    payload: [
      { type: 'text', text: 'Notes window' },
      { type: 'input_image', image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}` },
    ],
  });
  assert.equal(persisted.mediaRefs.length, 1);
  const resolved = resolveComputerUseArtifact(testRoot, sessionId, persisted.mediaRefs[0].sha256);
  assert.ok(resolved, 'persisted screenshot must round-trip from disk');

  const frames = hydrateComputerUseFramesFromMessages({
    sessionId,
    messages: [
      {
        type: 'assistant',
        createdAt: 1,
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'u1',
              name: 'mcp__aegis-computer-use__get_app_state',
              input: { app: 'Notes' },
            },
          ],
        },
      },
      {
        type: 'user',
        createdAt: 2,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'u1',
              content: persisted.text,
              mediaRefs: persisted.mediaRefs,
            },
          ],
        },
      },
    ],
  });
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.app, 'Notes');
  assert.equal(frames[0]?.media?.sha256, persisted.mediaRefs[0].sha256);
  assert.equal(environmentHasComputerUseSection({ frames, grants: [] }), true);
  const rebuiltWithoutCopy = { computerUseFrames: [] };
  const preservedAcrossSessionList = { computerUseFrames: frames };
  assert.equal(
    environmentHasComputerUseSection({ frames: rebuiltWithoutCopy.computerUseFrames, grants: [] }),
    false
  );
  assert.equal(
    environmentHasComputerUseSection({ frames: preservedAcrossSessionList.computerUseFrames, grants: [] }),
    true
  );
  console.log('codex computer-use hydrate e2e passed');
}

const clientPath = resolveComputerUseClientPath(realHome);
if (!clientPath) {
  console.log('codex computer-use e2e skipped: SkyComputerUseClient is not installed');
  rmSync(testRoot, { recursive: true, force: true });
  process.exit(0);
}
process.env.AEGIS_COMPUTER_USE_CLIENT_PATH = clientPath;

function resolveCodexBinary() {
  if (process.env.AEGIS_E2E_CODEX_BINARY?.trim()) {
    return process.env.AEGIS_E2E_CODEX_BINARY.trim();
  }
  try {
    return execFileSync(process.platform === 'win32' ? 'where' : 'which', ['codex'], {
      encoding: 'utf8',
    })
      .trim()
      .split(/\r?\n/)[0];
  } catch {
    return null;
  }
}

const binary = resolveCodexBinary();
if (!binary) {
  console.log('codex computer-use e2e skipped: codex binary is not on PATH');
  rmSync(testRoot, { recursive: true, force: true });
  process.exit(0);
}

const overrideArgs = buildCodexMcpConfigOverrideArgs({ computerUsePolicy: 'mutating' });
assert.ok(
  overrideArgs.includes('mcp_servers.computer-use.enabled=false'),
  'colliding computer-use server stays disabled'
);
assert.ok(
  overrideArgs.some((arg) => arg.includes('mcp_servers.aegis-computer-use.command=')),
  'structured aegis-computer-use server is injected'
);
assert.ok(
  overrideArgs.some((arg) => arg.includes('default_tools_approval_mode="writes"')),
  'writes approval mode is set'
);

const child = spawn(binary, ['app-server', ...overrideArgs], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});

let buf = '';
let nextId = 1;
const pending = new Map();
let childExit = null;

child.on('exit', (code, signal) => {
  childExit = { code, signal };
  for (const [id, waiter] of pending) {
    pending.delete(id);
    waiter.reject(new Error(`codex app-server exited before ${id} completed (${code ?? signal})`));
  }
});

child.stderr.on('data', (chunk) => {
  process.stderr.write(`[codex-e2e] ${chunk}`);
});

child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let index;
  while ((index = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, index).trim();
    buf = buf.slice(index + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id != null && msg.method) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} })}\n`);
      continue;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  }
});

function send(method, params, timeoutMs = 90000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    if (childExit) {
      reject(new Error(`${method} skipped: app-server already exited (${childExit.code ?? childExit.signal})`));
      return;
    }
    pending.set(id, { resolve, reject, method });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }
    }, timeoutMs);
  });
}

async function waitForStructuredServer(timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  let lastNames = [];
  while (Date.now() < deadline) {
    const status = await send('mcpServerStatus/list', { detail: 'toolsAndAuthOnly' }, 20000);
    const servers = Array.isArray(status?.data) ? status.data : [];
    lastNames = servers.map((server) => server.name);
    const structured = servers.find((server) => server.name === 'aegis-computer-use');
    const tools = structured?.tools ? Object.keys(structured.tools) : [];
    if (tools.includes('list_apps')) {
      return { servers, structured };
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(
    `aegis-computer-use did not become ready. servers=${lastNames.join(',') || '(none)'}`
  );
}

try {
  await send('initialize', {
    clientInfo: { name: 'aegis', title: 'Aegis', version: '0.0.1' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);

  const { servers, structured } = await waitForStructuredServer();
  const tools = structured.tools ? Object.keys(structured.tools) : [];
  assert.ok(tools.includes('list_apps'), `list_apps missing, have ${tools.join(',')}`);
  assert.ok(tools.includes('click'), 'mutating tools should be present in mutating policy');
  assert.equal(structured.tools.list_apps?.annotations?.readOnlyHint, true);
  assert.equal(structured.tools.click?.annotations?.readOnlyHint, false);

  const colliding = servers.find((server) => server.name === 'computer-use');
  if (colliding) {
    const collidingTools = colliding.tools ? Object.keys(colliding.tools) : [];
    assert.equal(collidingTools.length, 0, 'plugin computer-use must stay disabled');
  }

  const thread = await send('thread/start', { cwd: testRoot });
  const threadId = thread?.threadId ?? thread?.thread?.id ?? thread?.id;
  assert.ok(threadId, 'thread/start did not return an id');

  const result = await send('mcpServer/tool/call', {
    threadId,
    server: 'aegis-computer-use',
    tool: 'list_apps',
    arguments: {},
  });
  const text = (result?.content ?? [])
    .map((item) => (item.type === 'text' ? item.text : ''))
    .join('\n');
  assert.equal(Boolean(result?.isError), false, `list_apps failed: ${text}`);
  assert.match(text, /Finder|Chrome|Codex|ChatGPT/i);

  console.log('codex computer-use e2e passed');
} finally {
  child.kill('SIGKILL');
  rmSync(testRoot, { recursive: true, force: true });
}
