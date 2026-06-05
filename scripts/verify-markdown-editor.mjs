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
  '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="420"><rect width="720" height="420" fill="#f97316"/><text x="36" y="220" font-size="44" fill="#111827">local</text></svg>'
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
const filler = Array.from({ length: 48 }, (_, index) => \`Filler paragraph \${index + 1}: keep the outline target below the first viewport.\`).join('\\n\\n');
const tailFiller = Array.from({ length: 12 }, (_, index) => \`Tail paragraph \${index + 1}: leave enough room after the outline target.\`).join('\\n\\n');
const initialMarkdown = \`---
title: Harness
tags:
  - markdown
draft: false
---

# Heading One

This line has [Baidu](www.baidu.com), [GitHub](https://github.com/DylanDDeng), and https://example.com/plain.

Inline probe: anchor

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

\${filler}

## Deep Target

Target paragraph after the outline jump.

\${tailFiller}
\`;

function findView() {
  const editor = document.querySelector('.cm-editor');
  return editor ? EditorView.findFromDOM(editor) : null;
}

function findFirstTextNode(node) {
  if (!node) return null;
  if (node.nodeType === Node.TEXT_NODE && node.nodeValue) return node;
  for (const child of node.childNodes) {
    const found = findFirstTextNode(child);
    if (found) return found;
  }
  return null;
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
      focusAboveLastFence: () => {
        const view = findView();
        if (!view) return null;
        const text = view.state.doc.toString();
        const idx = text.lastIndexOf('\`\`\`');
        if (idx < 0) return null;
        const fenceLine = view.state.doc.lineAt(idx);
        const caretLineNumber = Math.max(1, fenceLine.number - 1);
        const pos = view.state.doc.line(caretLineNumber).from;
        // Caret strictly above the fence (so an unterminated fence block is inactive
        // and would collapse if buggy), while scrolling the fence region into the
        // viewport so the rendered DOM actually contains the lines below it.
        view.dispatch({
          selection: EditorSelection.cursor(pos),
          effects: EditorView.scrollIntoView(fenceLine.from, { y: 'start' }),
        });
        view.focus();
        return { fenceLine: fenceLine.number, caretLine: caretLineNumber };
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
      getMainScrollTop: () => document.querySelector('.aegis-md-main')?.scrollTop || 0,
      clickFrontmatterWidget: () => {
        const widget = document.querySelector('.aegis-cm-frontmatter-widget');
        if (!widget) return null;
        const rect = widget.getBoundingClientRect();
        widget.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + Math.min(rect.height / 2, 40),
        }));
        return { text: widget.textContent || '' };
      },
      clickOutlineItem: (text) => {
        const main = document.querySelector('.aegis-md-main');
        const button = Array.from(document.querySelectorAll('.aegis-md-outline-list button'))
          .find((node) => (node.textContent || '').trim() === text);
        if (!main || !button) return null;
        main.scrollTop = 0;
        const before = main.scrollTop;
        button.click();
        return { before, text: button.textContent || '' };
      },
      getLineViewportPosition: (needle) => {
        const line = Array.from(document.querySelectorAll('.cm-line'))
          .find((node) => (node.textContent || '').includes(needle));
        const main = document.querySelector('.aegis-md-main');
        if (!line || !main) return null;
        const lineRect = line.getBoundingClientRect();
        const mainRect = main.getBoundingClientRect();
        return {
          lineTop: lineRect.top,
          mainTop: mainRect.top,
          offset: lineRect.top - mainRect.top,
          text: line.textContent || '',
        };
      },
      getSelectionLineText: () => {
        const view = findView();
        if (!view) return '';
        return view.state.doc.lineAt(view.state.selection.main.from).text;
      },
      measureBacktickPairCaret: () => {
        const view = findView();
        if (!view) return null;
        const selection = view.state.selection.main;
        const line = view.state.doc.lineAt(selection.from);
        const lineDom = Array.from(document.querySelectorAll('.cm-line'))
          .find((node) => node.textContent === '\`\`');
        const textNode = findFirstTextNode(lineDom);
        const firstRange = document.createRange();
        const secondRange = document.createRange();
        if (textNode) {
          firstRange.setStart(textNode, 0);
          firstRange.setEnd(textNode, 1);
          secondRange.setStart(textNode, 1);
          secondRange.setEnd(textNode, 2);
        }
        const firstRect = textNode ? firstRange.getBoundingClientRect() : null;
        const secondRect = textNode ? secondRange.getBoundingClientRect() : null;
        const cursorRect = document.querySelector('.cm-cursor-primary')?.getBoundingClientRect() || null;
        const posBetween = view.coordsAtPos(line.from + 1, 1);
        return {
          lineText: line.text,
          lineFrom: line.from,
          lineTo: line.to,
          selectionFrom: selection.from,
          selectionTo: selection.to,
          cursorLeft: cursorRect?.left ?? null,
          cursorRight: cursorRect?.right ?? null,
          firstLeft: firstRect?.left ?? null,
          firstRight: firstRect?.right ?? null,
          secondLeft: secondRect?.left ?? null,
          secondRight: secondRect?.right ?? null,
          posBetweenLeft: posBetween?.left ?? null,
        };
      },
      findLineClickPoint: (needle) => {
        const line = Array.from(document.querySelectorAll('.cm-line'))
          .find((node) => (node.textContent || '').includes(needle));
        if (!line) return null;
        const rect = line.getBoundingClientRect();
        return {
          x: rect.left + Math.min(Math.max(rect.width * 0.45, 12), Math.max(12, rect.width - 12)),
          y: rect.top + (rect.height / 2),
          text: line.textContent || '',
          height: rect.height,
        };
      },
      snapshot: () => {
        const view = findView();
        const links = Array.from(document.querySelectorAll('.aegis-cm-link')).map((node) => ({
          text: node.textContent,
          url: node.getAttribute('data-aegis-url'),
        }));
        const inlineCodeTexts = Array.from(document.querySelectorAll('.aegis-cm-inline-code')).map((node) => node.textContent || '');
        const images = Array.from(document.querySelectorAll('.aegis-cm-image-widget img')).map((node) => ({
          alt: node.getAttribute('alt'),
          src: node.getAttribute('src'),
          complete: node.complete,
          naturalWidth: node.naturalWidth,
        }));
        return {
          hasEditor: Boolean(document.querySelector('.aegis-md-codemirror-root .cm-editor')),
          oldRoots: document.querySelectorAll('.aegis-md-milkdown-root, .ProseMirror').length,
          editorText: view?.state.doc.toString() || '',
          frontmatterWidgetCount: document.querySelectorAll('.aegis-cm-frontmatter-widget').length,
          frontmatterWidgetText: document.querySelector('.aegis-cm-frontmatter-widget')?.textContent || '',
          links,
          inlineCodeTexts,
          bodyText: document.body.innerText,
          codeHeader: document.querySelector('.aegis-cm-code-header')?.textContent || '',
          codeLineText: Array.from(document.querySelectorAll('.aegis-cm-code-body, .aegis-cm-code-line')).map((node) => node.textContent).join('\\n'),
          codeSourceLineTexts: Array.from(document.querySelectorAll('.aegis-cm-code-source-line')).map((node) => node.textContent || ''),
          codeWidgetCount: document.querySelectorAll('.aegis-cm-code-widget').length,
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

async function pressBackquote(win) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '\`' });
  win.webContents.sendInputEvent({ type: 'char', keyCode: '\`' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '\`' });
  await delay(30);
}

async function pressBackquotes(win, count) {
  for (let index = 0; index < count; index += 1) {
    await pressBackquote(win);
  }
}

async function insertTextSequence(win, text) {
  for (const char of text) {
    await win.webContents.insertText(char);
    await delay(30);
  }
}

async function clickPoint(win, point) {
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await delay(160);
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
    const frontmatterClickResult = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.clickFrontmatterWidget()', true);
    if (!frontmatterClickResult) throw new Error('Unable to click front matter widget.');
    await delay(120);
    const frontmatterSelectionLine = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.getSelectionLineText()', true);
    const frontmatterEditSnapshot = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.snapshot()', true);

    const headingClickPoint = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.findLineClickPoint("Heading One")', true);
    if (!headingClickPoint) throw new Error('Unable to find heading line click point.');
    await clickPoint(win, headingClickPoint);
    const headingSelectionLine = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.getSelectionLineText()', true);

    const paragraphClickPoint = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.findLineClickPoint("This line has")', true);
    if (!paragraphClickPoint) throw new Error('Unable to find paragraph line click point.');
    await clickPoint(win, paragraphClickPoint);
    const paragraphSelectionLine = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.getSelectionLineText()', true);

    await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.focusAfterInlineProbe()', true);
    await pressBackquote(win);
    await insertTextSequence(win, 'hello');
    await pressBackquote(win);
    await delay(80);
    const afterInlineClosingSnapshot = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.snapshot()', true);
    await insertTextSequence(win, ' ');
    await delay(100);
    const afterInline = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.getViewText()', true);
    const afterInlineSpaceSnapshot = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.snapshot()', true);

    await win.webContents.executeJavaScript('document.querySelector(".aegis-cm-task-checkbox").click()', true);
    await delay(100);
    const afterTask = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.getViewText()', true);

    await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.focusEnd()', true);
    await win.webContents.insertText('\\n\\n');
    await pressBackquote(win);
    await delay(100);
    const backtickPairCaret = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.measureBacktickPairCaret()', true);

    await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.focusEnd()', true);
    await win.webContents.insertText('\\n');
    await pressBackquotes(win, 3);
    await delay(100);
    const afterFence = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.getViewText()', true);
    const afterFenceSelectionLine = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.getSelectionLineText()', true);
    const afterFenceSnapshot = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.snapshot()', true);

    const outlineJumpStart = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.clickOutlineItem("Deep Target")', true);
    if (!outlineJumpStart) throw new Error('Unable to click Deep Target outline item.');
    await delay(900);
    const outlineScrollTop = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.getMainScrollTop()', true);
    const outlineTargetPosition = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.getLineViewportPosition("Deep Target")', true);
    const deepParagraphClickPoint = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.findLineClickPoint("Target paragraph after the outline jump.")', true);
    if (!deepParagraphClickPoint) throw new Error('Unable to find deep paragraph line click point.');
    await clickPoint(win, deepParagraphClickPoint);
    const deepParagraphSelectionLine = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.getSelectionLineText()', true);

    // Regression: an unterminated triple-backtick fence already present in a
    // document must NOT swallow the content below it into a code block.
    await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.focusEnd()', true);
    await win.webContents.insertText('\\n\\n\`\`\`\\n\\nSWALLOW_PROBE_BELOW_FENCE\\n\\nSWALLOW_PROBE_TAIL_LINE');
    await delay(80);
    const midFenceFocus = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.focusAboveLastFence()', true);
    if (!midFenceFocus) throw new Error('Unable to position caret above the mid-document fence.');
    await delay(200);
    const midFenceSnapshot = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.snapshot()', true);

    const imageReads = await win.webContents.executeJavaScript('window.electron.__getMarkdownImageReads()', true);
    const finalFullValue = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.getValue()', true);
    const finalSnapshot = await win.webContents.executeJavaScript('window.__AegisMarkdownVerify.snapshot()', true);

    console.log(JSON.stringify({
      ok: true,
      initialSnapshot,
      frontmatterClickResult,
      frontmatterSelectionLine,
      frontmatterEditSnapshot,
      finalSnapshot,
      afterInline,
      afterInlineClosingSnapshot,
      afterInlineSpaceSnapshot,
      backtickPairCaret,
      afterFence,
      afterFenceSelectionLine,
      afterFenceSnapshot,
      afterTask,
      headingClickPoint,
      headingSelectionLine,
      paragraphClickPoint,
      paragraphSelectionLine,
      outlineJumpStart,
      outlineScrollTop,
      outlineTargetPosition,
      deepParagraphClickPoint,
      deepParagraphSelectionLine,
      midFenceSnapshot,
      finalFullValue,
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
  await writeFile(path.join(tmpDir, 'remote.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="420"><rect width="720" height="420" fill="#2563eb"/><text x="36" y="220" font-size="44" fill="white">remote</text></svg>');
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

    const {
      initialSnapshot,
      frontmatterClickResult,
      frontmatterSelectionLine,
      frontmatterEditSnapshot,
      finalSnapshot,
      afterInline,
      afterInlineClosingSnapshot,
      afterInlineSpaceSnapshot,
      backtickPairCaret,
      afterFence,
      afterFenceSelectionLine,
      afterFenceSnapshot,
      afterTask,
      headingClickPoint,
      headingSelectionLine,
      paragraphClickPoint,
      paragraphSelectionLine,
      outlineJumpStart,
      outlineScrollTop,
      outlineTargetPosition,
      deepParagraphClickPoint,
      deepParagraphSelectionLine,
      midFenceSnapshot,
      finalFullValue,
      imageReads,
      logs,
    } = result;
    assert(initialSnapshot.hasEditor, 'CodeMirror editor did not mount.');
    assert(initialSnapshot.oldRoots === 0, 'Old Milkdown/ProseMirror roots are still present.');
    assert(
      initialSnapshot.frontmatterWidgetCount === 1
        && initialSnapshot.frontmatterWidgetText.includes('tags')
        && initialSnapshot.frontmatterWidgetText.includes('markdown'),
      `Front matter metadata card did not render: ${JSON.stringify({
        count: initialSnapshot.frontmatterWidgetCount,
        text: initialSnapshot.frontmatterWidgetText,
      })}`
    );
    assert(initialSnapshot.editorText.startsWith('---\ntitle: Harness'), 'CodeMirror source lost the front matter block.');
    assert(!initialSnapshot.bodyText.includes('---\ntitle: Harness'), 'Front matter source is visible while metadata preview is inactive.');
    assert(!initialSnapshot.bodyText.includes('\ntags:\n'), 'Front matter field source is visible while metadata preview is inactive.');
    assert(
      frontmatterSelectionLine.includes('title: Harness'),
      `Clicking front matter preview did not enter source editing mode: ${JSON.stringify({ frontmatterClickResult, frontmatterSelectionLine })}`
    );
    assert(frontmatterEditSnapshot.frontmatterWidgetCount === 0, 'Front matter preview stayed visible while cursor was inside the source block.');
    assert(initialSnapshot.links.some((link) => link.text === 'Baidu' && link.url === 'www.baidu.com'), 'Markdown link label did not render as a clickable link.');
    assert(initialSnapshot.links.some((link) => link.text === 'https://example.com/plain' && link.url === 'https://example.com/plain'), 'Bare URL did not render as a clickable link.');
    assert(!initialSnapshot.bodyText.includes('[Baidu](www.baidu.com)'), 'Markdown link source syntax is visible in live preview.');
    assert(initialSnapshot.codeHeader.includes('ts'), 'Code block header did not render.');
    assert(initialSnapshot.codeLineText.includes('const value = 1;'), 'Code block body did not render.');
    assert(initialSnapshot.codeWidgetCount >= 1, 'Code block preview widget did not render as a single block.');
    assert(initialSnapshot.tableHeader === 'Name', 'Markdown table preview did not render.');
    assert(initialSnapshot.taskCount === 1, 'Task checkbox widget did not render.');
    assert(
      headingSelectionLine.includes('# Heading One'),
      `Clicking the rendered heading selected the wrong source line: ${JSON.stringify({ headingClickPoint, headingSelectionLine })}`
    );
    assert(
      paragraphSelectionLine.includes('This line has'),
      `Clicking the rendered paragraph selected the wrong source line: ${JSON.stringify({ paragraphClickPoint, paragraphSelectionLine })}`
    );
    assert(
      outlineScrollTop > outlineJumpStart.before + 100,
      `Clicking an outline item did not scroll the main editor viewport: ${JSON.stringify({ outlineJumpStart, outlineScrollTop })}`
    );
    assert(
      outlineTargetPosition && outlineTargetPosition.offset >= 48 && outlineTargetPosition.offset <= 260,
      `Outline jump did not place the target heading in view: ${JSON.stringify({ outlineScrollTop, outlineTargetPosition })}`
    );
    assert(
      deepParagraphSelectionLine.includes('Target paragraph after the outline jump.'),
      `Clicking a line after rendered image widgets selected the wrong source line: ${JSON.stringify({ deepParagraphClickPoint, deepParagraphSelectionLine })}`
    );
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
    assert(afterInline.includes('Inline probe: `hello` anchor'), 'Backquote key input did not preserve inline code source markers.');
    const inlineMarkersRawWhileAdjacent =
      afterInlineClosingSnapshot.bodyText.includes('`hello`')
      && afterInlineClosingSnapshot.inlineCodeTexts.includes('`hello`');
    assert(
      inlineMarkersRawWhileAdjacent,
      'Inline code should keep visible markers while the caret is still adjacent to the just-typed closing backtick. bodyHasRawMarkers='
        + afterInlineClosingSnapshot.bodyText.includes('`hello`')
        + ' inlineCodeTexts=' + JSON.stringify(afterInlineClosingSnapshot.inlineCodeTexts)
    );
    assert(
      afterInlineSpaceSnapshot.inlineCodeTexts.includes('hello')
        && !afterInlineSpaceSnapshot.bodyText.includes('`hello`'),
      `Inline code did not render after leaving the edited line: ${JSON.stringify({
        inlineCodeTexts: afterInlineSpaceSnapshot.inlineCodeTexts,
        bodyText: afterInlineSpaceSnapshot.bodyText,
      })}`
    );
    assert(
      backtickPairCaret
        && backtickPairCaret.lineText === '``'
        && backtickPairCaret.selectionFrom === backtickPairCaret.lineFrom + 1
        && backtickPairCaret.selectionTo === backtickPairCaret.lineFrom + 1,
      `Single backtick key input did not create an inline-code pair with the cursor in the middle: ${JSON.stringify(backtickPairCaret)}`
    );
    assert(
      typeof backtickPairCaret.posBetweenLeft === 'number'
        && typeof backtickPairCaret.firstRight === 'number'
        && typeof backtickPairCaret.secondLeft === 'number'
        && backtickPairCaret.posBetweenLeft >= backtickPairCaret.firstRight - 1
        && backtickPairCaret.posBetweenLeft <= backtickPairCaret.secondLeft + 1,
      `Inline-code pair visual caret is not between the paired markers: ${JSON.stringify(backtickPairCaret)}`
    );
    assert(
      afterFence.includes('\n```\n\n```'),
      `Manual multi-line code fence input did not preserve split fence markers. Tail: ${JSON.stringify(afterFence.slice(-120))}`
    );
    assert(
      afterFenceSelectionLine === '',
      `Triple backtick completion did not leave the cursor on the editable blank code line: ${JSON.stringify(afterFenceSelectionLine)}`
    );
    assert(
      afterFenceSnapshot.codeSourceLineTexts.includes('```')
        && afterFenceSnapshot.codeSourceLineTexts.filter((text) => text === '```').length >= 2
        && !afterFenceSnapshot.codeSourceLineTexts.includes('`'),
      `Triple backtick completion did not render a clean editable fenced block: ${JSON.stringify(afterFenceSnapshot.codeSourceLineTexts)}`
    );
    assert(
      midFenceSnapshot.editorText.includes('SWALLOW_PROBE_BELOW_FENCE'),
      'Mid-document fence probe text was lost from the source.'
    );
    assert(
      !midFenceSnapshot.codeLineText.includes('SWALLOW_PROBE_BELOW_FENCE'),
      'An unterminated code fence swallowed the content below it into a code block (the rest of the document collapsed into code chrome). codeLineText='
        + JSON.stringify(midFenceSnapshot.codeLineText.slice(0, 200))
    );
    assert(afterTask.includes('- [x] todo item'), 'Task checkbox click did not update Markdown source.');
    assert(finalFullValue.startsWith('---\ntitle: Harness'), 'Full Markdown value lost its front matter.');
    assert(finalFullValue.includes('- [x] todo item'), 'Full Markdown value did not include body edits.');
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
