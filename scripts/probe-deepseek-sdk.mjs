#!/usr/bin/env node
// Probe: boot the DeepSeek Harness SDK runtime from the launch profile in
// dev-fixtures/deepseek-harness (`npm install` there first) and drive one
// tool-using turn through @deepseek-ai/dsh-sdk-client, dumping every event
// kind. Run after any dsh version bump to catch wire-contract drift.
//
// Usage: node scripts/probe-deepseek-sdk.mjs [prompt]
// Reads DEEPSEEK_API_KEY from the environment, falling back to ~/.deepseek/config.toml.

import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const profileDir = join(repoRoot, 'dev-fixtures', 'deepseek-harness');
if (!existsSync(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot'))) {
  console.error(`FAIL profile not installed: run \`npm install\` in ${profileDir}`);
  process.exit(1);
}

const sdkEntry = join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh-sdk-client', 'lib', 'index.js');
const { DeepSeekHarness } = await import(pathToFileURL(sdkEntry).href);

function resolveApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  try {
    const toml = readFileSync(join(homedir(), '.deepseek', 'config.toml'), 'utf8');
    const match = toml.match(/^\s*api_key\s*=\s*"([^"]+)"/m);
    if (match) return match[1];
  } catch {}
  return null;
}

const apiKey = resolveApiKey();
if (!apiKey) {
  console.error('FAIL no DEEPSEEK_API_KEY in env or ~/.deepseek/config.toml');
  process.exit(1);
}

const cwd = mkdtempSync(join(tmpdir(), 'deepseek-sdk-probe-'));
writeFileSync(join(cwd, 'hello.txt'), 'probe workspace\n');
const prompt =
  process.argv[2] ||
  'Read hello.txt with your file tools, then create probe-out.txt containing done. Reply with the single word: finished.';

const timer = setTimeout(() => {
  console.error('FAIL timeout after 240s');
  process.exit(1);
}, 240_000);

await using harness = new DeepSeekHarness({
  launch: {
    command: process.execPath,
    args: [join(profileDir, 'runtime-bin.mjs'), join(profileDir, 'cordis.yml')],
    cwd: profileDir,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: apiKey,
      DSH_CWD: cwd,
      DSH_PERMISSION_MODE: 'workspace-write',
      ELECTRON_RUN_AS_NODE: '1',
    },
  },
  provider: 'deepseek-official',
  cwd,
});

const result = await harness.run(prompt);
const kinds = {};
for (const event of result.events) {
  kinds[event.type] = (kinds[event.type] ?? 0) + 1;
}
console.error('finalResponse:', JSON.stringify(result.finalResponse).slice(0, 200));
console.error('event kinds:', JSON.stringify(kinds, null, 1));
const dumpPath = join(tmpdir(), 'deepseek-sdk-probe-events.json');
writeFileSync(dumpPath, JSON.stringify(result.events, null, 1));
console.error('full dump:', dumpPath);

const pass =
  (kinds['assistant/message'] ?? 0) > 0 &&
  (kinds['tool/call'] ?? 0) > 0 &&
  (kinds['tool/result'] ?? 0) > 0 &&
  (kinds['turn/end'] ?? 0) === 1 &&
  result.finalResponse.length > 0;
clearTimeout(timer);
console.log(pass ? 'PROBE PASS' : 'PROBE FAIL');
process.exit(pass ? 0 : 1);
