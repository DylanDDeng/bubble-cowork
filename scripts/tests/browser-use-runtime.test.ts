import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  finishBrowserUseTurn,
  runBrowserUseAction,
  waitForBrowserPageReady,
} from '../../src/electron/libs/browser-use';
import {
  initializeBrowserUseConsent,
  requestBrowserUseNavigationConsent,
  setBrowserUseSessionFullAccess,
} from '../../src/electron/libs/browser-use-consent';
import { saveBrowserUsePermissionSettings } from '../../src/electron/libs/browser-use-permissions';
import { createGrokAcpHttpMcpServer } from '../../src/electron/libs/provider/grok-acp-mcp';
import { AcpJsonRpcError } from '../../src/electron/libs/provider/acp-json-rpc-client';

type SnapshotShape = {
  url: string;
  title: string;
  viewportWidth: number;
  viewportHeight: number;
  scrollX: number;
  scrollY: number;
  nodes: Array<Record<string, unknown>>;
  textPreview: string;
};

class FakeWebContents extends EventEmitter {
  destroyed = false;
  loading = false;
  stopped = false;
  url = 'about:blank';
  executeDelayMs = 0;
  neverFinishNavigation = false;
  activeExecutions = 0;
  maxActiveExecutions = 0;

  isDestroyed() {
    return this.destroyed;
  }

  isLoading() {
    return this.loading;
  }

  stop() {
    this.stopped = true;
    this.loading = false;
    this.emit('did-stop-loading');
  }

  async loadURL(url: string): Promise<void> {
    this.loading = true;
    this.url = url;
    this.emit('did-start-loading');
    if (this.neverFinishNavigation) return new Promise<void>(() => {});
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.loading = false;
    this.emit('did-navigate');
    this.emit('did-stop-loading');
  }

  async executeJavaScript(script: string): Promise<SnapshotShape | { scrollX: number; scrollY: number }> {
    this.activeExecutions += 1;
    this.maxActiveExecutions = Math.max(this.maxActiveExecutions, this.activeExecutions);
    await new Promise((resolve) => setTimeout(resolve, this.executeDelayMs));
    this.activeExecutions -= 1;
    if (script.includes('Math.round(scrollX)')) return { scrollX: 0, scrollY: 0 };
    return {
      url: this.url,
      title: 'Fixture',
      viewportWidth: 1280,
      viewportHeight: 800,
      scrollX: 0,
      scrollY: 0,
      nodes: [],
      textPreview: 'Aegis browser fixture',
    };
  }

  sendInputEvent() {}
}

class FakeBrowserManager {
  readonly contents = new Map<string, FakeWebContents>();
  releases: string[] = [];
  activityDepth = new Map<string, number>();

  acquireAgentTarget(sessionId: string) {
    let webContents = this.contents.get(sessionId);
    if (!webContents) {
      webContents = new FakeWebContents();
      this.contents.set(sessionId, webContents);
    }
    return {
      tabId: `tab-${sessionId}`,
      webContents,
      restore: Promise.resolve(),
      visible: false,
    };
  }

  async withAgentActivity<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    this.activityDepth.set(sessionId, (this.activityDepth.get(sessionId) ?? 0) + 1);
    try {
      return await action();
    } finally {
      this.activityDepth.set(sessionId, (this.activityDepth.get(sessionId) ?? 1) - 1);
    }
  }

  releaseAgentSession(sessionId: string) {
    this.releases.push(sessionId);
  }
}

const deadlines = { restoreMs: 100, navigationMs: 35, commandMs: 250, settleMs: 100 };

