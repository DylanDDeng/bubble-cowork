const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Arch } = require('builder-util');

const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux', 'win32']);
const SUPPORTED_ARCHES = new Set(['arm64', 'ia32', 'x64']);

function targetFromContext(context) {
  const platform = context.electronPlatformName;
  const arch = Arch[context.arch];
  if (!SUPPORTED_PLATFORMS.has(platform) || !SUPPORTED_ARCHES.has(arch)) {
    throw new Error(`unsupported DeepSeek Harness package target: ${platform}-${arch}`);
  }
  return { platform, arch };
}

function prepareDeepseekRuntime(context) {
  const { platform, arch } = targetFromContext(context);
  const projectDir = context.packager.projectDir;
  const profileDir = path.join(projectDir, 'dev-fixtures', 'deepseek-harness');
  const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const crossArch = platform === process.platform && arch !== process.arch;
  const installArgs = ['ci', '--prefix', profileDir, `--os=${platform}`, `--cpu=${arch}`];
  if (crossArch) installArgs.push('--ignore-scripts');
  const result = spawnSync(
    npmExecutable,
    installArgs,
    {
      cwd: projectDir,
      env: process.env,
      stdio: 'inherit',
    }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`failed to install DeepSeek Harness runtime for ${platform}-${arch}`);
  }
  const spawnHelper = path.join(
    profileDir,
    'node_modules',
    'node-pty',
    'prebuilds',
    `${platform}-${arch}`,
    'spawn-helper'
  );
  if (fs.existsSync(spawnHelper)) fs.chmodSync(spawnHelper, 0o755);
  console.log(`  • prepared DeepSeek Harness runtime  target=${platform}-${arch}`);
}

module.exports = prepareDeepseekRuntime;
module.exports.targetFromContext = targetFromContext;
