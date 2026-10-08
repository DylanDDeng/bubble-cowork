// The in-app browser manager against real page views and a local HTTP server:
// panel lifecycle, a navigation sent while the panel is hidden, load failures
// that stay explained, crash recovery, browser_use's hidden pages, and the
// state pushed to listeners.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-browser-manager-'));
app.setPath('userData', path.join(temp, 'profile'));
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => {
  console.error('browser manager test timed out');
  app.exit(1);
}, 60000);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await wait(40);
  }
  throw new Error(`timed out: ${label}`);
}

app.whenReady().then(async () => {
  const { browserManager } = require('../../dist-electron/electron/browserManager.js');
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>Page ${req.url}</title><h1>${req.url}</h1><a href="/linked">link</a>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  // A port that was just free: connecting to it is refused.
  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const refusedUrl = `http://127.0.0.1:${closed.address().port}/`;
  await new Promise((resolve) => closed.close(resolve));
  const pushes = [];
  const stopListening = browserManager.subscribe((state) => pushes.push(state));
  let win;
  let code = 0;
  try {
    win = new BrowserWindow({ show: true, width: 1000, height: 700 });
    await win.loadURL('about:blank');
    browserManager.setWindow(win);
    const viewport = { x: 0, y: 40, width: 1000, height: 660 };
    const state = (id) => browserManager.getState({ sessionId: id });
    const live = (id) => {
      const page = state(id).page;
      return page ? browserManager.getLiveWebContents(id, page.id) : null;
    };
    const shownChildren = () => win.contentView.children.length;

    // Open + show: one page, loaded, on screen.
    const opened = browserManager.open({ sessionId: 'A', initialUrl: `${base}/a` });
    assert.equal(opened.open, true);
    assert.ok(opened.page && opened.page.id);
    const pageId = opened.page.id;
    browserManager.setPanelBounds({ sessionId: 'A', viewport });
    await until(() => state('A').page.title === 'Page /a' && !state('A').page.loading, 'A loads');
    assert.equal(state('A').page.phase, 'live');
    assert.equal(shownChildren(), 1, 'the page view is on the window');
    assert.ok(pushes.some((push) => push.sessionId === 'A' && push.page && push.page.loading), 'loading is pushed');

    // A navigation sent while the panel is hidden (view still alive) loads at
    // once and survives showing the panel again.
    browserManager.hide({ sessionId: 'A' });
    assert.equal(shownChildren(), 0, 'hiding takes the view off the window');
    browserManager.navigate({ sessionId: 'A', url: `${base}/while-hidden` });
    await until(() => live('A') && live('A').getURL() === `${base}/while-hidden` && !live('A').isLoading(), 'hidden navigation loads');
    browserManager.setPanelBounds({ sessionId: 'A', viewport });
    await wait(300);
    assert.equal(state('A').page.url, `${base}/while-hidden`, 'showing again keeps the new address');
    assert.equal(state('A').page.id, pageId, 'the page keeps its id');

    // Back/forward follow the view's history.
    browserManager.navigate({ sessionId: 'A', url: `${base}/second` });
    await until(() => state('A').page.url === `${base}/second` && !state('A').page.loading && state('A').page.canBack, 'second page');
    browserManager.goBack({ sessionId: 'A' });
    await until(() => state('A').page.url === `${base}/while-hidden` && state('A').page.canForward, 'went back');

    // A refused connection keeps its specific message after loading stops.
    browserManager.navigate({ sessionId: 'A', url: refusedUrl });
    await until(() => state('A').page.error, 'load failure reported');
    await wait(500);
    assert.equal(state('A').page.error, 'Connection refused.');
    assert.equal(state('A').page.loading, false);
    browserManager.navigate({ sessionId: 'A', url: `${base}/recovered` });
    await until(() => state('A').page.url === `${base}/recovered` && !state('A').page.loading, 'recovers');
    assert.equal(state('A').page.error, null, 'a new navigation clears the failure');

    // Readout and capture work on the live page.
    const readout = await browserManager.readPageContent({ sessionId: 'A' });
    assert.equal(readout.ok, true);
    assert.equal(readout.title, 'Page /recovered');
    assert.ok(readout.links.some((link) => link.url === `${base}/linked`));
    const shot = await browserManager.capturePage({ sessionId: 'A' });
    assert.equal(shot.ok, true, shot.message);

    // A crashed renderer is replaced; the new view is not blocked by the old one.
    const crashed = live('A');
    crashed.forcefullyCrashRenderer();
    await until(() => live('A') && live('A') !== crashed && !live('A').isLoading() && live('A').getURL() === `${base}/recovered`, 'crash recovery reloads in a new view');
    browserManager.navigate({ sessionId: 'A', url: `${base}/after-crash` });
    await until(() => state('A').page.url === `${base}/after-crash` && !state('A').page.loading, 'the replacement view takes navigation');

    // browser_use with the panel closed: a hidden page, released after the turn.
    const target = browserManager.acquireAgentTarget('B');
    assert.equal(target.visible, false);
    await target.restore;
    await target.webContents.loadURL(`${base}/agent`);
    await until(() => state('B').page && state('B').page.url === `${base}/agent`, 'agent page state');
    assert.equal(state('B').open, false, 'agent pages do not open the panel');
    assert.equal(shownChildren(), 1, 'only the visible panel page is on the window');
    let sawActive = false;
    await browserManager.withAgentActivity('B', async () => {
      sawActive = state('B').agentActive;
    });
    assert.equal(sawActive, true);
    assert.equal(state('B').agentActive, false);
    browserManager.releaseAgentSession('B');
    assert.equal(live('B'), null, 'release drops the hidden page');
    assert.equal(state('B').page.phase, 'suspended');

    // Agent on the visible session keeps the same live page after release.
    const visibleTarget = browserManager.acquireAgentTarget('A');
    assert.equal(visibleTarget.visible, true);
    assert.equal(visibleTarget.webContents, live('A'));
    browserManager.releaseAgentSession('A');
    assert.ok(live('A'), 'a page on screen stays live');

    // Opening another session takes over the panel; the first stays live for now.
    browserManager.open({ sessionId: 'C', initialUrl: `${base}/c` });
    browserManager.setPanelBounds({ sessionId: 'C', viewport });
    await until(() => state('C').page.title === 'Page /c', 'C loads');
    assert.equal(shownChildren(), 1, 'one page on the window at a time');
    assert.ok(live('A'), 'the previous session waits for its idle timer');

    // Close tears the page down.
    browserManager.close({ sessionId: 'C' });
    assert.equal(state('C').page, null);
    assert.equal(state('C').open, false);
    assert.equal(shownChildren(), 0);
    assert.throws(() => browserManager.navigate({ sessionId: 'A', url: 'file://remote/share/x.html' }), /local file/);

    console.log('PASS browser manager: lifecycle, hidden navigation, kept load errors, crash recovery, agent pages, panel handoff, close');
  } catch (error) {
    console.error(error);
    code = 1;
  } finally {
    clearTimeout(timeout);
    stopListening();
    browserManager.dispose();
    server.close();
    if (win && !win.isDestroyed()) win.destroy();
    fs.rmSync(temp, { recursive: true, force: true });
    app.exit(code);
  }
});
