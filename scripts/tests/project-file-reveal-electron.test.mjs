import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

const firstSource = Array.from(
  { length: 120 },
  (_, index) => `FIRST_FILE_LINE_${String(index + 1).padStart(3, '0')}`
).join('\n');
const secondSource = Array.from(
  { length: 120 },
  (_, index) => `SECOND_FILE_LINE_${String(index + 1).padStart(3, '0')}`
).join('\n');

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
      reject(new Error(`File reveal Electron regression timed out\n${stdout}\n${stderr}`));
    }, 30_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(`File reveal Electron regression exited with ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function writeHarness(tmpDir) {
  const harness = `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { HighlightedCode } from '/src/ui/components/HighlightedCode.tsx';
import { ProjectTextEditor } from '/src/ui/components/ProjectTextEditor.tsx';
import {
  createProjectFileRevealTarget,
  selectProjectFileRevealTarget,
} from '/src/ui/utils/project-file-navigation.ts';
import '/src/ui/index.css';

const cwd = '/workspace';
const firstPath = '/workspace/First.tsx';
const secondPath = '/workspace/Second.md';
const firstSource = ${JSON.stringify(firstSource)};
const secondSource = ${JSON.stringify(secondSource)};

function Harness() {
  const [currentPath, setCurrentPath] = useState(firstPath);
  const [target, setTarget] = useState(() => createProjectFileRevealTarget({
    cwd,
    path: firstPath,
    line: 90,
    token: 1,
  }));
  const activeTarget = selectProjectFileRevealTarget(target, cwd, currentPath);
  const firstFileActive = currentPath === firstPath;

  useEffect(() => {
    window.__AegisFileRevealVerify = {
      ready: true,
      repeatSameReference: () => {
        const viewport = document.getElementById('file-viewport');
        if (viewport) viewport.scrollTop = 0;
        setTarget((current) => current ? { ...current, token: current.token + 1 } : current);
      },
      switchToSecondFile: () => setCurrentPath(secondPath),
      snapshot: () => {
        const viewport = document.getElementById('file-viewport');
        const codeLines = Array.from(document.querySelectorAll('.highlighted-code-content'))
          .map((node) => node.textContent || '');
        const targetLine = document.querySelectorAll('.highlighted-code-line')[89] || null;
        const editorNode = document.querySelector('.cm-editor');
        const editor = editorNode ? EditorView.findFromDOM(editorNode) : null;
        const targetRect = targetLine?.getBoundingClientRect() || null;
        const viewportRect = viewport?.getBoundingClientRect() || null;
        return {
          currentPath,
          activeTarget: activeTarget ? {
            cwd: activeTarget.cwd,
            path: activeTarget.path,
            line: activeTarget.line,
            token: activeTarget.token,
          } : null,
          viewportScrollTop: viewport?.scrollTop || 0,
          targetVisible: Boolean(
            targetRect && viewportRect &&
            targetRect.top >= viewportRect.top &&
            targetRect.bottom <= viewportRect.bottom
          ),
          targetClassName: targetLine?.className || '',
          codeLineCount: codeLines.length,
          firstCodeLine: codeLines[0] || '',
          lastCodeLine: codeLines[codeLines.length - 1] || '',
          editorText: editor?.state.doc.toString() || '',
          editorLineCount: editor?.state.doc.lines || 0,
          selectionFrom: editor?.state.selection.main.from ?? null,
          selectionTo: editor?.state.selection.main.to ?? null,
          editorFocused: Boolean(editor?.hasFocus),
        };
      },
    };
  }, [activeTarget, currentPath]);

  return (
    <div style={{ width: 760, height: 260, padding: 8 }}>
      <div id="file-viewport" style={{ height: 240, overflow: 'auto' }}>
        {firstFileActive ? (
          <HighlightedCode
            code={firstSource}
            fileName="First.tsx"
            revealTarget={activeTarget}
            className="file-preview-code"
          />
        ) : (
          <ProjectTextEditor
            value={secondSource}
            fileName="Second.md"
            scrollTarget={activeTarget}
          />
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
`;

  const main = `
const { app, BrowserWindow } = require('electron');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(win) {
  for (let index = 0; index < 100; index += 1) {
    const ready = await win.webContents.executeJavaScript(
      'Boolean(window.__AegisFileRevealVerify?.ready)',
      true
    );
    if (ready) return;
    await delay(100);
  }
  throw new Error('File reveal harness did not become ready.');
}

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 340, show: false });
  try {
    await win.loadURL(process.env.AEGIS_FILE_REVEAL_VERIFY_URL);
    await waitForReady(win);
    await delay(300);
    const initial = await win.webContents.executeJavaScript(
      'window.__AegisFileRevealVerify.snapshot()',
      true
    );
    await win.webContents.executeJavaScript(
      'window.__AegisFileRevealVerify.repeatSameReference()',
      true
    );
    await delay(300);
    const repeated = await win.webContents.executeJavaScript(
      'window.__AegisFileRevealVerify.snapshot()',
      true
    );
    await win.webContents.executeJavaScript(
      'window.__AegisFileRevealVerify.switchToSecondFile()',
      true
    );
    await delay(300);
    const switched = await win.webContents.executeJavaScript(
      'window.__AegisFileRevealVerify.snapshot()',
      true
    );
    console.log(JSON.stringify({ ok: true, initial, repeated, switched }));
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
`;

  await writeFile(
    path.join(tmpDir, 'index.html'),
    '<!doctype html><html><body><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>'
  );
  await writeFile(path.join(tmpDir, 'harness.tsx'), harness);
  await writeFile(path.join(tmpDir, 'electron-main.cjs'), main);
}

async function main() {
  const tmpDir = await mkdtemp(path.join(projectRoot, '.aegis-file-reveal-'));
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
    const harnessUrl = new URL(`${path.basename(tmpDir)}/index.html`, baseUrl).href;
    const stdout = await runElectron(path.join(tmpDir, 'electron-main.cjs'), {
      AEGIS_FILE_REVEAL_VERIFY_URL: harnessUrl,
    });
    const resultLine = stdout.trim().split('\n').filter(Boolean).pop();
    assert.ok(resultLine, 'Electron did not return regression results');
    const result = JSON.parse(resultLine);
    assert.equal(result.ok, true);

    assert.equal(result.initial.codeLineCount, 120, 'the complete first file must remain rendered');
    assert.equal(result.initial.firstCodeLine, 'FIRST_FILE_LINE_001');
    assert.equal(result.initial.lastCodeLine, 'FIRST_FILE_LINE_120');
    assert.equal(result.initial.activeTarget.line, 90);
    assert.ok(result.initial.viewportScrollTop > 0, 'the first reference must scroll down');
    assert.equal(result.initial.targetVisible, true, 'the requested line must be visible');
    assert.equal(
      result.initial.targetClassName,
      'highlighted-code-line',
      'the requested line must not receive a highlight class'
    );

    assert.equal(result.repeated.activeTarget.token, 2);
    assert.ok(result.repeated.viewportScrollTop > 0, 'repeating the same reference must scroll again');
    assert.equal(result.repeated.targetVisible, true);

    assert.equal(result.switched.currentPath, '/workspace/Second.md');
    assert.equal(result.switched.activeTarget, null, 'the second file must not inherit the first target');
    assert.equal(result.switched.editorText, secondSource, 'the complete second file must remain loaded');
    assert.equal(result.switched.editorLineCount, 120);
    assert.equal(result.switched.selectionFrom, 0, 'switching files must not move the caret');
    assert.equal(result.switched.selectionTo, 0, 'switching files must not create a selection');
    assert.equal(result.switched.editorFocused, false, 'switching files must not focus the editor');

    console.log('project file reveal Electron regression passed');
  } finally {
    if (server) await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
}

await main();
