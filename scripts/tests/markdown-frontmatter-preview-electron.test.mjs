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
      reject(new Error(`Markdown front matter Electron regression timed out\n${stdout}\n${stderr}`));
    }, 30_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(`Markdown front matter Electron regression exited with ${code}\n${stdout}\n${stderr}`));
    });
  });
}

async function writeHarness(tmpDir) {
  const harness = `
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectMarkdownPreview } from '/src/ui/components/ProjectMarkdownPreview.tsx';
import '/src/ui/index.css';

const frontmatterMarkdown = \`---
title: "为什么大模型会有幻觉"
slug: why-llms-hallucinate
description: "不讲公式，从猜下一个词这件事出发，看明白大模型为什么会一本正经地编出不存在的书、人和数字。"
date: 2026-08-30
lastmod: 2026-08-30
draft: false
weight: 1
sourceUrl: https://example.com/hallucination
tags: [新手村, 大模型, 幻觉]
author: Bubble
---

> 你问 AI：推荐三本讲注意力机制的中文书。

# 幻觉长什么样

这段正文必须正常渲染，front matter 不能混进正文。

| 类型 | 例子 |
| --- | --- |
| 编引用 | 一本不存在的书 |
\`;

function snapshot() {
  const card = document.querySelector('[data-testid="markdown-metadata-card"]');
  const body = document.querySelector('.aegis-markdown-preview-body');
  const toggle = document.querySelector('.aegis-markdown-metadata-toggle');
  const style = card ? getComputedStyle(card) : null;
  return {
    cardTitle: card?.querySelector('.aegis-markdown-metadata-title')?.textContent || null,
    rowCount: card?.querySelectorAll('.aegis-markdown-metadata-row').length || 0,
    toggleText: toggle?.textContent?.trim() || null,
    toggleExpanded: toggle?.getAttribute('aria-expanded') || null,
    bodyText: body?.textContent || '',
    fullText: document.body.textContent || '',
    borderRadius: style?.borderRadius || null,
    backgroundColor: style?.backgroundColor || null,
  };
}

function Harness() {
  const [content, setContent] = useState(frontmatterMarkdown);
  useEffect(() => {
    window.__AegisMarkdownFrontmatterVerify = {
      ready: true,
      snapshot,
      toggle: () => document.querySelector('.aegis-markdown-metadata-toggle')?.click(),
      showPlain: () => setContent('# Plain document\\n\\nNo front matter here.'),
    };
  }, []);
  return <ProjectMarkdownPreview content={content} />;
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
      'Boolean(window.__AegisMarkdownFrontmatterVerify?.ready)',
      true
    );
    if (ready) return;
    await delay(100);
  }
  throw new Error('Markdown front matter harness did not become ready.');
}

async function capture(win, name) {
  const outputDir = process.env.AEGIS_MARKDOWN_FRONTMATTER_CAPTURE_DIR;
  if (!outputDir) return;
  fs.mkdirSync(outputDir, { recursive: true });
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 960, height: 720 });
  fs.writeFileSync(path.join(outputDir, name), image.toPNG());
}

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1000, height: 780, show: false });
  const consoleErrors = [];
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) consoleErrors.push(message);
  });
  try {
    await win.loadURL(process.env.AEGIS_MARKDOWN_FRONTMATTER_VERIFY_URL);
    await waitForReady(win);
    await delay(350);
    await capture(win, 'collapsed.png');
    const collapsed = await win.webContents.executeJavaScript(
      'window.__AegisMarkdownFrontmatterVerify.snapshot()',
      true
    );
    await win.webContents.executeJavaScript('window.__AegisMarkdownFrontmatterVerify.toggle()', true);
    await delay(200);
    await capture(win, 'expanded.png');
    const expanded = await win.webContents.executeJavaScript(
      'window.__AegisMarkdownFrontmatterVerify.snapshot()',
      true
    );
    await win.webContents.executeJavaScript('window.__AegisMarkdownFrontmatterVerify.showPlain()', true);
    await delay(200);
    const plain = await win.webContents.executeJavaScript(
      'window.__AegisMarkdownFrontmatterVerify.snapshot()',
      true
    );
    console.log(JSON.stringify({ ok: true, collapsed, expanded, plain, consoleErrors }));
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
`;

  await writeFile(
    path.join(tmpDir, 'index.html'),
    '<!doctype html><html><body><div id="root" style="position:relative;width:960px;min-height:720px"></div><script type="module" src="./harness.tsx"></script></body></html>'
  );
  await writeFile(path.join(tmpDir, 'harness.tsx'), harness);
  await writeFile(path.join(tmpDir, 'electron-main.cjs'), main);
}

async function main() {
  const qaRoot = path.join(projectRoot, '.aegis-design-qa');
  await mkdir(qaRoot, { recursive: true });
  const tmpDir = await mkdtemp(path.join(qaRoot, 'markdown-frontmatter-'));
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
    if (process.env.AEGIS_MARKDOWN_FRONTMATTER_PREVIEW === '1') {
      console.log(`Markdown front matter preview: ${harnessUrl}`);
      await new Promise((resolve) => process.once('SIGTERM', resolve));
      return;
    }

    const stdout = await runElectron(path.join(tmpDir, 'electron-main.cjs'), {
      AEGIS_MARKDOWN_FRONTMATTER_VERIFY_URL: harnessUrl,
      AEGIS_MARKDOWN_FRONTMATTER_CAPTURE_DIR:
        process.env.AEGIS_MARKDOWN_FRONTMATTER_CAPTURE_DIR || '',
    });
    const resultLine = stdout.trim().split('\n').filter(Boolean).pop();
    assert.ok(resultLine, 'Electron did not return Markdown front matter regression results');
    const result = JSON.parse(resultLine);

    assert.equal(result.ok, true);
    assert.equal(result.collapsed.cardTitle, '元数据');
    assert.equal(result.collapsed.rowCount, 8);
    assert.equal(result.collapsed.toggleText, '显示更多');
    assert.equal(result.collapsed.toggleExpanded, 'false');
    assert.equal(result.collapsed.bodyText.includes('幻觉长什么样'), true);
    assert.equal(result.collapsed.bodyText.includes('title:'), false);
    assert.equal(result.collapsed.fullText.includes('---'), false);
    assert.notEqual(result.collapsed.backgroundColor, 'rgba(0, 0, 0, 0)');
    assert.equal(result.collapsed.borderRadius, '10px');

    assert.equal(result.expanded.rowCount, 10);
    assert.equal(result.expanded.toggleText, '收起');
    assert.equal(result.expanded.toggleExpanded, 'true');

    assert.equal(result.plain.cardTitle, null);
    assert.equal(result.plain.bodyText.includes('Plain document'), false);
    assert.equal(result.plain.fullText.includes('Plain document'), true);
    assert.deepEqual(result.consoleErrors, []);

    console.log('markdown front matter Electron regression passed');
  } finally {
    if (server) await server.close();
    await rm(tmpDir, { recursive: true, force: true });
  }
}

await main();
