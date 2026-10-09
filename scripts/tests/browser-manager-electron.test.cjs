// The in-app browser manager against real page views and a local HTTP server:
// panel lifecycle, a navigation sent while the panel is hidden, load failures
// that stay explained, crash recovery, browser_use's hidden pages, the live
// page budget, and the state pushed to listeners.
const { app, BrowserWindow, dialog } = require('electron');
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

    // The browser partition refuses what it should never grant, and its
    // synchronous checks only report what is allowed outright.
    const permissionProbe = await live('A').executeJavaScript(`(async () => {
      const midi = await navigator.requestMIDIAccess().then(() => 'granted', () => 'denied');
      const camera = (await navigator.permissions.query({ name: 'camera' })).state;
      const geolocation = (await navigator.permissions.query({ name: 'geolocation' })).state;
      return { midi, camera, geolocation };
    })()`);
    assert.equal(permissionProbe.midi, 'denied', 'MIDI access is refused');
    assert.notEqual(permissionProbe.camera, 'granted', 'camera is not granted without asking');
    assert.notEqual(permissionProbe.geolocation, 'granted', 'location is not granted without asking');

    // Sensitive requests ask once per site in a native dialog (stubbed here),
    // and the answer holds: concurrent asks share one dialog.
    const asked = [];
    dialog.showMessageBox = async (_window, options) => {
      asked.push(options.message);
      return { response: /notifications/.test(options.message) ? 0 : 1 };
    };
    const notify = () => live('A').executeJavaScript('Notification.requestPermission()', true);
    assert.equal(await notify(), 'granted', 'Allow grants the request');
    assert.equal(await notify(), 'granted');
    const locate = () => live('A').executeJavaScript(
      'new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve("granted"), (error) => resolve(error.code === 1 ? "denied" : "error:" + error.code)))',
      true
    );
    assert.deepEqual(await Promise.all([locate(), locate()]), ['denied', 'denied'], 'Block refuses the request');
    assert.equal(await locate(), 'denied');
    assert.deepEqual(asked, [
      `${new URL(base).host} wants to show notifications.`,
      `${new URL(base).host} wants to use your location.`,
    ], 'one dialog per site and capability');

    // Find in page reports matches; an empty search clears it.
    const found = [];
    const stopFindListener = browserManager.subscribeFind((result) => found.push(result));
    await live('A').executeJavaScript('document.body.insertAdjacentHTML("beforeend", "<p>apple apple apple</p>")');
    browserManager.find({ sessionId: 'A', text: 'apple' });
    await until(() => found.some((r) => r.matches === 3), 'three matches');
    browserManager.find({ sessionId: 'A', text: 'apple', findNext: true });
    await until(() => found.some((r) => r.matches === 3 && r.active === 2), 'moves to the second match');
    browserManager.find({ sessionId: 'A', text: '' });
    assert.deepEqual(found.at(-1), { sessionId: 'A', active: 0, matches: 0 });
    stopFindListener();

    // Zoom steps along Chrome's ladder and is reported on the page.
    browserManager.zoom({ sessionId: 'A', direction: 'in' });
    assert.equal(state('A').page.zoom, 1.1);
    assert.equal(live('A').getZoomFactor(), 1.1);
    browserManager.zoom({ sessionId: 'A', direction: 'reset' });
    assert.equal(state('A').page.zoom, 1);

    // Browser keys pressed inside the page are claimed for the browser and
    // never reach the page's own handlers (nor the app menu).
    const shortcuts = [];
    const stopShortcuts = browserManager.subscribeShortcut((sessionId, action) => shortcuts.push([sessionId, action]));
    await live('A').executeJavaScript('window.__keys = []; addEventListener("keydown", (e) => __keys.push(e.key))');
    live('A').focus();
    const mod = process.platform === 'darwin' ? 'meta' : 'control';
    live('A').sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: [mod] });
    live('A').sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: [mod] });
    live('A').sendInputEvent({ type: 'keyDown', keyCode: 'K' });
    await until(() => shortcuts.length >= 2, 'page shortcuts claimed');
    assert.deepEqual(shortcuts, [['A', 'reload'], ['A', 'focus-address']]);
    await wait(100);
    assert.deepEqual(await live('A').executeJavaScript('__keys'), ['k'], 'claimed keys never reach the page; plain keys do');
    stopShortcuts();

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
    const agentContents = live('B');
    browserManager.releaseAgentSession('B');
    assert.equal(live('B'), agentContents, 'the page the agent left stays live after the turn');
    assert.equal(state('B').page.phase, 'live');
    assert.equal(state('B').agentActive, false);
    assert.equal(BrowserWindow.getAllWindows().length, 1, 'the hidden agent window closes with the last hold');

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
    // Live off-screen pages stay within budget: the longest unseen go first.
    for (let i = 1; i <= 7; i += 1) {
      browserManager.open({ sessionId: `P${i}`, initialUrl: `${base}/p${i}` });
      browserManager.setPanelBounds({ sessionId: `P${i}`, viewport });
      await until(() => state(`P${i}`).page.title === `Page /p${i}`, `P${i} loads`);
    }
    assert.equal(live('B'), null, 'the longest unseen page is suspended first');
    assert.equal(live('A'), null, 'then the next longest unseen');
    assert.equal(state('A').page.phase, 'suspended');
    for (let i = 1; i <= 7; i += 1) assert.ok(live(`P${i}`), `P${i} stays live`);
    // Coming back to a suspended page loads it again and keeps the budget.
    browserManager.setPanelBounds({ sessionId: 'A', viewport });
    await until(() => live('A') && !live('A').isLoading() && live('A').getURL() === `${base}/after-crash`, 'A wakes');
    assert.equal(live('P1'), null, 'waking one page suspends the longest unseen other');
    assert.ok(live('P7'), 'the page just left stays live');

    // Deleting a chat closes its browser pages, extra tabs included.
    browserManager.open({ sessionId: 'P3:browser:extra', initialUrl: `${base}/extra` });
    browserManager.closeChat('P3');
    assert.equal(live('P3'), null);
    assert.equal(state('P3').page, null);
    assert.equal(state('P3:browser:extra').page, null);
    assert.ok(live('P4'), 'other chats keep their pages');

    assert.throws(() => browserManager.navigate({ sessionId: 'A', url: 'file://remote/share/x.html' }), /local file/);
    // A remembered address that can't load here seeds a blank page instead of
    // failing the panel's open.
    const remembered = browserManager.open({ sessionId: 'R', initialUrl: 'file://remote/share/x.html' });
    assert.equal(remembered.page.url, 'about:blank');
    browserManager.close({ sessionId: 'R' });

    console.log('PASS browser manager: lifecycle, find, zoom, page shortcuts, hidden navigation, kept load errors, crash recovery, agent pages, panel handoff, live page budget, close');
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
