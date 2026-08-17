#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const builder = read('electron-builder.json');
assert.ok(
  builder.includes('"beforePack": "scripts/before-pack-prepare-deepseek.cjs"') &&
    builder.includes('"afterPack": "scripts/after-pack-verify-deepseek.cjs"') &&
    builder.includes('"from": "dev-fixtures/deepseek-harness"') &&
    builder.includes('"to": "deepseek-harness"') &&
    builder.includes('"from": "dev-fixtures/deepseek-harness/node_modules"') &&
    builder.includes('"to": "deepseek-harness/node_modules"') &&
    builder.includes('"runtime-bin.mjs"') &&
    builder.includes('"runtime-resume-shim.mjs"') &&
    builder.includes('"cordis.yml"'),
  'electron-builder must copy the complete DeepSeek Harness runtime profile outside app.asar'
);

const beforePack = read('scripts/before-pack-prepare-deepseek.cjs');
const afterPack = read('scripts/after-pack-verify-deepseek.cjs');
assert.ok(
  beforePack.includes("['ci', '--prefix', profileDir") &&
    beforePack.includes('`--os=${platform}`') &&
    beforePack.includes('`--cpu=${arch}`') &&
    beforePack.includes("installArgs.push('--ignore-scripts')") &&
    beforePack.includes('fs.chmodSync(spawnHelper, 0o755)'),
  'each Electron target must install DeepSeek Harness dependencies for its own architecture'
);
assert.ok(
  afterPack.includes('koffi-${platform}-${arch}') &&
    afterPack.includes('ripgrep-${platform}-${arch}'),
  'each packaged app must verify the target-specific DeepSeek native dependencies'
);

const rootPackage = JSON.parse(read('package.json'));
assert.equal(
  rootPackage.scripts?.['prepare:deepseek-runtime'],
  'npm ci --prefix dev-fixtures/deepseek-harness',
  'packaging must install the pinned DeepSeek runtime dependencies'
);
assert.ok(
  rootPackage.scripts?.['prebuild:electron']?.includes('prepare:deepseek-runtime') &&
    rootPackage.scripts?.['prebuild:electron']?.includes('verify:deepseek-packaging'),
  'every npm-driven Electron package must prepare and verify the DeepSeek runtime first'
);

const profileDir = path.join(root, 'dev-fixtures', 'deepseek-harness');
const profilePackage = JSON.parse(read('dev-fixtures/deepseek-harness/package.json'));
const profileLock = JSON.parse(read('dev-fixtures/deepseek-harness/package-lock.json'));
assert.deepEqual(
  profileLock.packages?.['']?.dependencies,
  profilePackage.dependencies,
  'the committed DeepSeek runtime lockfile must match package.json exactly'
);

for (const relativePath of [
  'runtime-bin.mjs',
  'runtime-resume-shim.mjs',
  'cordis.yml',
  'node_modules/@deepseek-ai/dsh-app-boot',
  'node_modules/@deepseek-ai/dsh-sdk-jsonrpc-server',
  'node_modules/@deepseek-ai/dsh-llm-deepseek',
  'node_modules/@deepseek-ai/dsh-mcp-client',
]) {
  assert.ok(
    fs.existsSync(path.join(profileDir, relativePath)),
    `DeepSeek runtime packaging input is missing ${relativePath}`
  );
}

const cli = read('src/electron/libs/deepseek-cli.ts');
assert.ok(
  cli.includes('process.resourcesPath') &&
    cli.includes("PACKAGED_PROFILE_DIRNAME = 'deepseek-harness'") &&
    cli.includes('resolveDeepseekSessionRoot') &&
    cli.includes("'.aegis', 'deepseek-sessions'") &&
    cli.includes('AEGIS_DSH_PROFILE_DIR'),
  'runtime resolution must support the bundled profile, writable sessions, and an advanced override'
);

const adapter = read('src/electron/libs/provider/deepseek-sdk-adapter.ts');
assert.ok(
  adapter.includes('DSH_SESSION_ROOT: resolveDeepseekSessionRoot(profileDir)') &&
    !adapter.includes("DSH_SESSION_ROOT: path.join(profileDir, '.sessions')"),
  'the packaged profile must never receive session writes inside app resources'
);

console.log('deepseek-packaging: source and runtime inputs verified');
