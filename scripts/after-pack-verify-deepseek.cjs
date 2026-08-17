const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Arch } = require('builder-util');
const asar = require('@electron/asar');
const { deepseekSdkClosure } = require('./deepseek-sdk-closure.cjs');

const PROJECT_DIR = path.resolve(__dirname, '..');

const REQUIRED_RUNTIME_PATHS = [
  'runtime-bin.mjs',
  'runtime-resume-shim.mjs',
  'cordis.yml',
  'package.json',
  'node_modules/@deepseek-ai/dsh-app-boot',
  'node_modules/@deepseek-ai/dsh-sdk-jsonrpc-server',
  'node_modules/@deepseek-ai/dsh-llm-deepseek',
  'node_modules/@deepseek-ai/dsh-mcp-client',
];

function verifyPackagedDeepseekRuntime(resourcesDir, platform, arch) {
  const profileDir = path.join(resourcesDir, 'deepseek-harness');
  const requiredPaths = [...REQUIRED_RUNTIME_PATHS];
  if (platform && arch) {
    requiredPaths.push(
      `node_modules/@koromix/koffi-${platform}-${arch}`,
      `node_modules/@vscode/ripgrep-${platform}-${arch}`
    );
  }
  for (const relativePath of requiredPaths) {
    assert.ok(
      fs.existsSync(path.join(profileDir, relativePath)),
      `packaged DeepSeek Harness runtime is missing ${relativePath}`
    );
  }
  console.log(`  • verified bundled DeepSeek Harness runtime  profile=${profileDir}`);
}

// The main process imports @deepseek-ai/dsh-sdk-client from app.asar. That
// package declares its runtime graph as peerDependencies, which electron-builder
// does not follow when collecting node_modules — assert the whole graph shipped.
// A package may legitimately live in app.asar.unpacked instead (smartUnpack
// moves anything with native binaries there), so accept either location.
function verifyPackagedDeepseekSdk(resourcesDir, projectDir) {
  const asarPath = path.join(resourcesDir, 'app.asar');
  assert.ok(fs.existsSync(asarPath), `packaged app is missing ${asarPath}`);
  const lock = JSON.parse(fs.readFileSync(path.join(projectDir, 'package-lock.json'), 'utf8'));
  const required = [...deepseekSdkClosure(lock.packages ?? {})];
  const entries = new Set(asar.listPackage(asarPath).map((entry) => entry.replace(/\\/g, '/')));
  const unpackedDir = path.join(resourcesDir, 'app.asar.unpacked');
  for (const name of required) {
    const asarEntry = `/node_modules/${name}/package.json`;
    const unpackedFile = path.join(unpackedDir, 'node_modules', name, 'package.json');
    let manifest;
    if (entries.has(asarEntry)) {
      manifest = asar.extractFile(asarPath, asarEntry.slice(1)).toString('utf8');
    } else if (fs.existsSync(unpackedFile)) {
      manifest = fs.readFileSync(unpackedFile, 'utf8');
    }
    assert.ok(manifest, `packaged app.asar is missing DeepSeek SDK package ${name}`);
    const expected = lock.packages?.[`node_modules/${name}`]?.version;
    const actual = JSON.parse(manifest).version;
    assert.equal(
      actual,
      expected,
      `packaged DeepSeek SDK package ${name} is ${actual}, lockfile expects ${expected}`
    );
  }
  console.log(
    `  • verified bundled DeepSeek SDK client graph  packages=${required.length} asar=${asarPath}`
  );
}

async function afterPack(context) {
  const platform = context.electronPlatformName;
  const arch = Arch[context.arch];
  const resourcesDir =
    platform === 'darwin'
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources'
        )
      : path.join(context.appOutDir, 'resources');
  verifyPackagedDeepseekRuntime(resourcesDir, platform, arch);
  verifyPackagedDeepseekSdk(resourcesDir, context.packager.projectDir);
}

module.exports = afterPack;
module.exports.verifyPackagedDeepseekRuntime = verifyPackagedDeepseekRuntime;
module.exports.verifyPackagedDeepseekSdk = verifyPackagedDeepseekSdk;

if (require.main === module) {
  const resourcesDir = process.argv[2];
  assert.ok(resourcesDir, 'usage: node scripts/after-pack-verify-deepseek.cjs <resources-dir>');
  verifyPackagedDeepseekRuntime(path.resolve(resourcesDir), process.argv[3], process.argv[4]);
  verifyPackagedDeepseekSdk(path.resolve(resourcesDir), PROJECT_DIR);
}