async function main() {
  assert.deepEqual(
    createGrokAcpHttpMcpServer('aegis-browser', {
      url: 'http://127.0.0.1:12345/mcp',
      headers: { Authorization: 'Bearer test-token' },
    }),
    {
      type: 'http',
      name: 'aegis-browser',
      url: 'http://127.0.0.1:12345/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer test-token' }],
    },
    'Grok session MCP injection must use the ACP HTTP descriptor shape'
  );
  assert.equal(
    new AcpJsonRpcError('session/new', -32602, { field: 'mcpServers' }, 'Invalid params')
      .message,
    'session/new: Invalid params (code -32602): {"field":"mcpServers"}',
    'ACP errors must retain the method, code and server-provided detail'
  );

  const manager = new FakeBrowserManager();

  // Same-session actions are serialized even when the MCP client dispatches
  // them concurrently.
  const one = manager.acquireAgentTarget('one').webContents;
  one.executeDelayMs = 35;
  const sameSession = await Promise.all([
    runBrowserUseAction(manager as never, { sessionId: 'one', action: 'snapshot' }, { deadlines }),
    runBrowserUseAction(manager as never, { sessionId: 'one', action: 'snapshot' }, { deadlines }),
  ]);
  assert.ok(sameSession.every((result) => result.ok));
  assert.equal(one.maxActiveExecutions, 1, 'same-session browser actions must be serial');

  // Different sessions do not share a queue or WebContents.
  const two = manager.acquireAgentTarget('two').webContents;
  const three = manager.acquireAgentTarget('three').webContents;
  two.executeDelayMs = 40;
  three.executeDelayMs = 40;
  let concurrent = 0;
  let maxConcurrent = 0;
  for (const contents of [two, three]) {
    const original = contents.executeJavaScript.bind(contents);
    contents.executeJavaScript = async (script: string) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        return await original(script);
      } finally {
        concurrent -= 1;
      }
    };
  }
  const separateSessions = await Promise.all([
    runBrowserUseAction(manager as never, { sessionId: 'two', action: 'snapshot' }, { deadlines }),
    runBrowserUseAction(manager as never, { sessionId: 'three', action: 'snapshot' }, { deadlines }),
  ]);
  assert.ok(separateSessions.every((result) => result.ok));
  assert.equal(maxConcurrent, 2, 'different sessions should execute independently');

  // A hung navigation stops inside the internal deadline instead of waiting
  // for the outer MCP client's 60 second timeout.
  const hung = manager.acquireAgentTarget('hung').webContents;
  hung.neverFinishNavigation = true;
  const timedOut = await runBrowserUseAction(
    manager as never,
    { sessionId: 'hung', action: 'navigate', url: 'https://example.test/hung' },
    { deadlines }
  );
  assert.equal(timedOut.ok, false);
  assert.match(timedOut.message, /Navigation timed out after 35ms/);
  assert.equal(hung.stopped, true, 'navigation timeout must stop the renderer load');

  // Client/turn cancellation propagates to the pending action and performs the
  // same stop cleanup.
  const cancelled = manager.acquireAgentTarget('cancelled').webContents;
  cancelled.neverFinishNavigation = true;
  const controller = new AbortController();
  const cancellation = runBrowserUseAction(
    manager as never,
    { sessionId: 'cancelled', action: 'navigate', url: 'https://example.test/cancelled' },
    { signal: controller.signal, deadlines: { ...deadlines, navigationMs: 500 } }
  );
  setTimeout(() => controller.abort(), 20);
  const cancelledResult = await cancellation;
  assert.equal(cancelledResult.ok, false);
  assert.match(cancelledResult.message, /cancelled/);
  assert.equal(cancelled.stopped, true);

  // Event-driven readiness resolves on did-stop-loading and cleans up.
  const ready = new FakeWebContents();
  ready.loading = true;
  const readyPromise = waitForBrowserPageReady(ready as never, 200);
  setTimeout(() => {
    ready.loading = false;
    ready.emit('did-stop-loading');
  }, 15);
  await readyPromise;
  assert.equal(ready.listenerCount('did-fail-load'), 0);

  // Persisted allow/block/ask policy and full-access bypass are exercised
  // against an isolated settings file (never the developer's real config).
  const permissionDir = mkdtempSync(join(tmpdir(), 'aegis-browser-permission-test-'));
  process.env.AEGIS_BROWSER_USE_SETTINGS_PATH = join(permissionDir, 'permissions.json');
  let permissionRequests = 0;
  let receivedSignal: AbortSignal | undefined;
  initializeBrowserUseConsent({
    getSessionHistory: () => [],
    listRunningSessionIds: () => [],
    isSessionFullAccess: () => false,
    requestPermission: async (_sessionId, _question, _url, signal) => {
      permissionRequests += 1;
      receivedSignal = signal;
      return true;
    },
  });
  saveBrowserUsePermissionSettings({ enabled: true, defaultPolicy: 'allow', origins: {} });
  assert.equal(
    await requestBrowserUseNavigationConsent('policy', 'https://allow.example/path'),
    true
  );
  assert.equal(permissionRequests, 0);
  saveBrowserUsePermissionSettings({ enabled: true, defaultPolicy: 'block', origins: {} });
  assert.equal(
    await requestBrowserUseNavigationConsent('policy', 'https://block.example/path'),
    false
  );
  assert.equal(permissionRequests, 0);
  saveBrowserUsePermissionSettings({ enabled: true, defaultPolicy: 'ask', origins: {} });
  const permissionSignal = new AbortController();
  assert.equal(
    await requestBrowserUseNavigationConsent(
      'policy',
      'https://ask.example/path',
      permissionSignal.signal
    ),
    true
  );
  assert.equal(permissionRequests, 1);
  assert.equal(receivedSignal, permissionSignal.signal);
  setBrowserUseSessionFullAccess('full-access', true);
  saveBrowserUsePermissionSettings({ enabled: true, defaultPolicy: 'block', origins: {} });
  assert.equal(
    await requestBrowserUseNavigationConsent('full-access', 'https://blocked.example/path'),
    true
  );
  setBrowserUseSessionFullAccess('full-access', false);
  assert.equal(
    await requestBrowserUseNavigationConsent('loopback', 'http://127.0.0.1:9999/path'),
    true
  );
  rmSync(permissionDir, { recursive: true, force: true });
  delete process.env.AEGIS_BROWSER_USE_SETTINGS_PATH;

  finishBrowserUseTurn(manager as never, 'one');
  assert.deepEqual(manager.releases, ['one']);
  assert.equal(manager.activityDepth.get('one'), 0);

  console.log('browser-use runtime: queue, detached target, deadline, abort and ready checks passed');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
