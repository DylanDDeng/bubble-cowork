const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const { existsSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
process.env.AEGIS_BROWSER_USE_TEST_MODE = '1';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function addressUrl(server, suffix = '') {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return `http://127.0.0.1:${address.port}${suffix}`;
}

function sseChunk(requestNumber, model, delta, finishReason = null, usage) {
  return {
    id: `browser-use-e2e-${requestNumber}`,
    object: 'chat.completion.chunk',
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  let pageServer;
  let apiServer;
  let harness;
  let runtimeConfig;
  let descriptor;
  let hostWindow;
  const workspace = mkdtempSync(path.join(tmpdir(), 'aegis-browser-e2e-workspace-'));
  const sessionRoot = mkdtempSync(path.join(tmpdir(), 'aegis-browser-e2e-sessions-'));
  try {
    const { browserManager } = require(path.join(root, 'dist-electron/electron/browserManager.js'));
    const {
      createBrowserUseSessionMcpDescriptor,
      disposeBrowserUseHttpServer,
    } = require(path.join(root, 'dist-electron/electron/libs/browser-use-http-server.js'));
    const { finishBrowserUseTurn } = require(
      path.join(root, 'dist-electron/electron/libs/browser-use.js')
    );
    const { createDeepseekMcpRuntimeConfig } = require(
      path.join(root, 'dist-electron/electron/libs/deepseek-mcp-settings.js')
    );
    const { DeepSeekHarness } = await import('@deepseek-ai/dsh-sdk-client');

    hostWindow = new BrowserWindow({ width: 900, height: 700, show: false });
    browserManager.setWindow(hostWindow);

    pageServer = http.createServer((request, response) => {
      const marker = request.url?.includes('session-a')
        ? 'SESSION_A_BROWSER'
        : request.url?.includes('session-b')
          ? 'SESSION_B_BROWSER'
          : 'DEEPSEEK_BROWSER_E2E';
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        `<!doctype html><title>Aegis browser E2E</title><button id="fixture">${marker}</button>`
      );
    });
    await listen(pageServer);
    const pageUrl = addressUrl(pageServer, '/fixture');

    let requestCount = 0;
    let sawNavigateResult = false;
    let sawSnapshotResult = false;
    let exposedBrowserTool = false;
    let lastToolMessages = [];
    apiServer = http.createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        requestCount += 1;
        lastToolMessages = (body.messages || []).filter((message) => message.role === 'tool');
        exposedBrowserTool ||= body.tools?.some(
          (tool) => tool.function?.name === 'mcp__aegis-browser__browser_use'
        );
        sawNavigateResult ||= body.messages?.some(
          (message) =>
            message.role === 'tool' && JSON.stringify(message.content).includes('Navigated to')
        );
        sawSnapshotResult ||= body.messages?.some(
          (message) =>
            message.role === 'tool' &&
            JSON.stringify(message.content).includes('DEEPSEEK_BROWSER_E2E')
        );
        const write = (delta, finishReason = null, usage) =>
          response.write(
            `data: ${JSON.stringify(
              sseChunk(requestCount, body.model, delta, finishReason, usage)
            )}\n\n`
          );
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (requestCount === 1) {
          write({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_browser_navigate',
                type: 'function',
                function: {
                  name: 'mcp__aegis-browser__browser_use',
                  arguments: JSON.stringify({ action: 'navigate', url: pageUrl }),
                },
              },
            ],
          });
          write({}, 'tool_calls');
        } else if (requestCount === 2) {
          write({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_browser_snapshot',
                type: 'function',
                function: {
                  name: 'mcp__aegis-browser__browser_use',
                  arguments: JSON.stringify({ action: 'snapshot' }),
                },
              },
            ],
          });
          write({}, 'tool_calls');
        } else {
          write({ role: 'assistant', content: 'BROWSER_E2E_OK' });
          write({}, 'stop');
        }
        write({}, null, {
          prompt_tokens: 10,
          completion_tokens: 1,
          total_tokens: 11,
          prompt_cache_hit_tokens: 0,
          prompt_cache_miss_tokens: 10,
        });
        response.end('data: [DONE]\n\n');
      });
    });
    await listen(apiServer);

    const threadId = 'deepseek-browser-e2e-session';
    descriptor = await createBrowserUseSessionMcpDescriptor(threadId);
    const profileDir = path.join(root, 'dev-fixtures/deepseek-harness');
    runtimeConfig = createDeepseekMcpRuntimeConfig(profileDir, workspace, {
      'aegis-browser': {
        type: 'http',
        url: descriptor.url,
        headers: descriptor.headers,
      },
    });
    harness = new DeepSeekHarness({
      launch: {
        command: process.execPath,
        args: [path.join(profileDir, 'runtime-bin.mjs'), runtimeConfig.configPath],
        cwd: profileDir,
        env: {
          ...process.env,
          DEEPSEEK_API_KEY: 'local-browser-use-e2e',
          DEEPSEEK_BASE_URL: addressUrl(apiServer),
          DSH_CWD: workspace,
          DSH_SESSION_ROOT: sessionRoot,
          DSH_PERMISSION_MODE: 'workspace-write',
          DSH_REASONING_EFFORT: 'max',
          AEGIS_DSH_AGENT_PRESET: 'standard',
          ELECTRON_RUN_AS_NODE: '1',
        },
        requestTimeoutMs: 35_000,
      },
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      cwd: workspace,
    });

    const result = await harness.run('Navigate with browser_use and snapshot the page.');
    if (result.finalResponse !== 'BROWSER_E2E_OK') throw new Error('mock model turn did not finish');
    if (!exposedBrowserTool || !sawNavigateResult || !sawSnapshotResult) {
      throw new Error(
        `browser tool loop incomplete: ${JSON.stringify({
          exposedBrowserTool,
          sawNavigateResult,
          sawSnapshotResult,
          requestCount,
          lastToolMessages,
        })}`
      );
    }
    const stateBeforeRelease = browserManager.getState({ sessionId: threadId });
    if (stateBeforeRelease.open || !stateBeforeRelease.activeTabId) {
      throw new Error('Browser Use did not create a detached session tab');
    }
    const tabId = stateBeforeRelease.activeTabId;
    if (!browserManager.getLiveWebContents(threadId, tabId)) {
      throw new Error('detached browser runtime was not live during the turn');
    }

    const runtimeConfigPath = runtimeConfig.configPath;
    await harness.close();
    harness = null;
    runtimeConfig.dispose();
    runtimeConfig = null;
    if (existsSync(runtimeConfigPath)) {
      throw new Error('DeepSeek temporary MCP config survived normal runtime disposal');
    }

    finishBrowserUseTurn(browserManager, threadId);
    if (browserManager.getLiveWebContents(threadId, tabId)) {
      throw new Error('turn cleanup did not release the detached runtime');
    }

    // Two capability-bound clients issuing the same actions concurrently must
    // remain isolated in their own Aegis session tabs.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import(
      '@modelcontextprotocol/sdk/client/streamableHttp.js'
    );
    const sessionA = await createBrowserUseSessionMcpDescriptor('browser-session-a');
    const sessionB = await createBrowserUseSessionMcpDescriptor('browser-session-b');
    const clientA = new Client({ name: 'browser-session-a-test', version: '1.0.0' });
    const clientB = new Client({ name: 'browser-session-b-test', version: '1.0.0' });
    await Promise.all([
      clientA.connect(
        new StreamableHTTPClientTransport(new URL(sessionA.url), {
          requestInit: { headers: sessionA.headers },
        })
      ),
      clientB.connect(
        new StreamableHTTPClientTransport(new URL(sessionB.url), {
          requestInit: { headers: sessionB.headers },
        })
      ),
    ]);
    await Promise.all([
      clientA.callTool({
        name: 'browser_use',
        arguments: { action: 'navigate', url: addressUrl(pageServer, '/session-a') },
      }),
      clientB.callTool({
        name: 'browser_use',
        arguments: { action: 'navigate', url: addressUrl(pageServer, '/session-b') },
      }),
    ]);
    const [snapshotA, snapshotB] = await Promise.all([
      clientA.callTool({ name: 'browser_use', arguments: { action: 'snapshot' } }),
      clientB.callTool({ name: 'browser_use', arguments: { action: 'snapshot' } }),
    ]);
    if (!JSON.stringify(snapshotA).includes('SESSION_A_BROWSER')) {
      throw new Error(`session A received the wrong snapshot: ${JSON.stringify(snapshotA)}`);
    }
    if (!JSON.stringify(snapshotB).includes('SESSION_B_BROWSER')) {
      throw new Error(`session B received the wrong snapshot: ${JSON.stringify(snapshotB)}`);
    }
    if (JSON.stringify(snapshotA).includes('SESSION_B_BROWSER')) {
      throw new Error('session A snapshot leaked session B content');
    }
    await Promise.all([clientA.close(), clientB.close()]);
    finishBrowserUseTurn(browserManager, 'browser-session-a');
    finishBrowserUseTurn(browserManager, 'browser-session-b');
    sessionA.dispose();
    sessionB.dispose();

    const expiredHeaders = { ...descriptor.headers, 'content-type': 'application/json' };
    descriptor.dispose();
    const expiredResponse = await fetch(descriptor.url, {
      method: 'POST',
      headers: expiredHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'expired-capability-check', version: '1.0.0' },
        },
      }),
    });
    if (expiredResponse.status !== 403) {
      throw new Error(`expired session capability returned HTTP ${expiredResponse.status}`);
    }

    console.log(
      `BROWSER_USE_E2E_RESULT:${JSON.stringify({
        ok: true,
        requestCount,
        exposedBrowserTool,
        sawNavigateResult,
        sawSnapshotResult,
        hiddenRuntimeReleased: true,
        expiredCapabilityRejected: true,
        concurrentSessionIsolation: true,
      })}`
    );
    disposeBrowserUseHttpServer();
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  } finally {
    if (harness) await harness.close().catch(() => {});
    runtimeConfig?.dispose();
    descriptor?.dispose();
    if (pageServer) await close(pageServer).catch(() => {});
    if (apiServer) await close(apiServer).catch(() => {});
    hostWindow?.destroy();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(sessionRoot, { recursive: true, force: true });
  }
});
