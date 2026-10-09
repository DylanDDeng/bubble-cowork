// browser_use actions against real page views and a local HTTP server, with
// the panel closed (the agent's page lives in the hidden window): screenshots
// that actually show the page, typing into and clearing a field, choosing a
// <select> option, hover, waiting for late content, scrolling, back/forward,
// acting on an extra browser tab, and releasing every tab at turn end.
const { app, BrowserWindow, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-browser-use-actions-'));
app.setPath('userData', path.join(temp, 'profile'));
process.env.AEGIS_BROWSER_SCREENSHOT_DIR = path.join(temp, 'shots');
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => {
  console.error('browser_use actions test timed out');
  app.exit(1);
}, 90000);

const FORM = `<!doctype html><title>Form</title>
<style>body{margin:0;height:3000px;font:16px sans-serif} #swatch{width:240px;height:120px;background:rgb(0,128,255)}</style>
<div id="swatch"></div>
<input id="name" placeholder="Name">
<select id="color"><option value="r">Red</option><option value="g">Green</option></select>
<button id="hover" onmouseenter="document.title='hovered'">Hover me</button>
<button id="later" onclick="setTimeout(()=>{const p=document.createElement('p');p.textContent='Loaded later';document.body.appendChild(p)},300)">Later</button>
<a href="/second">Next page</a>
<div id="pane" style="height:100px;width:300px;overflow:auto"><div style="height:1000px">Inner pane</div></div>
<script>
  window.events = [];
  document.getElementById('name').addEventListener('input', (e) => events.push('input:' + e.target.value));
  document.getElementById('color').addEventListener('change', (e) => events.push('change:' + e.target.value));
</script>`;

