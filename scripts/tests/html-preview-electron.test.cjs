const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { mkdtempSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const temp = mkdtempSync(path.join(os.tmpdir(), 'aegis-html-electron-'));
app.setPath('userData', path.join(temp, 'profile'));
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => { console.error('HTML preview test timed out'); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  const { browserManager } = require('../../dist-electron/electron/browserManager.js');
  const { getHtmlPreviewUrl } = require('../../dist-electron/electron/libs/html-preview.js');
  let win;
  let code = 0;
  try {
    const project = path.join(temp, 'project');
    const output = path.join(temp, 'external output');
    await Promise.all([fs.mkdir(project), fs.mkdir(output)]);
    const file = path.join(output, '中文 #100%.html');
    await Promise.all([
      fs.writeFile(file, '<!doctype html><meta charset="utf-8"><title>External artifact</title><link rel="stylesheet" href="style.css"><h1>项目外 HTML</h1><p id="script">waiting</p><img id="image" src="image.svg"><script src="script.js"></script>'),
      fs.writeFile(path.join(output, 'style.css'), 'body { background: rgb(240, 245, 250); padding: 40px; } h1 { color: rgb(22, 55, 88); }'),
      fs.writeFile(path.join(output, 'script.js'), 'document.getElementById("script").textContent="Relative script loaded";'),
      fs.writeFile(path.join(output, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40" fill="teal"/></svg>'),
      fs.writeFile(path.join(project, 'b.html'), '<!doctype html><title>Session B</title><h1>Session B</h1>'),
    ]);
    const preview = await getHtmlPreviewUrl(project, file);
    assert.equal(preview.ok, true);
    assert.equal(preview.url, pathToFileURL(file).href);
    win = new BrowserWindow({ show: true, width: 900, height: 650 });
    // Complete host navigation before attaching views; a host reload detaches them.
    await win.loadURL('about:blank');
    browserManager.setWindow(win);
    const bounds = { x: 0, y: 0, width: 900, height: 650 };
    browserManager.open({ sessionId: 'A', initialUrl: preview.url });
    async function show(id) {
      browserManager.setPanelBounds({ sessionId: id, bounds });
      const target = browserManager.acquireAgentTarget(id);
      await target.restore;
      const contents = target.webContents;
      for (let i = 0; i < 100; i++) {
        if (!contents.isLoading() && contents.getURL().startsWith('file:')) break;
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      assert.equal(browserManager.getState({ sessionId: id }).lastError, null);
      return contents;
    }
    const first = await show('A');
    const result = await first.executeJavaScript(`({url:location.href,script:document.getElementById('script').textContent,image:document.getElementById('image').naturalWidth,color:getComputedStyle(document.querySelector('h1')).color,node:typeof process})`);
    assert.deepEqual(result, { url: preview.url, script: 'Relative script loaded', image: 100, color: 'rgb(22, 55, 88)', node: 'undefined' });
    // Screenshot artifacts require an available display compositor. Keep them
    // opt-in so headless/occluded runs still exercise loading and session switches.
    if (process.env.QA_CAPTURE) {
      await fs.mkdir(process.env.QA_CAPTURE, { recursive: true });
      const screenshot = await first.capturePage(undefined, { stayAwake: true });
      assert.ok(!screenshot.isEmpty(), 'the HTML preview must render a nonempty frame');
      await fs.writeFile(path.join(process.env.QA_CAPTURE, 'external-html.png'), screenshot.toPNG());
    }
    const secondUrl = pathToFileURL(path.join(project, 'b.html')).href;
    browserManager.open({ sessionId: 'B', initialUrl: secondUrl });
    for (const id of ['B', 'A', 'B', 'A']) {
      browserManager.hide({ sessionId: id === 'A' ? 'B' : 'A' });
      const contents = await show(id);
      assert.equal(contents.getURL(), id === 'A' ? preview.url : secondUrl);
      assert.equal(browserManager.getState({ sessionId: id }).tabs.length, 1);
    }
    assert.throws(() => browserManager.navigate({ sessionId: 'A', url: 'file://remote/share/index.html' }), /local file/);
    console.log('PASS Electron HTML preview: external file, encoded path, relative CSS/JS/image, sandbox, repeated A/B switching, remote-file rejection');
  } catch (error) {
    console.error(error); code = 1;
  } finally {
    clearTimeout(timeout);
    browserManager.dispose();
    if (win && !win.isDestroyed()) win.destroy();
    await fs.rm(temp, { recursive: true, force: true });
    app.exit(code);
  }
});
