import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const electronBin = path.join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron.cmd' : 'electron'
);

const localSvgDataUrl = `data:image/svg+xml;base64,${Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#f97316"/><text x="20" y="50" font-size="18" fill="#111827">local</text></svg>'
).toString('base64')}`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

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
      reject(new Error(`Electron verification timed out\n${stdout}\n${stderr}`));
    }, 45_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Electron exited with code ${code}\n${stdout}\n${stderr}`));
      }
    });
  });
}

async function writeHarnessFiles(tmpDir) {
  const remoteImagePath = `/${path.basename(tmpDir)}/remote.svg`;
  const harness = `
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { ProjectMarkdownEditor } from '/src/ui/components/ProjectMarkdownEditor.tsx';
import '/src/ui/index.css';

const remoteImage = window.location.origin + ${JSON.stringify(remoteImagePath)};
const initialMarkdown = \`---
title: Harness
tags:
  - markdown
draft: false
---

# Heading One

This line has [Baidu](www.baidu.com), [GitHub](https://github.com/DylanDDeng), and https://example.com/plain.

Inline probe:

Inline \\\`code\\\`, **bold**, *italic*, and ~~strike~~.

- [ ] todo item

\\\`\\\`\\\`ts
const value = 1;
\\\`\\\`\\\`

![Remote](\${remoteImage})

![Local](./local-image.svg)

| Name | Value |
| --- | --- |
| A | 1 |
\`;

function findView() {
  const editor = document.querySelector('.cm-editor');
  return editor ? EditorView.findFromDOM(editor) : null;
}

function Harness() {
  const [value, setValue] = useState(initialMarkdown);
  const valueRef = useRef(value);
  const bridgeRef = useRef(null);
  const saveCountRef = useRef(0);

  valueRef.current = value;

  useEffect(() => {
    window.__AegisMarkdownVerify = {
      ready: true,
      getValue: () => valueRef.current,
      getViewText: () => findView()?.state.doc.toString() || '',
      focusEnd: () => {
        const view = findView();
        if (!view) return false;
        view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length), scrollIntoView: true });
        view.focus();
        return true;
      },
      focusAfterInlineProbe: () => {
        const view = findView();
        if (!view) return false;
        const marker = 'Inline probe: ';
        const text = view.state.doc.toString();
        const pos = text.indexOf(marker) + marker.length;
        view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: true });
        view.focus();
        return true;
      },
      flush: () => bridgeRef.current?.flush(),
      getSaveCount: () => saveCountRef.current,
      snapshot: () => {
        const links = Array.from(document.querySelectorAll('.aegis-cm-link')).map((node) => ({
          text: node.textContent,
          url: node.getAttribute('data-aegis-url'),
        }));
        const images = Array.from(document.querySelectorAll('.aegis-cm-image-widget img')).map((node) => ({
          alt: node.getAttribute('alt'),
          src: node.getAttribute('src'),
          complete: node.complete,
          naturalWidth: node.naturalWidth,
        }));
        return {
          hasEditor: Boolean(document.querySelector('.aegis-md-codemirror-root .cm-editor')),
          oldRoots: document.querySelectorAll('.aegis-md-milkdown-root, .ProseMirror').length,
          links,
          bodyText: document.body.innerText,
          codeHeader: document.querySelector('.aegis-cm-code-header')?.textContent || '',
          codeLineText: Array.from(document.querySelectorAll('.aegis-cm-code-line')).map((node) => node.textContent).join('\\n'),
          tableHeader: document.querySelector('.aegis-cm-table-widget th')?.textContent || '',
          taskCount: document.querySelectorAll('.aegis-cm-task-checkbox').length,
          outlineTriggerTexts: Array.from(document.querySelectorAll('.aegis-md-outline-trigger span')).map((node) => node.textContent || ''),
          images,
        };
      },
    };
  });

  return (
    <ProjectMarkdownEditor
      value={value}
      cwd="/tmp/aegis-md-verify"
      filePath="note.md"
      fileName="note.md"
      saveState="idle"
      saveError={null}
      onChange={setValue}
      onSave={() => {
        saveCountRef.current += 1;
      }}
      onRegisterBridge={(bridge) => {
        bridgeRef.current = bridge;
      }}
    />
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
`;

  const preload = `
const { contextBridge } = require('electron');
const localSvgDataUrl = ${JSON.stringify(localSvgDataUrl)};
const imageReads = [];

contextBridge.exposeInMainWorld('electron', {
  readMarkdownImageAsset: async (cwd, markdownFilePath, imageSrc) => {
    imageReads.push({ cwd, markdownFilePath, imageSrc });
    return { ok: true, dataUrl: localSvgDataUrl };
  },
  createMarkdownImageAsset: async () => ({
    ok: true,
    relativePath: './created-image.svg',
    name: 'created-image.svg',
  }),
  selectMarkdownImageAsset: async () => ({
    ok: true,
    relativePath: './selected-image.svg',
    name: 'selected-image.svg',
  }),
  __getMarkdownImageReads: () => imageReads.slice(),
});
`;

  const main = `
const { app, BrowserWindow } = require('electron');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(win) {
  for (let index = 0; index < 120; index += 1) {
    const ready = await win.webContents.executeJavaScript('Boolean(window.__AegisMarkdownVerify?.ready)', true);
    if (ready) return;
    await delay(100);
  }
  throw new Error('Markdown harness did not become ready.');
}

async function pressEnter(win) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await delay(100);
}

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

app.whenReady().then(async () => {
  const logs = [];
  const hardTimeout = setTimeout(() => {
    console.error(JSON.stringify({ ok: false, reason: 'electron-main-timeout', logs }));
    app.exit(2);
  }, 35_000);
  const win = new BrowserWindow({
    width: 1240,
    height: 920,
    show: false,
    webPreferences: {
      preload: process.env.AEGIS_MD_VERIFY_PRELOAD,
      contextIsolation: true,
      sandbox: false,
    },
  });

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    logs.push({ level, message, line, sourceId });
  });

  try {
    await withTimeout(win.loadURL(process.env.AEGIS_MD_VERIFY_URL), 15_000, 'Timed out loading Markdown harness URL.');
    await waitForReady(win);
    await delay(300);
    await withTimeout(
      win.webContents.executeJavaScript(
        "Promise.race([Promise.all(Array.from(document.images).map((img) => img.complete ? true : new Promise((resolve) => { img.addEventListener('load', resolve, { once: true }); img.addEventListener('error', resolve, { once: true }); }))), new Promise((resolve) => setTimeout(resolve, 5000))])",
        true
      ),
      7_000,
      'Timed out waiting for Markdown images.'
    );
    await delay(100);

    const initialSnapshot = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.snapshot()', true);
    await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.focusAfterInlineProbe()', true);
    await win.webContents.insertText('\`');
    await delay(50);
    await win.webContents.insertText('ok');
    await delay(100);
    const afterInline = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.getViewText()', true);

    await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.focusEnd()', true);
    await win.webContents.insertText('\\n\`\`\`');
    await pressEnter(win);
    const afterFence = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.getViewText()', true);

    await win.webContents.executeJavaScript('document.querySelector(".aegis-cm-task-checkbox").click()', true);
    await delay(100);
    const afterTask = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.getViewText()', true);
    const imageReads = await win.webContents.executeJavaScript('window.electron.__getMarkdownImageReads()', true);
    const finalSnapshot = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.snapshot()', true);

    console.log(JSON.stringify({
      ok: true,
      initialSnapshot,
      finalSnapshot,
      afterInline,
      afterFence,
      afterTask,
      imageReads,
      logs,
    }));
    clearTimeout(hardTimeout);
    app.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    console.error(JSON.stringify({ ok: false, logs }));
    clearTimeout(hardTimeout);
    app.exit(1);
  }
});
`;

  await writeFile(path.join(tmpDir, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8" /><title>Markdown Editor Verify</title></head><body><div id="root"></div><script type="module" src="./harness.tsx"></script></body></html>');
  await writeFile(path.join(tmpDir, 'harness.tsx'), harness);
  await writeFile(path.join(tmpDir, 'preload.cjs'), preload);
  await writeFile(path.join(tmpDir, 'electron-main.cjs'), main);
  await writeFile(path.join(tmpDir, 'remote.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#2563eb"/><text x="16" y="50" font-size="18" fill="white">remote</text></svg>');
}

async function main() {
  const tmpDir = await mkdtemp(path.join(projectRoot, 'aegis-md-verify-'));
  let server;
  try {
    await writeHarnessFiles(tmpDir);
    server = await createServer({
      root: projectRoot,
      configFile: path.join(projectRoot, 'vite.config.ts'),
      server: {
        host: '127.0.0.1',
        port: 0,
        strictPort: false,
      },
    });
    await server.listen();
    const baseUrl = server.resolvedUrls?.local?.[0];
    assert(baseUrl, 'Vite did not report a local URL.');
    const harnessUrl = new URL(`${path.basename(tmpDir)}/index.html`, baseUrl).href;
    const { stdout } = await runElectron(path.join(tmpDir, 'electron-main.cjs'), {
      AEGIS_MD_VERIFY_URL: harnessUrl,
      AEGIS_MD_VERIFY_PRELOAD: path.join(tmpDir, 'preload.cjs'),
    });
    const resultLine = stdout.trim().split('\n').filter(Boolean).pop();
    assert(resultLine, 'Electron did not return verification JSON.');
    const result = JSON.parse(resultLine);
    assert(result.ok, 'Electron verification returned ok=false.');

    const { initialSnapshot, finalSnapshot, afterInline, afterFence, afterTask, imageReads, logs } = result;
    assert(initialSnapshot.hasEditor, 'CodeMirror editor did not mount.');
    assert(initialSnapshot.oldRoots === 0, 'Old Milkdown/ProseMirror roots are still present.');
    assert(initialSnapshot.links.some((link) => link.text === 'Baidu' && link.url === 'www.baidu.com'), 'Markdown link label did not render as a clickable link.');
    assert(initialSnapshot.links.some((link) => link.text === 'https://example.com/plain' && link.url === 'https://example.com/plain'), 'Bare URL did not render as a clickable link.');
    assert(!initialSnapshot.bodyText.includes('[Baidu](www.baidu.com)'), 'Markdown link source syntax is visible in live preview.');
    assert(initialSnapshot.codeHeader.includes('ts'), 'Code block header did not render.');
    assert(initialSnapshot.codeLineText.includes('const value = 1;'), 'Code block body did not render.');
    assert(initialSnapshot.tableHeader === 'Name', 'Markdown table preview did not render.');
    assert(initialSnapshot.taskCount === 1, 'Task checkbox widget did not render.');
    assert(
      initialSnapshot.outlineTriggerTexts.length > 0
        && initialSnapshot.outlineTriggerTexts.every((text) => text.trim() === ''),
      `Outline trigger should render tick marks without heading text: ${JSON.stringify(initialSnapshot.outlineTriggerTexts)}`
    );
    assert(
      initialSnapshot.images.some((image) => image.alt === 'Remote' && /^http:\/\/127\.0\.0\.1:/.test(image.src)),
      `Remote image URL did not render as an image: ${JSON.stringify(initialSnapshot.images)}`
    );
    assert(
      initialSnapshot.images.some((image) => image.alt === 'Local' && image.src.startsWith('data:image/svg+xml')),
      `Local image did not render from Electron asset reader: ${JSON.stringify(initialSnapshot.images)}`
    );
    assert(
      imageReads.some((read) => read.imageSrc === './local-image.svg'),
      `Local image reader was not called: ${JSON.stringify(imageReads)}`
    );
    assert(afterInline.includes('Inline probe: `ok`'), 'Inline code backtick pairing did not keep the cursor inside the pair.');
    assert(
      afterFence.includes('\n```\n\n```'),
      `Triple backtick Enter shortcut did not create a fenced code block. Tail: ${JSON.stringify(afterFence.slice(-120))}`
    );
    assert(afterTask.includes('- [x] todo item'), 'Task checkbox click did not update Markdown source.');
    assert(finalSnapshot.oldRoots === 0, 'Old editor roots appeared after interactions.');

    const severeLogs = logs.filter((entry) => entry.level >= 3 && !String(entry.message).includes('Download the React DevTools'));
    assert(severeLogs.length === 0, `Browser console emitted errors: ${JSON.stringify(severeLogs)}`);
    console.log('markdown editor verification passed');
  } finally {
    if (server) await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