app.whenReady().then(async () => {
  const { browserManager } = require('../../dist-electron/electron/browserManager.js');
  const {
    runBrowserUseAction,
    finishBrowserUseTurn,
    forgetBrowserUseScreenshots,
  } = require('../../dist-electron/electron/libs/browser-use.js');
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/form') res.end(FORM);
    else res.end(`<!doctype html><title>Page ${req.url}</title><h1>${req.url}</h1>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chat = 'chat-1';
  const run = (input) => runBrowserUseAction(browserManager, { sessionId: chat, ...input });
  const contents = () => {
    const page = browserManager.getState({ sessionId: chat }).page;
    return browserManager.getLiveWebContents(chat, page.id);
  };
  const js = (code) => contents().executeJavaScript(code, true);
  const node = (snapshot, match) => {
    const found = snapshot.nodes.find(match);
    assert.ok(found, 'snapshot node');
    return { node_id: found.id, nodeId: found.id, snapshotId: snapshot.snapshotId };
  };
  let code = 0;
  try {
    let result = await run({ action: 'navigate', url: `${base}/form` });
    assert.equal(result.ok, true, result.message);

    // A screenshot of the hidden page shows what it painted, at CSS pixels.
    result = await run({ action: 'screenshot' });
    assert.equal(result.ok, true, result.message);
    const shot = result.screenshot;
    assert.equal(shot.mimeType, 'image/jpeg');
    assert.equal(shot.scale, 1);
    assert.equal(shot.width, 1280);
    assert.equal(shot.height, 800);
    assert.ok(fs.existsSync(shot.path), 'the screenshot is saved to a file');
    const image = nativeImage.createFromPath(shot.path);
    assert.deepEqual(image.getSize(), { width: 1280, height: 800 });
    const bitmap = image.toBitmap();
    const pixel = (x, y) => {
      const i = (y * 1280 + x) * 4;
      return { b: bitmap[i], g: bitmap[i + 1], r: bitmap[i + 2] };
    };
    const swatch = pixel(60, 60);
    assert.ok(swatch.b > 200 && swatch.r < 60, `the swatch is painted blue, got ${JSON.stringify(swatch)}`);

    // Typing goes through real input events; clear replaces the contents.
    let snap = (await run({ action: 'snapshot' })).snapshot;
    const name = node(snap, (n) => n.tag === 'input');
    result = await run({ action: 'type', ...name, text: 'Ada' });
    assert.equal(result.ok, true, result.message);
    assert.equal(await js('document.getElementById("name").value'), 'Ada');
    result = await run({ action: 'type', ...name, text: 'Grace', clear: true });
    assert.equal(result.ok, true, result.message);
    assert.equal(await js('document.getElementById("name").value'), 'Grace');
    assert.ok((await js('events')).includes('input:Grace'), 'the page saw input events');

    // Select picks an option by label and fires change.
    result = await run({ action: 'select', ...node(snap, (n) => n.tag === 'select'), value: 'Green' });
    assert.equal(result.ok, true, result.message);
    assert.equal(await js('document.getElementById("color").value'), 'g');
    assert.ok((await js('events')).includes('change:g'));
    result = await run({ action: 'select', ...node(snap, (n) => n.tag === 'select'), value: 'Purple' });
    assert.equal(result.ok, false);
    assert.match(result.message, /Options: Red, Green/);
    result = await run({ action: 'select', ...node(snap, (n) => n.text === 'Hover me'), value: 'x' });
    assert.equal(result.ok, false, 'select refuses elements that are not a <select>');

    // Hover moves the pointer without clicking.
    result = await run({ action: 'hover', ...node(snap, (n) => n.text === 'Hover me') });
    assert.equal(result.ok, true, result.message);
    assert.equal(await js('document.title'), 'hovered');
    assert.equal(await js('!!document.getElementById("__aegis_agent_pointer")'), false, 'no pointer on a page nobody sees');

    // Wait finds content that appears later, and gives up on what never does.
    result = await run({ action: 'click', ...node(snap, (n) => n.text === 'Later') });
    assert.equal(result.ok, true, result.message);
    result = await run({ action: 'wait', text: 'Loaded later', timeoutMs: 3000 });
    assert.equal(result.ok, true, result.message);
    result = await run({ action: 'wait', text: 'Never shown', timeoutMs: 300 });
    assert.equal(result.ok, false);
    assert.match(result.message, /did not appear within 300ms/);

    // Scroll without a point scrolls the page itself, in the asked direction.
    result = await run({ action: 'scroll', direction: 'down', amount: 400 });
    assert.equal(result.ok, true, result.message);
    const scrolled = await js('scrollY');
    assert.ok(scrolled > 0, `scrolling down moves the page down (scrollY ${scrolled})`);
    assert.equal(scrolled, 400);
    assert.match(result.message, /the page is at 400 of/);
    result = await run({ action: 'scroll', direction: 'up', amount: 400 });
    assert.equal(await js('scrollY'), 0, 'scrolling up moves it back');
    result = await run({ action: 'scroll', direction: 'up' });
    assert.match(result.message, /already at the top/);

    // A point over an inner scroll container scrolls that container.
    const pane = await js('(() => { const r = document.getElementById("pane").getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + 20) }; })()');
    result = await run({ action: 'scroll', direction: 'down', amount: 250, x: pane.x, y: pane.y });
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /the scrollable area is at 250 of 900px/);
    assert.equal(await js('document.getElementById("pane").scrollTop'), 250);
    assert.equal(await js('scrollY'), 0, 'the page itself did not move');

    // A stale snapshot is refused rather than clicking the wrong spot.
    result = await run({ action: 'click', node_id: 1, nodeId: 1, snapshotId: 'snap-old' });
    assert.equal(result.ok, false);
    assert.match(result.message, /Stale snapshot/);

    // Back and forward.
    snap = (await run({ action: 'snapshot' })).snapshot;
    result = await run({ action: 'click', ...node(snap, (n) => n.text === 'Next page') });
    assert.equal(result.ok, true, result.message);
    assert.equal(contents().getURL(), `${base}/second`);
    result = await run({ action: 'back' });
    assert.equal(result.ok, true, result.message);
    assert.equal(contents().getURL(), `${base}/form`);
    result = await run({ action: 'forward' });
    assert.equal(result.ok, true, result.message);
    assert.equal(contents().getURL(), `${base}/second`);
    result = await run({ action: 'forward' });
    assert.equal(result.ok, false, 'no later page');

    // Keys with modifiers parse; plain keys still work.
    assert.equal((await run({ action: 'key', key: 'shift+tab' })).message, 'Pressed shift+Tab.');

    // Extra tabs: listed, addressable, and unknown ones are refused.
    browserManager.open({ sessionId: `${chat}:browser:t1`, initialUrl: `${base}/extra` });
    result = await run({ action: 'tabs' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.tabs.map((tab) => tab.tab), ['main', 'browser:t1']);
    result = await run({ action: 'read', tab: 'browser:t1' });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.snapshot.url, `${base}/extra`);
    assert.equal(contents().getURL(), `${base}/second`, 'the main tab is untouched');
    result = await run({ action: 'read', tab: 'browser:nope' });
    assert.equal(result.ok, false);
    assert.match(result.message, /Unknown tab/);

    // Screenshots on disk are capped per chat.
    for (let i = 0; i < 14; i += 1) assert.equal((await run({ action: 'screenshot' })).ok, true);
    const shotDir = path.dirname(shot.path);
    assert.equal(fs.readdirSync(shotDir).length, 12, 'only the newest screenshots are kept');

    // With the panel open the page on screen captures directly.
    const win = new BrowserWindow({ show: true, width: 900, height: 700 });
    await win.loadURL('about:blank');
    browserManager.setWindow(win);
    browserManager.open({ sessionId: chat });
    browserManager.navigate({ sessionId: chat, url: `${base}/form` });
    browserManager.setPanelBounds({ sessionId: chat, viewport: { x: 0, y: 0, width: 900, height: 700 } });
    const end = Date.now() + 8000;
    while (Date.now() < end && (contents().isLoading() || contents().getURL() !== `${base}/form`)) await new Promise((r) => setTimeout(r, 50));
    // While the user can see the page, the agent's pointer shows where it
    // acts; it is taken off the page before a screenshot.
    const visibleSnap = (await run({ action: 'snapshot' })).snapshot;
    result = await run({ action: 'hover', ...node(visibleSnap, (n) => n.text === 'Hover me') });
    assert.equal(result.ok, true, result.message);
    assert.equal(await js('!!document.getElementById("__aegis_agent_pointer")'), true, 'the pointer is drawn on a visible page');
    assert.equal(await js('typeof window.__aegisPointerTimer'), 'undefined', "the pointer's script runs outside the page's world");
    result = await run({ action: 'screenshot' });
    assert.equal(result.ok, true, result.message);
    assert.equal(await js('!!document.getElementById("__aegis_agent_pointer")'), false, 'the pointer is removed before capture');
    assert.equal(result.screenshot.width, 900, 'the visible page is captured at its panel size');
    const visible = nativeImage.createFromPath(result.screenshot.path).toBitmap();
    assert.ok(visible[(60 * 900 + 60) * 4] > 200, 'the visible capture shows the page');

    // Turn end releases every tab the agent held; the pages stay live.
    finishBrowserUseTurn(browserManager, chat);
    assert.equal(browserManager.getState({ sessionId: chat }).agentActive, false);
    assert.ok(contents(), 'the main page stays live after the turn');
    await forgetBrowserUseScreenshots(chat);
    assert.equal(fs.existsSync(shotDir), false, 'deleting the chat removes its screenshots');

    console.log('PASS browser_use actions: screenshot, type/clear, select, hover, wait, scroll, back/forward, keys, tabs, turn end');
  } catch (error) {
    console.error(error);
    code = 1;
  } finally {
    clearTimeout(timeout);
    browserManager.dispose();
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    server.close();
    fs.rmSync(temp, { recursive: true, force: true });
    app.exit(code);
  }
});
