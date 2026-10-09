// Bubble's browser_use host tool through the real Bubble SDK and real page
// views, with a scripted model: the tool is offered up front (not deferred
// behind tool_search) under its MCP name, navigates and screenshots the
// session's page, and the screenshot reaches the next model request as an
// image. Nothing is read from or written to ~/.bubble.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-bubble-browser-'));
app.setPath('userData', path.join(temp, 'profile'));
process.env.BUBBLE_HOME = path.join(temp, 'bubble-home');
process.env.AEGIS_BROWSER_SCREENSHOT_DIR = path.join(temp, 'shots');
process.env.AEGIS_BROWSER_USE_SETTINGS_PATH = path.join(temp, 'browser-use.json');
fs.writeFileSync(process.env.AEGIS_BROWSER_USE_SETTINGS_PATH, JSON.stringify({ enabled: true, defaultPolicy: 'ask', origins: {} }));
app.on('window-all-closed', () => {});
const timeout = setTimeout(() => {
  console.error('bubble browser_use test timed out');
  app.exit(1);
}, 90000);

app.whenReady().then(async () => {
  let code = 0;
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Bubble page</title><body style="margin:0"><div style="width:240px;height:120px;background:rgb(0,128,255)"></div>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const { browserManager } = require('../../dist-electron/electron/browserManager.js');
  try {
    const { BubbleSdk } = await import('@bubblebrain-ai/bubble');
    const { registerDynamicModelMetadata } = await import('@bubblebrain-ai/bubble/dist/model-catalog.js');
    const loader = require('../../dist-electron/electron/libs/provider/bubble-sdk-loader.js');
    const { BubbleSdkAdapter } = require('../../dist-electron/electron/libs/provider/bubble-sdk-adapter.js');
    const { emptyCostDetails } = require('../../dist-electron/electron/libs/agent-cost.js');
    const { BUBBLE_BROWSER_USE_TOOL } = require('../../dist-electron/electron/libs/bubble-browser-use-tool.js');
    assert.equal(BUBBLE_BROWSER_USE_TOOL, 'mcp__aegis-browser__browser_use');
    registerDynamicModelMetadata({ providerId: 'openai', id: 'aegis-browser-test', contextWindow: 128000 });

    const cwd = path.join(temp, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    const sdk = new BubbleSdk({ defaultCwd: cwd, mcp: false });
    const adapter = new BubbleSdkAdapter();
    const threadId = 'bubble-browser-thread';
    const session = {
      threadId, providerSessionId: sdk.createSession({ cwd }).id, cwd, status: 'running', turnActive: true,
      permissionMode: 'bypassPermissions', planExitMode: 'default',
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }, costDetails: emptyCostDetails(), durationStartMs: Date.now(),
      pendingRequests: new Map(), subagentStreams: new Map(), subagentStartedAt: new Map(), toolNames: new Map(),
      heldSpawnResults: new Map(), emittedToolCallIds: new Set(), emittedToolResultIds: new Set(), currentAssistant: null,
    };
    adapter.sessions.set(threadId, session);
    const events = [];
    adapter.events.on('event', (event) => {
      events.push(event);
      if (event.type === 'permission_request') void adapter.respondToRequest(threadId, event.requestId, { behavior: 'allow' });
    });

    const requests = [];
    let step = 0;
    sdk.resolveProvider = () => ({
      providerId: 'openai',
      model: 'aegis-browser-test',
      provider: {
        async *streamChat(messages, options) {
          requests.push({ messages: JSON.stringify(messages), tools: (options.tools || []).map((tool) => tool.name) });
          const call = (id, args) => ({ type: 'tool_call', id, name: BUBBLE_BROWSER_USE_TOOL, arguments: JSON.stringify(args), isStart: true, isEnd: true });
          if (step === 0) yield call('nav-1', { action: 'navigate', url });
          else if (step === 1) yield call('shot-1', { action: 'screenshot' });
          else yield { type: 'text', content: 'The page shows a blue box.' };
          step += 1;
          yield { type: 'usage', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } };
          yield { type: 'done' };
        },
      },
    });
    loader.getBubbleSdk = async () => sdk;

    await adapter.runTurnLoop(session, 'Look at the page');
    assert.equal(session.status, 'completed', JSON.stringify(events.filter((e) => e.type === 'error')));
    assert.ok(requests[0].tools.includes(BUBBLE_BROWSER_USE_TOOL), 'browser_use is offered on the first request, not behind tool_search');
    assert.equal(requests.length, 3);
    assert.match(requests[1].messages, /Navigated to http:\/\/127\.0\.0\.1/);
    assert.match(requests[2].messages, /Screenshot 1280x800/);
    assert.match(requests[2].messages, /data:image\/jpeg;base64,/, 'the screenshot reaches the model as an image');

    // The session's own page was driven, and the Aegis session owns it.
    const page = browserManager.getState({ sessionId: threadId }).page;
    assert.equal(page && page.url, url);
    assert.equal(fs.existsSync(path.join(process.env.BUBBLE_HOME, 'settings.json')) &&
      fs.readFileSync(path.join(process.env.BUBBLE_HOME, 'settings.json'), 'utf8').includes('aegis-browser'), false,
      'nothing is written to Bubble settings');

    console.log('PASS bubble browser_use: host tool offered up front, navigate + screenshot, image reaches the model');
  } catch (error) {
    console.error(error);
    code = 1;
  } finally {
    clearTimeout(timeout);
    browserManager.dispose();
    server.close();
    fs.rmSync(temp, { recursive: true, force: true });
    app.exit(code);
  }
});
