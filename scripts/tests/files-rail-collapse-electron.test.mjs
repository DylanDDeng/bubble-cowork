import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '../..');
const electronBin = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron'
);

function runElectron(mainPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(electronBin, [mainPath], {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Files rail Electron regression timed out\n${stdout}\n${stderr}`));
    }, 30_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(`Files rail Electron regression exited with ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function writeHarness(tmpDir) {
  const harness = `
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectTreePanel } from '/src/ui/components/ProjectTreePanel.tsx';
import '/src/ui/index.css';

window.localStorage.removeItem('cowork.projectFilesRailCollapsed');
window.electron = {};

function rectWidth(selector) {
  return document.querySelector(selector)?.getBoundingClientRect().width ?? null;
}

function Harness() {
  useEffect(() => {
    window.__AegisFilesRailVerify = {
      ready: true,
      toggle: () => document.querySelector('[data-testid="files-tree-toggle"]')?.click(),
      snapshot: () => {
        const panel = document.querySelector('.aegis-project-panel');
        const toggle = document.querySelector('[data-testid="files-tree-toggle"]');
        return {
          toggleLabel: toggle?.getAttribute('aria-label') || null,
          togglePressed: toggle?.getAttribute('aria-pressed') || null,
          storedCollapsed: window.localStorage.getItem('cowork.projectFilesRailCollapsed'),
          gridTemplateColumns: panel ? getComputedStyle(panel).gridTemplateColumns : null,
          panelWidth: rectWidth('.aegis-project-panel'),
          pathBarWidth: rectWidth('[data-testid="files-path-bar"]'),
          previewWidth: rectWidth('[data-testid="files-empty-preview"]'),
          railWidth: rectWidth('[data-testid="files-tree-rail-header"]'),
          pathText: document.querySelector('[data-testid="files-path-bar"]')?.textContent?.trim() || '',
        };
      },
    };
  }, []);

  return (
    <ProjectTreePanel
      activeTab="files"
      collapsed={false}
      embedded
      onClose={() => {}}
      sharedPanelWidth={960}
    />
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
`;

  const main = `
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(win) {
  for (let index = 0; index < 100; index += 1) {
    const ready = await win.webContents.executeJavaScript(
      'Boolean(window.__AegisFilesRailVerify?.ready)',
      true
    );
    if (ready) return;
    await delay(100);
  }
  throw new Error('Files rail harness did not become ready.');
}

async function capture(win, name) {
  const outputDir = process.env.AEGIS_FILES_RAIL_CAPTURE_DIR;
  if (!outputDir) return;
  fs.mkdirSync(outputDir, { recursive: true });
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 960, height: 600 });
  fs.writeFileSync(path.join(outputDir, name), image.toPNG());
}

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: false });
  try {
    await win.loadURL(process.env.AEGIS_FILES_RAIL_VERIFY_URL);
    await waitForReady(win);
    await delay(350);
    await capture(win, 'expanded.png');
    const expanded = await win.webContents.executeJavaScript(
      'window.__AegisFilesRailVerify.snapshot()',
      true
    );
    await win.webContents.executeJavaScript('window.__AegisFilesRailVerify.toggle()', true);
    await delay(350);
    await capture(win, 'collapsed.png');
    const collapsed = await win.webContents.executeJavaScript(
      'window.__AegisFilesRailVerify.snapshot()',
      true
    );
    await win.webContents.executeJavaScript('window.__AegisFilesRailVerify.toggle()', true);
    await delay(350);
    const restored = await win.webContents.executeJavaScript(
      'window.__AegisFilesRailVerify.snapshot()',
      true
    );
    console.log(JSON.stringify({ ok: true, expanded, collapsed, restored }));
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
`;

  await writeFile(
    path.join(tmpDir, 'index.html'),
    '<!doctype html><html><body><div id="root" style="position:relative;width:960px;height:600px"></div><script type="module" src="./harness.tsx"></script></body></html>'
  );
  await writeFile(path.join(tmpDir, 'harness.tsx'), harness);
  await writeFile(path.join(tmpDir, 'electron-main.cjs'), main);
}

async function main() {
  const qaRoot = path.join(projectRoot, '.aegis-design-qa');
  await mkdir(qaRoot, { recursive: true });
  const tmpDir = await mkdtemp(path.join(qaRoot, 'files-rail-collapse-'));
  let server;
  try {
    await writeHarness(tmpDir);
    server = await createServer({
      root: projectRoot,
      configFile: path.join(projectRoot, 'vite.config.ts'),
      server: { host: '127.0.0.1', port: 0, strictPort: false },
    });
    await server.listen();
    const baseUrl = server.resolvedUrls?.local?.[0];
    assert.ok(baseUrl, 'Vite did not report a local URL');
    const harnessPath = path.relative(projectRoot, tmpDir).split(path.sep).join('/');
    const harnessUrl = new URL(`${harnessPath}/index.html`, baseUrl).href;
    if (process.env.AEGIS_FILES_RAIL_PREVIEW === '1') {
      console.log(`Files rail preview: ${harnessUrl}`);
      await new Promise((resolve) => process.once('SIGTERM', resolve));
      return;
    }
    const stdout = await runElectron(path.join(tmpDir, 'electron-main.cjs'), {
      AEGIS_FILES_RAIL_VERIFY_URL: harnessUrl,
      AEGIS_FILES_RAIL_CAPTURE_DIR: process.env.AEGIS_FILES_RAIL_CAPTURE_DIR || '',
    });
    const resultLine = stdout.trim().split('\n').filter(Boolean).pop();
    assert.ok(resultLine, 'Electron did not return Files rail regression results');
    const result = JSON.parse(resultLine);
    assert.equal(result.ok, true);

    assert.equal(result.expanded.toggleLabel, 'Hide file tree');
    assert.equal(result.expanded.togglePressed, 'true');
    assert.equal(result.expanded.pathText, '/');
    assert.ok(result.expanded.railWidth >= 240, 'the file tree must be visible by default');
    assert.ok(result.expanded.previewWidth < result.expanded.panelWidth);
    assert.ok(Math.abs(result.expanded.pathBarWidth - result.expanded.panelWidth) <= 1);

    assert.equal(result.collapsed.toggleLabel, 'Show file tree');
    assert.equal(result.collapsed.togglePressed, 'false');
    assert.equal(result.collapsed.storedCollapsed, '1');
    assert.ok(
      result.collapsed.railWidth <= 1,
      `the file tree must collapse without a selected file: ${JSON.stringify(result.collapsed)}`
    );
    assert.ok(Math.abs(result.collapsed.previewWidth - result.collapsed.panelWidth) <= 1);
    assert.ok(Math.abs(result.collapsed.pathBarWidth - result.collapsed.panelWidth) <= 1);

    assert.equal(result.restored.toggleLabel, 'Hide file tree');
    assert.equal(result.restored.togglePressed, 'true');
    assert.equal(result.restored.storedCollapsed, '0');
    assert.ok(result.restored.railWidth >= 240, 'the same toggle must restore the file tree');
    assert.ok(Math.abs(result.restored.railWidth - result.expanded.railWidth) <= 1);

    console.log('files rail collapse Electron regression passed');
  } finally {
    if (server) await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
}

await main();
