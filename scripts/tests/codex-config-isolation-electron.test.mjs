import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '../..');
const electronBin = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron'
);
const mainPath = path.join(scriptDir, 'codex-config-isolation-electron-main.cjs');

function resolveCodexBinary() {
  if (process.env.AEGIS_E2E_CODEX_BINARY?.trim()) {
    return process.env.AEGIS_E2E_CODEX_BINARY.trim();
  }
  const command = process.platform === 'win32' ? 'where' : 'which';
  return execFileSync(command, ['codex'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
}

function runElectron() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      AEGIS_E2E_CODEX_BINARY: resolveCodexBinary(),
      AEGIS_E2E_NODE_BINARY: process.execPath,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.AEGIS_BROWSER_USE_TEST_MODE;

    const child = spawn(electronBin, [mainPath], {
      cwd: projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Codex config-isolation Electron E2E timed out\n${stdout}\n${stderr}`));
    }, 120_000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Codex config-isolation Electron E2E exited with ${code}\n${stdout}\n${stderr}`));
    });
  });
}

const { stdout, stderr } = await runElectron();
const marker = stdout
  .split('\n')
  .find((line) => line.startsWith('CODEX_CONFIG_ISOLATION_E2E_RESULT:'));
assert.ok(marker, `Electron test did not emit a result marker\n${stdout}\n${stderr}`);

const result = JSON.parse(marker.slice('CODEX_CONFIG_ISOLATION_E2E_RESULT:'.length));
assert.equal(result.ok, true);
assert.equal(result.userConfigContentUnchanged, true);
assert.equal(result.userConfigMtimeUnchanged, true);
assert.equal(result.userConfigInodeUnchanged, true);
assert.equal(result.privateCatalogSeeded, true);
assert.equal(result.privateDelegateWritten, true);
assert.equal(result.privateBrowserWritten, true);
assert.equal(result.sourceOnlyMcpDisabledAtRuntime, true);
assert.equal(result.browserToolHandshake, true);
assert.equal(result.delegateToolHandshake, true);
assert.ok(result.runtimeMcpNames.includes('aegis-browser'));
assert.ok(result.runtimeMcpNames.includes('aegis-delegate'));

console.log(
  'codex config-isolation Electron E2E: private catalog passed ' +
    '(active MCP: aegis-browser, aegis-delegate)'
);
