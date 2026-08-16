import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
const mainPath = path.join(scriptDir, 'browser-use-deepseek-electron-main.cjs');

function runElectron() {
  return new Promise((resolve, reject) => {
    const child = spawn(electronBin, [mainPath], {
      cwd: projectRoot,
      env: { ...process.env, AEGIS_BROWSER_USE_TEST_MODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Browser Use Electron/DeepSeek E2E timed out\n${stdout}\n${stderr}`));
    }, 90_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(`Browser Use Electron/DeepSeek E2E exited with ${code}\n${stdout}\n${stderr}`));
    });
  });
}

const stdout = await runElectron();
const marker = stdout
  .split('\n')
  .find((line) => line.startsWith('BROWSER_USE_E2E_RESULT:'));
assert.ok(marker, `Electron test did not emit a result marker\n${stdout}`);
const result = JSON.parse(marker.slice('BROWSER_USE_E2E_RESULT:'.length));
assert.deepEqual(result, {
  ok: true,
  requestCount: 3,
  exposedBrowserTool: true,
  sawNavigateResult: true,
  sawSnapshotResult: true,
  hiddenRuntimeReleased: true,
  expiredCapabilityRejected: true,
  concurrentSessionIsolation: true,
});

console.log('browser-use DeepSeek Electron E2E: real Harness, MCP and WebContents passed');
