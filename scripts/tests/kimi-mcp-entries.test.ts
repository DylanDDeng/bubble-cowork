// Aegis's own Kimi MCP entries: written only to kimi-code's mcp.json with the
// token named by an environment variable (never inline), removed from the
// legacy kimi-cli file, other entries left alone, and removal limited to the
// entry a predicate accepts. Both paths point at temp files.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'aegis-kimi-mcp-'));
process.env.KIMI_CODE_HOME = join(root, 'kimi-code');
process.env.AEGIS_KIMI_LEGACY_MCP_PATH = join(root, 'kimi', 'mcp.json');
const codePath = join(root, 'kimi-code', 'mcp.json');
const legacyPath = join(root, 'kimi', 'mcp.json');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

async function main() {
  const { upsertKimiMcpServerRaw, removeKimiMcpServerRaw } = await import('../../src/electron/libs/kimi-mcp-settings');
  mkdirSync(join(root, 'kimi-code'), { recursive: true });
  mkdirSync(join(root, 'kimi'), { recursive: true });
  const userServer = { command: 'npx', args: ['some-mcp'] };
  writeFileSync(codePath, JSON.stringify({ mcpServers: { mine: userServer }, extra: 1 }));
  writeFileSync(
    legacyPath,
    JSON.stringify({ mcpServers: { mine: userServer, 'aegis-browser': { url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer old' } } } })
  );

  upsertKimiMcpServerRaw('aegis-browser', { url: 'http://127.0.0.1:2/mcp', bearerTokenEnvVar: 'AEGIS_BROWSER_USE_TOKEN', toolTimeoutMs: 45000 });
  const code = read(codePath);
  assert.deepEqual(code.mcpServers['aegis-browser'], { url: 'http://127.0.0.1:2/mcp', bearerTokenEnvVar: 'AEGIS_BROWSER_USE_TOKEN', toolTimeoutMs: 45000 });
  assert.ok(!JSON.stringify(code).includes('Bearer'), 'no token in the file');
  assert.deepEqual(code.mcpServers.mine, userServer, "the user's own entry is untouched");
  assert.equal(code.extra, 1, 'unknown fields are kept');
  const legacy = read(legacyPath);
  assert.equal(legacy.mcpServers['aegis-browser'], undefined, 'the legacy copy (with its token) is removed');
  assert.deepEqual(legacy.mcpServers.mine, userServer);

  // Removal only takes the entry the predicate accepts (another instance may own it).
  removeKimiMcpServerRaw('aegis-browser', (entry) => entry.url === 'http://127.0.0.1:9/mcp');
  assert.ok(read(codePath).mcpServers['aegis-browser'], 'an entry pointing elsewhere stays');
  removeKimiMcpServerRaw('aegis-browser', (entry) => entry.url === 'http://127.0.0.1:2/mcp');
  assert.equal(read(codePath).mcpServers['aegis-browser'], undefined);
  assert.deepEqual(read(codePath).mcpServers.mine, userServer);

  // The retired delegate's loopback copies go from both files.
  for (const path of [codePath, legacyPath]) {
    const file = read(path);
    file.mcpServers['aegis-delegate'] = { url: 'http://127.0.0.1:53637/mcp', headers: { Authorization: 'Bearer t' } };
    writeFileSync(path, JSON.stringify(file));
  }
  removeKimiMcpServerRaw('aegis-delegate', (entry) => /^http:\/\/127\.0\.0\.1:\d+\//.test(entry.url ?? ''));
  assert.equal(read(codePath).mcpServers['aegis-delegate'], undefined);
  assert.equal(read(legacyPath).mcpServers['aegis-delegate'], undefined);

  rmSync(root, { recursive: true, force: true });
  console.log('kimi-mcp-entries: env-var token, kimi-code only, legacy cleanup, owner-checked removal passed');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
