// Coming back to a session remounts its Files panel with no file open until
// the saved tabs are restored (a file read away). A fullscreen preview must
// survive that, while fullscreen with nothing to restore still exits.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const electronBin = path.join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');

const mock = `
// A slow file read, like a real one on a cold cache.
window.electron = {
  readProjectFilePreview: (_cwd, filePath) =>
    new Promise((resolve) => setTimeout(() => resolve({ kind: 'error', path: filePath, name: 'notes.md', ext: 'md', message: 'QA preview' }), 300)),
};
`;

const harness = `
import './mock.js';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectTreePanel } from '/src/ui/components/ProjectTreePanel.tsx';
import { useAppStore } from '/src/ui/store/useAppStore.ts';
import '/src/ui/index.css';

const file = { cwd: '/qa/project', filePath: '/qa/project/notes.md' };
useAppStore.setState({
  rightPanelBySessionId: {
    saved: { tabs: ['files:qa'], activeTab: 'files:qa', hidden: false, fullscreen: 'files', reviewDiffSelection: null,
      fileTabsByUtilityTab: { 'files:qa': { files: [file], activeFile: file } } },
  },
});

window.qa = { toggles: 0 };
function Panel({ sessionId }) {
  const [fullscreen, setFullscreen] = useState(true);
  window.qa.fullscreen = fullscreen;
  return <ProjectTreePanel key={sessionId} sessionId={sessionId} utilityTabId="files:qa" activeTab="files" collapsed={false} embedded
    onClose={() => {}} sharedPanelWidth={960} isFullscreen={fullscreen}
    onToggleFullscreen={() => { window.qa.toggles += 1; setFullscreen((value) => !value); }} />;
}
function Harness() {
  const [sessionId, setSessionId] = useState('saved');
  window.qa.show = (id) => { window.qa.toggles = 0; setSessionId(id); };
  return <Panel key={sessionId} sessionId={sessionId} />;
}
createRoot(document.getElementById('root')).render(<Harness />);
`;

const main = `
const { app, BrowserWindow } = require('electron');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { backgroundThrottling: false } });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  try {
    await win.loadURL(process.env.QA_URL);
    for (let i = 0; i < 100 && !(await js('Boolean(window.qa && window.qa.show)')); i += 1) await delay(100);
    await delay(900);
    const restored = await js('({ toggles: window.qa.toggles, fullscreen: window.qa.fullscreen, text: document.body.innerText.includes("notes.md") })');
    await js('window.qa.show("empty")');
    await delay(600);
    const empty = await js('({ toggles: window.qa.toggles, fullscreen: window.qa.fullscreen })');
    console.log(JSON.stringify({ ok: true, restored, empty }));
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
`;

function runElectron(mainPath, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(electronBin, [mainPath], { cwd: projectRoot, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Files fullscreen restore test timed out\n${stdout}\n${stderr}`));
    }, 60_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(`Files fullscreen restore test exited with ${code}\n${stdout}\n${stderr}`));
    });
  });
}

const qaRoot = path.join(projectRoot, '.aegis-design-qa');
await mkdir(qaRoot, { recursive: true });
const tmpDir = await mkdtemp(path.join(qaRoot, 'files-fullscreen-'));
let server;
try {
  await writeFile(path.join(tmpDir, 'index.html'), '<!doctype html><html><body><div id="root" style="position:relative;width:960px;height:600px"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmpDir, 'mock.js'), mock);
  await writeFile(path.join(tmpDir, 'harness.tsx'), harness);
  await writeFile(path.join(tmpDir, 'electron-main.cjs'), main);
  server = await createServer({
    root: projectRoot,
    configFile: path.join(projectRoot, 'vite.config.ts'),
    // Own dep cache: sharing node_modules/.vite breaks a running dev server.
    cacheDir: path.join(tmpDir, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0];
  assert.ok(baseUrl, 'Vite did not report a local URL');
  const harnessPath = path.relative(projectRoot, tmpDir).split(path.sep).join('/');
  const stdout = await runElectron(path.join(tmpDir, 'electron-main.cjs'), { QA_URL: new URL(`${harnessPath}/index.html`, baseUrl).href });
  const result = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop());
  assert.equal(result.restored.toggles, 0, 'restoring the saved file must not exit fullscreen');
  assert.equal(result.restored.fullscreen, true);
  assert.equal(result.restored.text, true, 'the saved file is open again');
  assert.equal(result.empty.toggles, 1, 'fullscreen with nothing to restore still exits');
  assert.equal(result.empty.fullscreen, false);
  console.log('files fullscreen restore Electron regression passed');
} finally {
  if (server) await server.close();
  await rm(tmpDir, { recursive: true, force: true });
}
