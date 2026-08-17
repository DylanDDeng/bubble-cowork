// Real Electron/Codex E2E for Aegis' private MCP catalog.
//
// The whole environment lives under one temporary root. This intentionally
// starts the real Codex app-server, but it can neither read nor write the
// developer's actual ~/.codex state.

const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-codex-config-e2e-'));
const testHome = path.join(testRoot, 'user-home');
const userData = path.join(testRoot, 'aegis-user-data');
const userCodexHome = path.join(testHome, '.codex');
const browserSettingsPath = path.join(testRoot, 'browser-use-permissions.json');
const sourceOnlyCanaryScript = path.join(testRoot, 'source-only-canary.cjs');
const sourceOnlyLaunchMarker = path.join(testRoot, 'source-only-launched.txt');

fs.mkdirSync(userCodexHome, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

// These are set before any compiled Aegis module is loaded because several
// provider paths are resolved from os.homedir() at module initialization.
process.env.HOME = testHome;
process.env.CODEX_HOME = userCodexHome;
process.env.CODEX_SQLITE_HOME = path.join(testRoot, 'codex-sqlite');
process.env.AEGIS_BROWSER_USE_SETTINGS_PATH = browserSettingsPath;
process.env.AEGIS_CODEX_INITIALIZE_TIMEOUT_MS = '30000';
process.env.AEGIS_CODEX_REQUEST_TIMEOUT_MS = '30000';
delete process.env.AEGIS_CODEX_MCP_CONFIG_PATH;
delete process.env.AEGIS_CODEX_USER_CONFIG_PATH;
delete process.env.AEGIS_BROWSER_USE_TEST_MODE;

app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-gpu');

const userConfigPath = path.join(userCodexHome, 'config.toml');
const privateConfigPath = path.join(userData, 'codex', 'config.toml');
const nodeBinary = process.env.AEGIS_E2E_NODE_BINARY || 'node';
fs.writeFileSync(
  sourceOnlyCanaryScript,
  "require('node:fs').writeFileSync(process.argv[2], 'launched');\n",
  'utf8'
);
const originalUserConfig = `# AEGIS_CODEX_CONFIG_E2E_SENTINEL
model = "gpt-5.2-codex"

[mcp_servers.seeded-from-user]
command = "/usr/bin/false"
enabled = false

[mcp_servers.user-source-only]
command = ${JSON.stringify(nodeBinary)}
args = [${JSON.stringify(sourceOnlyCanaryScript)}, ${JSON.stringify(sourceOnlyLaunchMarker)}]
`;

fs.writeFileSync(userConfigPath, originalUserConfig, { encoding: 'utf8', mode: 0o600 });
// Give mtime a deliberately old value so even a same-content rewrite is
// detectable on filesystems with coarse timestamp resolution.
const oldTimestamp = new Date('2001-01-01T00:00:00.000Z');
fs.utimesSync(userConfigPath, oldTimestamp, oldTimestamp);
const userConfigBefore = fs.statSync(userConfigPath);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertUserConfigUnchanged(stage) {
  const after = fs.statSync(userConfigPath);
  const currentContent = fs.readFileSync(userConfigPath, 'utf8');
  assert(
    currentContent === originalUserConfig,
    `${stage}: user config content changed\n--- expected ---\n${originalUserConfig}\n--- actual ---\n${currentContent}`
  );
  assert(after.mtimeMs === userConfigBefore.mtimeMs, `${stage}: user config mtime changed`);
  assert(after.ino === userConfigBefore.ino, `${stage}: user config inode changed`);
}

async function run() {
  let manager = null;
  let delegate = null;
  let browser = null;
  try {
    const codexSettingsModule = require(
      path.join(repoRoot, 'dist-electron/electron/libs/codex-mcp-settings.js')
    );
    const codexSettings = codexSettingsModule.default ?? codexSettingsModule;
    const delegateModule = require(
      path.join(repoRoot, 'dist-electron/electron/libs/delegate-http-server.js')
    );
    const browserModule = require(
      path.join(repoRoot, 'dist-electron/electron/libs/browser-use-http-server.js')
    );
    const browserPermissionsModule = require(
      path.join(repoRoot, 'dist-electron/electron/libs/browser-use-permissions.js')
    );
    const managerModule = require(
      path.join(repoRoot, 'dist-electron/electron/libs/provider/codex-app-server-manager.js')
    );
    // The first Aegis Codex MCP operation seeds only MCP sections into its
    // private catalog, then writes the live delegate endpoint there.
    delegate = await delegateModule.ensureDelegateHttpServer();
    const seededCatalog = codexSettings.getCodexMcpServers();
    assert(seededCatalog['seeded-from-user'], 'initial user MCP was not seeded privately');
    assert(seededCatalog['user-source-only'], 'private seed did not include all initial MCP entries');
    assert(seededCatalog['aegis-delegate'], 'delegate MCP was not written privately');
    assertUserConfigUnchanged('delegate startup');

    // Simulate deleting one inherited entry in Aegis' MCP settings. The user
    // source keeps it, which gives the runtime test a canary: the launch
    // overrides must explicitly keep this source-only entry disabled.
    delete seededCatalog['user-source-only'];
    codexSettings.saveCodexMcpServers(seededCatalog);

    browserPermissionsModule.setBrowserUseEnabled(true);
    browser = await browserModule.ensureBrowserUseHttpServer();

    const privateCatalog = codexSettings.getCodexMcpServers();
    assert(privateCatalog['seeded-from-user'], 'seeded MCP disappeared from private catalog');
    assert(privateCatalog['aegis-delegate'], 'delegate MCP disappeared from private catalog');
    assert(privateCatalog['aegis-browser'], 'browser MCP was not written privately');
    assert(!privateCatalog['user-source-only'], 'private deletion did not persist');
    assert(fs.existsSync(privateConfigPath), 'private Codex MCP catalog was not created');
    assertUserConfigUnchanged('private catalog updates');

    const codexBinary = process.env.AEGIS_E2E_CODEX_BINARY || 'codex';
    manager = new managerModule.CodexAppServerManager(codexBinary, 'codex-config-isolation-e2e');
    const statuses = await manager.listMcpServerStatus();
    const byName = new Map(statuses.map((entry) => [entry.name, entry]));
    const browserStatus = byName.get('aegis-browser');
    const delegateStatus = byName.get('aegis-delegate');

    assert(browserStatus, 'real Codex app-server did not receive aegis-browser');
    assert(delegateStatus, 'real Codex app-server did not receive aegis-delegate');
    assert(
      !fs.existsSync(sourceOnlyLaunchMarker),
      'source-only user MCP was launched by the Codex runtime'
    );
    assert(
      browserStatus.toolNames.includes('browser_use'),
      `aegis-browser tool handshake failed: ${JSON.stringify(browserStatus)}`
    );
    assert(
      delegateStatus.toolNames.includes('delegate_task') &&
        delegateStatus.toolNames.includes('delegate_status'),
      `aegis-delegate tool handshake failed: ${JSON.stringify(delegateStatus)}`
    );
    assertUserConfigUnchanged('real Codex app-server runtime');

    const result = {
      ok: true,
      userConfigContentUnchanged: true,
      userConfigMtimeUnchanged: true,
      userConfigInodeUnchanged: true,
      privateCatalogSeeded: true,
      privateDelegateWritten: true,
      privateBrowserWritten: true,
      sourceOnlyMcpDisabledAtRuntime: true,
      browserToolHandshake: true,
      delegateToolHandshake: true,
      runtimeMcpNames: [...byName.keys()].sort(),
    };
    console.log(`CODEX_CONFIG_ISOLATION_E2E_RESULT:${JSON.stringify(result)}`);
  } finally {
    if (manager) await manager.stop().catch(() => {});
    if (browser) browserModuleSafeDispose();
    if (delegate) delegateModuleSafeDispose();
    assertUserConfigUnchanged('cleanup');
    fs.rmSync(testRoot, { recursive: true, force: true });
  }

  function browserModuleSafeDispose() {
    try {
      const loaded = require(
        path.join(repoRoot, 'dist-electron/electron/libs/browser-use-http-server.js')
      );
      (loaded.default ?? loaded).disposeBrowserUseHttpServer();
    } catch {
      // Preserve the primary E2E result/error.
    }
  }

  function delegateModuleSafeDispose() {
    try {
      const loaded = require(
        path.join(repoRoot, 'dist-electron/electron/libs/delegate-http-server.js')
      );
      (loaded.default ?? loaded).disposeDelegateHttpServer();
    } catch {
      // Preserve the primary E2E result/error.
    }
  }
}

app.whenReady()
  .then(run)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error?.stack || error);
    app.exit(1);
  });
