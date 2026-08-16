import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Browser Use wiring checks (verify-pi-sdk-adapter style): pins the service /
 * MCP / runner contract that makes agent-driven browsing work on the session
 * browser panel, Codex-parity Phase 1.
 */

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// ── Service layer (browser-use.ts) ─────────────────────────────────────────
const service = read('src/electron/libs/browser-use.ts');
assert.ok(
  service.includes("export const BROWSER_USE_SERVER_NAME = 'aegis-browser'"),
  'server name exported'
);
assert.ok(
  /case 'navigate'[\s\S]{0,1000}loadURL/.test(service),
  'navigate action drives loadURL on the live webContents'
);
assert.ok(
  /case 'navigate'[\s\S]{0,900}protocol !== 'http:'/.test(service),
  'navigate rejects non-http(s) schemes (file:// origins break consent)'
);
assert.ok(
  /case 'navigate'[\s\S]{0,1100}await webContents\.loadURL/.test(service),
  'loadURL is awaited and its failure reported (no unhandled rejection)'
);
assert.ok(
  service.includes('currentScrollX'),
  'node clicks re-base viewport coords against the CURRENT scroll (scroll-safe clicking)'
);
for (const action of ['click', 'type', 'scroll', 'key']) {
  assert.ok(new RegExp(`case '${action}'`).test(service), `${action} action implemented`);
}
assert.ok(
  service.includes("sendInputEvent({ type: 'mouseDown'"),
  'click goes through sendInputEvent (real input pipeline, not synthetic JS)'
);
assert.ok(
  service.includes('getLiveWebContents'),
  'actions resolve the live tab through BrowserManager (suspended tabs refuse clearly)'
);
assert.ok(
  /case 'snapshot'[\s\S]{0,200}rememberSnapshot/.test(service),
  'snapshot caches per (session, tab) for node-id addressing'
);
assert.ok(
  service.includes('Stale snapshot'),
  'stale-snapshot node addressing fails loudly instead of clicking wrong nodes'
);

// ── MCP layer (browser-use-mcp.ts) ────────────────────────────────────────
const mcp = read('src/electron/libs/browser-use-mcp.ts');
assert.ok(
  mcp.includes("const TOOL_NAME = 'browser_use'"),
  'single browser_use tool (Codex-shaped action surface)'
);
assert.ok(
  mcp.includes('askNavigationConsent'),
  'navigation consent is enforced before loadURL'
);
assert.ok(
  mcp.includes('askPermission(toolUseId,'),
  'consent rides the session permission pipeline (same card as other tools)'
);
assert.ok(
  mcp.includes('rememberBrowserUseApproval'),
  'approved origins are remembered for the session (no re-ask per action)'
);
assert.ok(
  mcp.includes('createSdkMcpServer'),
  'in-process SDK MCP server (delegate-mcp pattern, no external process)'
);

// ── Runner wiring (runner.ts) ─────────────────────────────────────────────
const runner = read('src/electron/libs/runner.ts');
assert.ok(
  runner.includes('BROWSER_USE_SERVER_NAME') && runner.includes('createBrowserUseMcpServer'),
  'Claude leads get the browser-use server injected'
);
assert.ok(
  /createBrowserUseMcpServer\(session\.id, browserManager/.test(runner),
  'the server is bound to the singleton BrowserManager + parent session id'
);
assert.ok(
  /await onPermissionRequest\(toolUseId, toolName, input\)/.test(
    runner.slice(runner.indexOf('createBrowserUseMcpServer'))
  ),
  'the permission hook forwards to the runner onPermissionRequest (approval card UI)'
);
const runnerBrowserIdx = runner.indexOf('await createBrowserUseMcpServer');
const delegateGateIdx = runner.indexOf('isDelegateExecutionSession(session.id)', runner.indexOf('if (!isDelegateExecutionSession'));
assert.ok(
  delegateGateIdx >= 0 && runnerBrowserIdx > delegateGateIdx,
  'browser-use is only injected for top-level sessions (delegates cannot drive the browser)'
);

console.log('browser-use wiring checks passed');

// ── Phase 2: cross-provider HTTP transport ──────────────────────────────
const httpServer = read('src/electron/libs/browser-use-http-server.ts');
assert.ok(
  httpServer.includes('StreamableHTTPServerTransport'),
  'loopback HTTP MCP transport (delegate-http-server pattern)'
);
assert.ok(
  httpServer.includes('findBrowserUseCallerSessionId'),
  'HTTP calls are attributed to a session via the pending-call scan'
);
assert.ok(
  httpServer.includes('upsertCodexMcpServer') && httpServer.includes('upsertKimiMcpServerRaw'),
  'codex config.toml + kimi mcp.json entries are written'
);
assert.ok(
  httpServer.includes("'AEGIS_BROWSER_USE_TOKEN'"),
  'per-run bearer token guards the loopback server'
);

const consent = read('src/electron/libs/browser-use-consent.ts');
assert.ok(
  consent.includes('mcp__aegis-browser__'),
  'codex-composed mcp tool names match the attribution scan'
);
assert.ok(
  consent.includes('ATTRIBUTION_POLL_MS') && consent.includes('claimedToolUseIds'),
  'attribution polls until the tool_use lands AND claims ids (delegate pattern, no double-claim)'
);
assert.ok(
  consent.includes('requestBrowserUseNavigationConsent'),
  'navigation consent routes through the calling session permission card'
);

const ipc = read('src/electron/ipc-handlers.ts');
assert.ok(
  ipc.includes('initializeBrowserUseConsent'),
  'consent host is wired to session transcripts + runner list'
);
assert.ok(
  ipc.includes("'aegis-browser'"),
  'qoder/opencode configs receive the browser-use entry'
);

// ── Phase 3: persisted origin policies ────────────────────────────────
const permissions = read('src/electron/libs/browser-use-permissions.ts');
assert.ok(
  permissions.includes("export type BrowserUseOriginPolicy = 'allow' | 'block' | 'ask'"),
  'three-state origin policy model'
);
for (const layer of [read('src/electron/libs/browser-use-mcp.ts'), consent]) {
  assert.ok(
    layer.includes('resolveBrowserUsePolicy'),
    'both consent paths consult the persisted policy before showing the card'
  );
}
assert.ok(
  ipc.includes("'set-browser-use-origin-policy'") && ipc.includes("'set-browser-use-default-policy'"),
  'settings IPC for the permissions page'
);
assert.ok(
  read('src/ui/components/settings/BrowserUseSettings.tsx').includes('Block browsing'),
  'settings page exposes the Codex-parity policy labels'
);

// ── Phase 4: visible agent activity ────────────────────────────────
assert.ok(
  read('src/electron/browserManager.ts').includes('withAgentActivity'),
  'agent activity mark wraps browser-use actions'
);
assert.ok(
  service.includes('manager.withAgentActivity'),
  'every action runs under the agent-activity mark'
);
assert.ok(
  read('src/ui/components/browser/BrowserPanel.tsx').includes('agentActive'),
  'the panel shows the agent badge while agentActive'
);
assert.ok(
  read('src/shared/browser-types.ts').includes('agentActive'),
  'agentActive travels on the browser state wire'
);

console.log('browser-use phase 2-4 wiring checks passed');
