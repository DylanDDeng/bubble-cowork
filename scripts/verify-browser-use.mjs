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
  /case 'navigate'[\s\S]{0,1100}withDeadline\([\s\S]{0,200}webContents\.loadURL/.test(service),
  'loadURL is bounded by the internal navigation deadline'
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
  service.includes('acquireAgentTarget'),
  'actions acquire the shared visible-or-detached runtime through BrowserManager'
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
const httpServerSource = read('src/electron/libs/browser-use-http-server.ts');
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
const tool = read('src/electron/libs/browser-use-tool.ts');
for (const action of ['screenshot', 'back', 'forward', 'hover', 'select', 'wait', 'tabs']) {
  assert.ok(tool.includes(`'${action}'`), `browser_use exposes the ${action} action`);
}
assert.ok(
  mcp.includes('browserUseInputSchema(z)') && httpServerSource.includes('browserUseInputSchema(z)'),
  'both MCP servers expose the one shared schema'
);
assert.ok(
  mcp.includes('browserUseResultContent(result, { inlineImage: true })') &&
    httpServerSource.includes('browserUseResultContent(result, { inlineImage: false })'),
  'Claude gets screenshots inline; HTTP providers get the saved file'
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
  'legacy HTTP providers retain the pending-call attribution fallback'
);
assert.ok(
  httpServer.includes('createBrowserUseSessionMcpDescriptor') &&
    httpServer.includes('BROWSER_USE_SESSION_HEADER') &&
    httpServer.includes('sessionCapabilities.get'),
  'session-scoped MCP capabilities bind DeepSeek requests without transcript scanning'
);
assert.ok(
  /runBrowserUseAction\(browserManager, input, \{ signal \}\)/.test(httpServer),
  'HTTP disconnect/cancellation signal reaches Browser Use actions'
);
assert.ok(
  httpServer.includes('upsertCodexMcpServer') && httpServer.includes('upsertKimiMcpServerRaw'),
  'Aegis-private Codex catalog + kimi mcp.json entries are written'
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
assert.ok(
  consent.includes('isBrowserUseSessionFullAccess') && consent.includes('isLoopbackOrigin'),
  'full-access sessions and loopback origins skip the consent card (no double-confirmation under Full Access)'
);

const ipc = read('src/electron/ipc-handlers.ts');
assert.ok(
  ipc.includes('initializeBrowserUseConsent'),
  'consent host is wired to session transcripts + runner list'
);
assert.ok(
  httpServer.includes('saveOpencodeMcpServers'),
  'opencode config receives the browser-use entry (inside the HTTP server bootstrap)'
);
// Qoder and Bubble get Browser Use per session; their global configs carry none.
const bootstrap = httpServer.slice(
  httpServer.indexOf('export function ensureBrowserUseHttpServer'),
  httpServer.indexOf('function removeSessionScopedProviderEntries')
);
assert.ok(
  !/(bubble|qoder)\[BROWSER_USE_SERVER_NAME\] =/.test(bootstrap) &&
    bootstrap.includes('removeSessionScopedProviderEntries()'),
  'the bootstrap writes no Bubble/Qoder entry and clears ones earlier versions wrote'
);
const qoderAdapter = read('src/electron/libs/provider/qoder-sdk-adapter.ts');
assert.ok(
  qoderAdapter.includes('[BROWSER_USE_SERVER_NAME]: await createQoderBrowserUseMcpServer(input.threadId'),
  'Qoder sessions get the in-process browser_use server bound to the Aegis session'
);
const bubbleAdapter = read('src/electron/libs/provider/bubble-sdk-adapter.ts');
assert.ok(
  bubbleAdapter.includes('hostTools: bubbleHostTools(session.threadId)') &&
    read('src/electron/libs/bubble-session-reader.ts').includes('createBubbleBrowserUseTool(sessionId)'),
  'Bubble turns carry a browser_use host tool bound to the Aegis session'
);
assert.ok(
  read('src/electron/libs/bubble-browser-use-tool.ts').includes('mcp__${BROWSER_USE_SERVER_NAME}__browser_use'),
  'the Bubble host tool keeps the MCP tool name (approval rules, labels, shadowing)'
);
assert.ok(
  ipc.includes('return runner.qoderPermissionMode === \'bypassPermissions\';') &&
    ipc.includes('return runner.bubblePermissionMode === \'bypassPermissions\';'),
  'Qoder/Bubble full-access sessions skip the navigation card'
);
const deepseekAdapter = read('src/electron/libs/provider/deepseek-sdk-adapter.ts');
assert.ok(
  deepseekAdapter.includes('createBrowserUseSessionMcpDescriptor(threadId)') &&
    deepseekAdapter.includes('delete runtimeEnv[BROWSER_USE_TOKEN_ENV_VAR]') &&
    !/deepseek\[BROWSER_USE_SERVER_NAME\] = \{/.test(httpServer),
  'deepseek receives only a scoped temporary descriptor and not a persisted global token'
);

// ── Phase 3: persisted origin policies ────────────────────────────────
const permissions = read('src/electron/libs/browser-use-permissions.ts');
assert.ok(
  permissions.includes("export type BrowserUseOriginPolicy = 'allow' | 'block' | 'ask'"),
  'three-state origin policy model'
);
assert.ok(
  consent.includes('resolveBrowserUsePolicy') &&
    consent.includes('export function decideBrowserUseNavigation') &&
    mcp.includes('decideBrowserUseNavigation(sessionId, url)') &&
    !mcp.includes('new Map<string, Set<string>>()'),
  'both consent paths share one decision (policy, loopback, approvals) before showing the card'
);
assert.ok(
  ipc.includes('forgetBrowserUseApprovals(sessionId)'),
  'deleting a session forgets its approved origins'
);
assert.ok(
  ipc.includes("'set-browser-use-origin-policy'") && ipc.includes("'set-browser-use-default-policy'"),
  'settings IPC for the permissions page'
);
assert.ok(
  read('src/ui/components/settings/BrowserUseSettings.tsx').includes('Enable Browser Use') &&
    !read('src/ui/components/settings/BrowserUseSettings.tsx').includes('Add rule') &&
    !read('src/ui/components/settings/BrowserUseSettings.tsx').includes('Default for all sites'),
  'settings page exposes a Browser Use enable toggle without a per-site list'
);
assert.ok(
  read('src/ui/components/settings/Settings.tsx').includes("label: 'Browser'") &&
    read('src/ui/components/settings/Settings.tsx').includes("=== 'browser'"),
  'browser settings live on a dedicated Settings tab, not under MCP'
);

// ── Phase 4: visible agent activity ────────────────────────────────
assert.ok(
  read('src/electron/browserManager.ts').includes('withAgentActivity'),
  'agent activity mark wraps browser-use actions'
);
assert.ok(
  read('src/electron/browserManager.ts').includes('acquireAgentTarget') &&
    read('src/electron/browserManager.ts').includes('releaseAgentSession'),
  'BrowserManager owns detached backend acquisition and turn-scoped release'
);
assert.ok(
  service.includes('waitForBrowserPageReady') &&
    service.includes('DEFAULT_BROWSER_USE_DEADLINES') &&
    service.includes('actionQueues'),
  'Browser actions use event-driven readiness, internal deadlines and per-session queues'
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

// ── Phase 5: built-in toggle + full agent coverage ─────────────────
const permsSrc = read('src/electron/libs/browser-use-permissions.ts');
assert.ok(
  permsSrc.includes('enabled: true'),
  'browser use defaults ON (built-in, zero-setup)'
);
assert.ok(
  httpServer.includes('removeBrowserUseMcpEntries') &&
    httpServer.includes('getBubbleMcpServers'),
  'toggling off removes entries from every provider config, Bubble included'
);
assert.ok(
  httpServer.includes('getBrowserUseMcpDescriptor'),
  'session-scoped adapters (grok ACP) can read the live descriptor'
);
const grok = read('src/electron/libs/provider/grok-acp-adapter.ts');
assert.ok(
  grok.includes('getBrowserUseMcpDescriptor()') &&
    grok.includes("createGrokAcpHttpMcpServer('aegis-browser', browserUseDescriptor)"),
  'grok ACP converts browser-use into the typed HTTP session descriptor'
);
assert.ok(
  /\.catch\(\(error\) => \{\s*terminateSpawnedGrokProcess\(proc\);/.test(grok),
  'grok startup failures terminate the spawned ACP process'
);
assert.ok(
  runner.includes('if (isBrowserUseEnabled())'),
  'the Claude in-process injection is gated by the master toggle'
);
assert.ok(
  ipc.includes("'set-browser-use-enabled'"),
  'toggle IPC starts/disposes the server accordingly'
);
assert.ok(
  read('src/ui/components/settings/BrowserUseSettings.tsx').includes('Enable Browser Use'),
  'settings page exposes the master switch'
);
assert.ok(
  consent.includes('.browser_use') || consent.includes("`.${BROWSER_USE_TOOL_NAME}`"),
  'attribution matches OpenCode dot-notation tool names'
);

const mcpSave = ipc.slice(ipc.indexOf('if (payload.qoderGlobalServers !== undefined)'));
assert.ok(
  /delete incoming\[BROWSER_USE_SERVER_NAME\];\s*saveQoderMcpServers\(incoming\)/.test(mcpSave) &&
    /delete incoming\[BROWSER_USE_SERVER_NAME\];\s*saveBubbleMcpServers\(incoming\)/.test(mcpSave),
  'MCP settings saves never persist the reserved name for Qoder/Bubble'
);
assert.ok(
  httpServer.includes('getDeepseekGlobalMcpServers') &&
    httpServer.includes('createBrowserUseSessionMcpDescriptor') &&
    ipc.includes('flushDeepseekRunners();') &&
    ipc.includes('delete incoming[BROWSER_USE_SERVER_NAME]'),
  'deepseek browser-use scoped descriptor, reserved-name guard and runtime refresh are wired'
);

const cookieImport = read('src/electron/libs/chrome-cookie-import.ts');
assert.ok(
  cookieImport.includes('BROWSER_SESSION_PARTITION') &&
    read('src/shared/browser-types.ts').includes("persist:coworker-browser"),
  'import writes into the shared session browser partition'
);
assert.ok(cookieImport.includes('reloadCoworkerBrowserViews'), 'imported cookies reload existing built-in browser tabs');
assert.ok(cookieImport.includes('import_failed'), 'unknown errors are not labeled as decrypt_failed');
assert.ok(cookieImport.includes('isGoogleChromeProcessName'), 'Chrome process detection is centralized');
assert.ok(cookieImport.includes('skippedPartitioned'), 'CHIPS cookies are skipped rather than imported as global cookies');
assert.ok(cookieImport.includes('v20_unsupported'), 'v20/App-Bound cookies abort the import');
assert.ok(cookieImport.includes('pinBrowserUseOriginsAsk'), 'imported origins are pinned to ask');
assert.ok(cookieImport.includes('originsForImportedHosts'), 'imported hosts pin both http and https origins');
assert.ok(cookieImport.includes('previous?.domains'), 're-import unions previously imported domains for clear');
assert.ok(
  !cookieImport.includes('host.endsWith(`.${domain}`)'),
  'selected sites match exact hosts rather than importing subdomains'
);
assert.ok(
  permsSrc.includes('pinBrowserUseOriginsAsk'),
  'permission helper pins imported origins so default allow cannot cover them'
);
assert.ok(
  permsSrc.includes('hostname.endsWith(`.${pinnedHost}`)'),
  'explicit ask on an imported apex covers subdomains of the same scheme'
);
assert.ok(
  read('src/ui/components/settings/BrowserUseSettings.tsx').includes('skippedInvalid'),
  'import toast reports skippedInvalid cookies'
);
assert.ok(
  read('src/ui/components/settings/BrowserUseSettings.tsx').includes('function ChromeMark') &&
    read('src/ui/components/settings/BrowserUseSettings.tsx').includes('Cookies'),
  'import dialog shows a Chrome mark and a Cookies toggle'
);
assert.ok(
  !read('src/ui/components/settings/BrowserUseSettings.tsx').includes('Select all'),
  'import dialog does not list individual cookie sites'
);

console.log('browser-use phase 6 wiring checks passed');
