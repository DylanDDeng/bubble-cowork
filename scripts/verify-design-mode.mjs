#!/usr/bin/env node
// Verifies design mode: selection/annotate wiring and the annotate logic
// (crop math + composer text). Design mode is WRITE-FREE by product
// decision — the agent is the only writer of user source files — so this
// also asserts no write-back paths exist.

import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();

// ── Write-free guarantee ─────────────────────────────────────────────────────
const serviceSrc = fs.readFileSync(path.join(root, 'src/electron/design-mode-service.ts'), 'utf8');
assert.ok(
  !serviceSrc.includes('writeFileSync') && !serviceSrc.includes("from 'fs'") && !serviceSrc.includes('from "fs"'),
  'design mode service must not touch the filesystem (write-back removed by product decision)'
);
for (const removed of [
  'src/electron/libs/design-writeback/write-plan.ts',
  'src/electron/libs/design-writeback/tailwind-map.ts',
  'src/electron/libs/design-writeback/verify-loop.ts',
  'src/electron/libs/design-writeback/patch.ts',
  'src/electron/libs/design-writeback/file-write-queue.ts',
  'src/ui/components/browser/DesignDrawer.tsx',
]) {
  assert.ok(!fs.existsSync(path.join(root, removed)), `${removed} must stay deleted`);
}

// ── Wiring assertions ────────────────────────────────────────────────────────
const inspectorSrc = fs.readFileSync(
  path.join(root, 'src/electron/libs/design-writeback/inspector-script.ts'),
  'utf8'
);
assert.ok(
  inspectorSrc.includes("kind: 'annotate'") && inspectorSrc.includes('data-aegis-ui'),
  'inspector: Cursor-style in-page annotate bubble emits through the drain queue'
);
assert.ok(
  !serviceSrc.includes('.debugger.attach') && !inspectorSrc.includes('.debugger.attach('),
  'design mode stays CDP-free (DevTools mutex risk eliminated by design)'
);
assert.ok(
  serviceSrc.includes("kind: 'annotate'") && serviceSrc.includes('measureSelection'),
  'service: forwards annotate submissions and exposes submit-time geometry'
);
assert.ok(
  serviceSrc.includes('setSessionPinned') && serviceSrc.includes('isLocalhostUrl'),
  'service: suspend pin + localhost gate present'
);

const bridgeSrc = fs.readFileSync(path.join(root, 'src/ui/components/browser/DesignAnnotateBridge.tsx'), 'utf8');
assert.ok(
  bridgeSrc.includes('composeAnnotationText') &&
    bridgeSrc.includes('computeAnnotationCrop') &&
    bridgeSrc.includes('measureSelection') &&
    bridgeSrc.includes('requestChatInjection'),
  'bridge: annotate pipeline (capture → submit-time crop → composer)'
);
const panelSrc = fs.readFileSync(path.join(root, 'src/ui/components/browser/BrowserPanel.tsx'), 'utf8');
assert.ok(
  panelSrc.includes('toggleDesignMode') && panelSrc.includes('designContextRef'),
  'browser panel guards in-flight enables against context changes'
);
assert.ok(
  fs.readFileSync(path.join(root, 'src/ui/App.tsx'), 'utf8').includes('<DesignAnnotateBridge'),
  'annotate bridge is app-level so panel unmount cannot drop final-drain annotations'
);
assert.ok(
  fs.readFileSync(path.join(root, 'src/electron/main.ts'), 'utf8').includes('registerDesignModeIpc'),
  'main.ts registers design mode IPC'
);
assert.ok(
  fs.readFileSync(path.join(root, 'src/electron/preload.cts'), 'utf8').includes('designMode:'),
  'preload exposes designMode bridge'
);

// Design-mode annotate must never reload Aegis itself: dev-fixtures are
// excluded from Aegis's own tailwind scan + vite watch, and the main process
// cleans up orphaned native views when the host renderer reloads.
assert.ok(
  fs.readFileSync(path.join(root, 'src/ui/index.css'), 'utf8').includes('@source not "../../dev-fixtures"'),
  'index.css excludes dev-fixtures from tailwind content scan'
);
assert.ok(
  fs.readFileSync(path.join(root, 'vite.config.ts'), 'utf8').includes('dev-fixtures/**'),
  'vite config ignores dev-fixtures in server watch'
);
assert.ok(
  fs.readFileSync(path.join(root, 'src/electron/browserManager.ts'), 'utf8').includes('handleHostRendererReload'),
  'browserManager resets native views on host renderer reload (orphan WebContentsView fix)'
);

// ── Behavioral tests (compiled + run) ────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-design-'));
const tscBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

const testFiles = ['scripts/tests/design-annotate.test.ts'];

try {
  const compile = spawnSync(
    tscBin,
    [
      '--target', 'ES2022',
      '--module', 'CommonJS',
      '--moduleResolution', 'Node',
      '--skipLibCheck',
      '--esModuleInterop',
      '--strict',
      '--outDir', tmpDir,
      ...testFiles,
    ],
    { cwd: root, stdio: 'inherit' }
  );
  assert.equal(compile.status, 0, 'design test compile failed');

  for (const testFile of testFiles) {
    const jsPath = path.join(tmpDir, testFile.replace(/\.ts$/, '.js'));
    const run = spawnSync(process.execPath, [jsPath], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, NODE_PATH: path.join(root, 'node_modules') },
    });
    assert.equal(run.status, 0, `${testFile} failed`);
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('verify-design-mode: OK');
