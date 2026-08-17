const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

function verifyPackagedDeepseekRuntime(resourcesDir) {
  const profileDir = path.join(resourcesDir, 'deepseek-harness');
  for (const relativePath of REQUIRED_RUNTIME_PATHS) {
    assert.ok(
      fs.existsSync(path.join(profileDir, relativePath)),
      `packaged DeepSeek Harness runtime is missing ${relativePath}`
    );
  }
  console.log(`  • verified bundled DeepSeek Harness runtime  profile=${profileDir}`);
}

async function afterPack(context) {
  const resourcesDir =
    context.electronPlatformName === 'darwin'
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources'
        )
      : path.join(context.appOutDir, 'resources');
  verifyPackagedDeepseekRuntime(resourcesDir);
}

module.exports = afterPack;
module.exports.verifyPackagedDeepseekRuntime = verifyPackagedDeepseekRuntime;

if (require.main === module) {
  const resourcesDir = process.argv[2];
  assert.ok(resourcesDir, 'usage: node scripts/after-pack-verify-deepseek.cjs <resources-dir>');
  verifyPackagedDeepseekRuntime(path.resolve(resourcesDir));
}
