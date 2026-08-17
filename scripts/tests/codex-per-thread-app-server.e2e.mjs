// Focused real-Codex E2E for the Aegis-thread/App-Server ownership boundary.
//
// Codex may persist project metadata while starting a thread, so the entire
// runtime profile is redirected into this test's temporary directory. This is
// test containment only; production profile behavior is intentionally outside
// the scope of the per-thread process split.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '../..');
const testRoot = mkdtempSync(path.join(tmpdir(), 'aegis-codex-per-thread-e2e-'));
const testHome = path.join(testRoot, 'home');
const codexHome = path.join(testRoot, 'codex-home');
const codexSqliteHome = path.join(testRoot, 'codex-sqlite');
const workspace = path.join(testRoot, 'workspace');

mkdirSync(testHome, { recursive: true });
mkdirSync(codexHome, { recursive: true });
mkdirSync(codexSqliteHome, { recursive: true });
mkdirSync(workspace, { recursive: true });

// Set all profile paths before loading the compiled adapter and its settings
// dependencies, which resolve environment-backed paths at module load time.
process.env.HOME = testHome;
process.env.CODEX_HOME = codexHome;
process.env.CODEX_SQLITE_HOME = codexSqliteHome;
process.env.AEGIS_CODEX_MCP_CONFIG_PATH = path.join(testRoot, 'aegis-codex-config.toml');
process.env.AEGIS_CODEX_INITIALIZE_TIMEOUT_MS = '30000';
process.env.AEGIS_CODEX_REQUEST_TIMEOUT_MS = '30000';

function resolveCodexBinary() {
  if (process.env.AEGIS_E2E_CODEX_BINARY?.trim()) {
    return process.env.AEGIS_E2E_CODEX_BINARY.trim();
  }
  const command = process.platform === 'win32' ? 'where' : 'which';
  return execFileSync(command, ['codex'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
}

const require = createRequire(import.meta.url);
const adapterModule = require(
  path.join(projectRoot, 'dist-electron/electron/libs/provider/codex-adapter.js')
);
const { CodexAdapter } = adapterModule.default ?? adapterModule;
const adapter = new CodexAdapter(resolveCodexBinary());

try {
  await Promise.all([
    adapter.startSession({
      provider: 'codex',
      threadId: 'e2e-thread-a',
      cwd: workspace,
      prompt: '',
    }),
    adapter.startSession({
      provider: 'codex',
      threadId: 'e2e-thread-b',
      cwd: workspace,
      prompt: '',
    }),
  ]);

  const firstPid = adapter.getRuntimeProcessId('e2e-thread-a');
  const secondPid = adapter.getRuntimeProcessId('e2e-thread-b');
  assert.ok(Number.isInteger(firstPid) && firstPid > 0, 'thread A has no live app-server pid');
  assert.ok(Number.isInteger(secondPid) && secondPid > 0, 'thread B has no live app-server pid');
  assert.notEqual(firstPid, secondPid, 'two active Aegis threads share one app-server process');
  assert.equal(adapter.getRuntimeCount(), 2, 'adapter does not own two active thread runtimes');

  await adapter.stopSession('e2e-thread-a');
  assert.equal(adapter.getRuntimeCount(), 1, 'stopped thread A still owns an app-server runtime');
  assert.equal(
    adapter.getRuntimeProcessId('e2e-thread-b'),
    secondPid,
    'stopping thread A replaced or stopped thread B app-server'
  );

  console.log(
    `codex per-thread App Server E2E passed (thread A pid ${firstPid}, thread B pid ${secondPid})`
  );
} finally {
  await adapter.stopAll().catch(() => {});
  rmSync(testRoot, { recursive: true, force: true });
}
