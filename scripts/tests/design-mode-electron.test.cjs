// Design mode against real page views: on a site other than the user's own
// dev pages the inspector lives in an isolated world (the page can't see or
// forge it); dragging marks an area and annotating it reports what's inside;
// a click still selects one element; localhost keeps the page world.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-design-mode-'));
app.setPath('userData', path.join(temp, 'profile'));
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => {
  console.error('design mode test timed out');
  app.exit(1);
}, 60000);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await wait(50);
  }
  throw new Error(`timed out: ${label}`);
}

const PAGE = `<!doctype html><title>Pricing</title><body style="margin:0;font:16px sans-serif">
<section id="plans" style="position:absolute;left:40px;top:40px;width:300px;height:160px">
  <h2 class="title" style="margin:0">Plans</h2>
  <div class="grid">Basic · Pro</div>
</section>
<button id="buy" style="position:absolute;left:40px;top:300px;width:120px;height:40px">Buy now</button>
</body>`;

app.whenReady().then(async () => {
  const { browserManager, BROWSER_SESSION_PARTITION } = require('../../dist-electron/electron/browserManager.js');
  const { designModeService } = require('../../dist-electron/electron/design-mode-service.js');
  // A non-local site, served from inside the browser partition (no network).
  session.fromPartition(BROWSER_SESSION_PARTITION).protocol.handle('https', () =>
    new Response(PAGE, { headers: { 'content-type': 'text/html' } })
  );
  const local = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(PAGE);
  });
  await new Promise((resolve) => local.listen(0, '127.0.0.1', resolve));
  const events = [];
  const stop = designModeService.subscribe((event) => events.push(event));
  let win;
  let code = 0;
  try {
    win = new BrowserWindow({ show: true, width: 800, height: 600 });
    await win.loadURL('about:blank');
    browserManager.setWindow(win);
    const viewport = { x: 0, y: 0, width: 800, height: 600 };
    browserManager.open({ sessionId: 'D', initialUrl: 'https://example.test/pricing' });
    browserManager.setPanelBounds({ sessionId: 'D', viewport });
    const pageId = browserManager.getState({ sessionId: 'D' }).page.id;
    const wc = () => browserManager.getLiveWebContents('D', pageId);
    await until(() => wc() && !wc().isLoading() && wc().getTitle() === 'Pricing', 'page loads');

    const enabled = await designModeService.enable({ sessionId: 'D', tabId: pageId, projectRoot: '' });
    assert.equal(enabled.ok, true, enabled.message);
    assert.equal(enabled.capabilities.localhost, false);
    assert.equal(await wc().executeJavaScript('typeof window.__aegisDesign'), 'undefined', 'the page cannot see the inspector');
    assert.equal(
      await wc().executeJavaScriptInIsolatedWorld(1920, [{ code: 'typeof window.__aegisDesign' }]),
      'object',
      'the inspector runs in its isolated world'
    );

    // Drag over the plans section: an area selection.
    const drag = [
      { type: 'mouseDown', x: 30, y: 30, button: 'left', clickCount: 1 },
      { type: 'mouseMove', x: 120, y: 90, button: 'left' },
      { type: 'mouseMove', x: 360, y: 220, button: 'left' },
      { type: 'mouseUp', x: 360, y: 220, button: 'left', clickCount: 1 },
    ];
    for (const input of drag) {
      wc().sendInputEvent(input);
      await wait(30);
    }
    const area = await until(() => events.find((e) => e.kind === 'selection' && e.info.region), 'area selection');
    assert.equal(area.info.tagName, 'region');
    assert.ok(area.info.elements.some((label) => label.startsWith('section')), `outermost element listed: ${area.info.elements}`);
    assert.ok(!events.some((e) => e.kind === 'selection' && !e.info.region), 'the click after a drag selects nothing');

    // Describe the change in the in-page bubble and submit.
    await wc().executeJavaScriptInIsolatedWorld(1920, [{
      code: `(() => {
        const input = document.querySelector('[data-aegis-ui] input');
        input.value = 'Tighten this section';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return true;
      })()`,
    }]);
    const annotated = await until(() => events.find((e) => e.kind === 'annotate'), 'area annotation');
    assert.equal(annotated.note, 'Tighten this section');
    assert.equal(annotated.info.region, true);
    assert.ok(annotated.info.rect.w > 300 && annotated.info.rect.h > 180, 'the area travels with the annotation');

    // A plain click still selects one element.
    wc().sendInputEvent({ type: 'mouseDown', x: 100, y: 320, button: 'left', clickCount: 1 });
    wc().sendInputEvent({ type: 'mouseUp', x: 100, y: 320, button: 'left', clickCount: 1 });
    const clicked = await until(() => events.find((e) => e.kind === 'selection' && !e.info.region), 'element selection');
    assert.equal(clicked.info.tagName, 'button');
    await designModeService.disable({ sessionId: 'D', tabId: pageId });

    // The user's own dev page keeps the page world (React source data).
    browserManager.navigate({ sessionId: 'D', url: `http://127.0.0.1:${local.address().port}/` });
    await until(() => wc() && !wc().isLoading() && wc().getURL().startsWith('http://127.0.0.1'), 'local page loads');
    const localEnabled = await designModeService.enable({ sessionId: 'D', tabId: pageId, projectRoot: '' });
    assert.equal(localEnabled.ok, true, localEnabled.message);
    assert.equal(await wc().executeJavaScript('typeof window.__aegisDesign'), 'object', 'dev pages keep the page world');
    await designModeService.disable({ sessionId: 'D', tabId: pageId });

    console.log('PASS design mode: isolated world off localhost, area selection + annotation, element click, page world on localhost');
  } catch (error) {
    console.error(error);
    code = 1;
  } finally {
    clearTimeout(timeout);
    stop();
    browserManager.dispose();
    local.close();
    if (win && !win.isDestroyed()) win.destroy();
    fs.rmSync(temp, { recursive: true, force: true });
    app.exit(code);
  }
});
