#!/usr/bin/env node
// Round-trip verification for codex-mcp-settings: seed Aegis' private catalog
// from ~/.codex/config.toml, preserve fields Aegis does not edit, and prove the
// user's source config is never modified.
// Requires `npm run transpile:electron` to have produced dist-electron.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const home = mkdtempSync(join(tmpdir(), 'codex-mcp-verify-'));
// os.homedir() reads $HOME on posix; override before the module loads because
// it resolves the config path at import time.
process.env.HOME = home;
mkdirSync(join(home, '.codex'), { recursive: true });
const privateConfigPath = join(home, 'aegis-user-data', 'codex', 'config.toml');
process.env.AEGIS_CODEX_MCP_CONFIG_PATH = privateConfigPath;

const original = `model = "gpt-5"
tool_timeout_sec = 1800

[profiles.fast]
model = "gpt-5-mini"

[mcp_servers.local-tools]
command = "npx"
args = ["-y", "some-mcp"]
env = { API_KEY = "secret" }
startup_timeout_sec = 20
tool_timeout_sec = 600
# keep this comment

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_TOKEN"

[mcp_servers.disabled-one]
command = "foo"
enabled = false

[mcp_servers."quoted.server"]
command = "quoted-tool"
`;
const configPath = join(home, '.codex', 'config.toml');
writeFileSync(configPath, original, 'utf-8');
const sourceBefore = statSync(configPath);

const mod = await import(join(repoRoot, 'dist-electron', 'electron', 'libs', 'codex-mcp-settings.js'));
const { buildCodexMcpConfigOverrideArgs, getCodexMcpServers, saveCodexMcpServers } = mod.default ?? mod;

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`);
  if (!cond) failures++;
};

// 1. Parse: HTTP entry visible, fields correct
const servers = getCodexMcpServers();
check('http entry parsed with url', servers['figma']?.url === 'https://mcp.figma.com/mcp');
check('http entry typed http', servers['figma']?.type === 'http');
check('stdio entry parsed', servers['local-tools']?.command === 'npx' && servers['local-tools']?.type === 'stdio');
check('enabled=false parsed', servers['disabled-one']?.enabled === false);
check('quoted server name parsed', servers['quoted.server']?.command === 'quoted-tool');

// 2. First read seeds a private copy; save never touches the user source.
saveCodexMcpServers(servers);
const after1 = readFileSync(privateConfigPath, 'utf-8');
check('http entry survives save', /\[mcp_servers\.figma\]/.test(after1) && after1.includes('url = "https://mcp.figma.com/mcp"'));
check('bearer_token_env_var survives', after1.includes('bearer_token_env_var = "FIGMA_TOKEN"'));
check('startup_timeout_sec survives', after1.includes('startup_timeout_sec = 20'));
check('section tool_timeout_sec survives', after1.includes('tool_timeout_sec = 600'));
check('comment survives', after1.includes('# keep this comment'));
check('private catalog excludes top-level user config', !after1.includes('model = "gpt-5"') && !after1.includes('tool_timeout_sec = 1800'));
check('private catalog excludes user profiles', !after1.includes('[profiles.fast]'));
check('enabled=false survives', /\[mcp_servers\.disabled-one\][^[]*enabled = false/.test(after1));

// 3. Edit one entry, extras still preserved on the others
const edited = getCodexMcpServers();
edited['local-tools'] = { ...edited['local-tools'], args: ['-y', 'some-mcp', '--verbose'] };
saveCodexMcpServers(edited);
const after2 = readFileSync(privateConfigPath, 'utf-8');
check('edited args written', after2.includes('args = ["-y", "some-mcp", "--verbose"]'));
check('extras still present after edit', after2.includes('startup_timeout_sec = 20') && after2.includes('bearer_token_env_var = "FIGMA_TOKEN"'));

// 4. Add a new HTTP server from the UI editor shape
const withNew = getCodexMcpServers();
withNew['my-http'] = { type: 'http', url: 'http://127.0.0.1:8321/mcp', headers: { Authorization: 'Bearer abc' } };
saveCodexMcpServers(withNew);
const after3 = readFileSync(privateConfigPath, 'utf-8');
check('new http entry written', after3.includes('[mcp_servers.my-http]') && after3.includes('url = "http://127.0.0.1:8321/mcp"'));
check('http_headers written', after3.includes('http_headers = { Authorization = "Bearer abc" }'));

// 5. Round-trip idempotence: second save produces identical text
saveCodexMcpServers(getCodexMcpServers());
const after4 = readFileSync(privateConfigPath, 'utf-8');
check('save is idempotent', after4 === after3);

// 6. Delete an entry removes it (and only it)
const del = getCodexMcpServers();
delete del['disabled-one'];
saveCodexMcpServers(del);
const after5 = readFileSync(privateConfigPath, 'utf-8');
check('deleted entry removed', !after5.includes('disabled-one'));
check('others remain after delete', after5.includes('[mcp_servers.figma]') && after5.includes('[mcp_servers.local-tools]'));

// 7. Runtime arguments rebuild the private catalog and explicitly disable
// source-only entries, including fields Aegis preserves but does not understand.
const runtimeArgs = buildCodexMcpConfigOverrideArgs();
check('runtime starts with MCP table override', runtimeArgs[0] === '-c' && runtimeArgs[1] === 'mcp_servers={}');
check('runtime disables source-only MCP entries', runtimeArgs.includes('mcp_servers.disabled-one.enabled=false'));
check('runtime contains private HTTP server', runtimeArgs.includes('mcp_servers.my-http.url="http://127.0.0.1:8321/mcp"'));
check('runtime preserves bearer token env field', runtimeArgs.includes('mcp_servers.figma.bearer_token_env_var="FIGMA_TOKEN"'));
check('runtime quotes dotted server names', runtimeArgs.includes('mcp_servers."quoted.server".command="quoted-tool"'));

// 8. The source is byte-for-byte and metadata unchanged after every operation.
const sourceAfter = statSync(configPath);
check('user config content remains unchanged', readFileSync(configPath, 'utf-8') === original);
check('user config mtime remains unchanged', sourceAfter.mtimeMs === sourceBefore.mtimeMs);
check('user config inode remains unchanged', sourceAfter.ino === sourceBefore.ino);

rmSync(home, { recursive: true, force: true });
console.log(failures === 0 ? '\nverify-codex-mcp-settings: ALL PASS' : `\nverify-codex-mcp-settings: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
