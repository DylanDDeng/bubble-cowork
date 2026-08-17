const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Arch } = require('builder-util');

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
}

module.exports = afterPack;
module.exports.verifyPackagedDeepseekRuntime = verifyPackagedDeepseekRuntime;

if (require.main === module) {
  const resourcesDir = process.argv[2];
  assert.ok(resourcesDir, 'usage: node scripts/after-pack-verify-deepseek.cjs <resources-dir>');
  verifyPackagedDeepseekRuntime(path.resolve(resourcesDir), process.argv[3], process.argv[4]);
}
