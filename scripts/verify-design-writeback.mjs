#!/usr/bin/env node
// Verifies the design-mode write-back engine: the pure logic layer
// (tailwind mapping, source location, surgical edits, reverse patches,
// write queue) plus wiring assertions as the service/UI pieces land.

import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();

// ── Source presence assertions ───────────────────────────────────────────────
const requiredModules = [
  'src/electron/libs/design-writeback/tailwind-map.ts',
  'src/electron/libs/design-writeback/source-locator.ts',
  'src/electron/libs/design-writeback/write-plan.ts',
  'src/electron/libs/design-writeback/patch.ts',
  'src/electron/libs/design-writeback/file-write-queue.ts',
];
for (const modulePath of requiredModules) {
  assert.ok(fs.existsSync(path.join(root, modulePath)), `${modulePath} must exist`);
}

const patchSrc = fs.readFileSync(path.join(root, 'src/electron/libs/design-writeback/patch.ts'), 'utf8');
assert.ok(
  !patchSrc.includes('writeFileSync') && patchSrc.includes('applyReversePatch'),
  'patch layer is pure and reverse-patch based (no whole-file snapshot restore)'
);

const planSrc = fs.readFileSync(path.join(root, 'src/electron/libs/design-writeback/write-plan.ts'), 'utf8');
assert.ok(
  planSrc.includes('reversePatch') && planSrc.includes('removedClasses') && planSrc.includes('alsoAffects'),
  'write plan carries verification expectations (added/removed classes, co-changes)'
);

// ── Wiring assertions (service / IPC / UI) ───────────────────────────────────
const serviceSrc = fs.readFileSync(path.join(root, 'src/electron/design-mode-service.ts'), 'utf8');
assert.ok(
  serviceSrc.includes('__aegisDesignStripPreview') && serviceSrc.includes('sanitySuspect'),
  'service: verification must strip the preview first and carry the sanity flag (red-team A1)'
);
assert.ok(
  serviceSrc.includes('enqueueFileWrite') && !serviceSrc.includes('copyFileSync'),
  'service: all writes go through the per-path queue; no snapshot copies'
);
assert.ok(
  serviceSrc.includes('validatePath') && serviceSrc.includes('isLocalhostUrl'),
  'service: untrusted-path validation + localhost gate present'
);
assert.ok(
  serviceSrc.includes('setSessionPinned'),
  'service: design mode pins the browser session against suspend'
);

const inspectorSrc = fs.readFileSync(
  path.join(root, 'src/electron/libs/design-writeback/inspector-script.ts'),
  'utf8'
);
assert.ok(
  inspectorSrc.includes('data-aegis-preview') && inspectorSrc.includes('__aegisDesignDrain'),
  'inspector: marked preview patches + poll-drain event channel (no CDP debugger)'
);
assert.ok(
  !serviceSrc.includes('.debugger.attach') && !inspectorSrc.includes('.debugger.attach('),
  'design mode stays CDP-free (DevTools mutex risk eliminated by design)'
);

const ipcSrc = fs.readFileSync(path.join(root, 'src/electron/design-mode-ipc.ts'), 'utf8');
assert.ok(ipcSrc.includes('DESIGN_CHANNELS') && ipcSrc.includes('registerDesignModeIpc'), 'ipc module follows browser-ipc pattern');
assert.ok(
  fs.readFileSync(path.join(root, 'src/electron/main.ts'), 'utf8').includes('registerDesignModeIpc'),
  'main.ts registers design mode IPC'
);
assert.ok(
  fs.readFileSync(path.join(root, 'src/electron/preload.cts'), 'utf8').includes('designMode:'),
  'preload exposes designMode bridge'
);

const drawerSrc = fs.readFileSync(path.join(root, 'src/ui/components/browser/DesignDrawer.tsx'), 'utf8');
assert.ok(
  drawerSrc.includes('requestChatInjection') && drawerSrc.includes('Apply via agent'),
  'drawer: agent lane is a first-class Apply variant, not a dead end'
);
const panelSrc = fs.readFileSync(path.join(root, 'src/ui/components/browser/BrowserPanel.tsx'), 'utf8');
assert.ok(
  panelSrc.includes('<DesignDrawer') && panelSrc.includes('toggleDesignMode'),
  'browser panel hosts the drawer inline (NOT a sibling utility tab — review blocker #2)'
);

// ── Behavioral tests (compiled + run) ────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-design-'));
const tscBin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');

const testFiles = [
  'scripts/tests/design-writeback.test.ts',
  'scripts/tests/design-verify.test.ts',
];

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
  assert.equal(compile.status, 0, 'design-writeback test compile failed');

  for (const testFile of testFiles) {
    const jsPath = path.join(tmpDir, testFile.replace(/\.ts$/, '.js'));
    const run = spawnSync(process.execPath, [jsPath], {
      cwd: root,
      stdio: 'inherit',
      // Compiled output lives in tmp — point require() back at the repo's deps.
      env: { ...process.env, NODE_PATH: path.join(root, 'node_modules') },
    });
    assert.equal(run.status, 0, `${testFile} failed`);
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('verify-design-writeback: OK');
