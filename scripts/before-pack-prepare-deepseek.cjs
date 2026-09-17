const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Arch } = require('builder-util');
const os = require('node:os');
const { deepseekSdkPackagePaths } = require('./deepseek-sdk-closure.cjs');

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

// npm ci installs optional binaries for the host. A second macOS architecture
// needs its own optional SDK binaries before electron-builder collects files.
function prepareSdkTargetDependencies(projectDir, npmCli, platform, arch) {
  const lock = JSON.parse(fs.readFileSync(path.join(projectDir, 'package-lock.json'), 'utf8'));
  for (const packagePath of deepseekSdkPackagePaths(lock.packages, { platform, arch })) {
    const entry = lock.packages[packagePath];
    if (!entry.os && !entry.cpu) continue;
    const destination = path.join(projectDir, packagePath);
    const manifest = path.join(destination, 'package.json');
    if (fs.existsSync(manifest)) {
      if (JSON.parse(fs.readFileSync(manifest, 'utf8')).version !== entry.version) {
        throw new Error(`wrong installed version for ${packagePath}; run npm ci`);
      }
      continue;
    }
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-sdk-native-'));
    try {
      const packed = spawnSync(process.execPath, [npmCli, 'pack', entry.resolved, '--ignore-scripts', '--json', '--pack-destination', temporary], {
        cwd: projectDir, env: process.env, encoding: 'utf8',
      });
      if (packed.error || packed.status !== 0) throw new Error(`cannot download ${packagePath}: ${packed.error || packed.stderr}`);
      const metadata = JSON.parse(packed.stdout)[0];
      if (metadata.integrity !== entry.integrity) throw new Error(`integrity mismatch for ${packagePath}`);
      fs.mkdirSync(destination, { recursive: true });
      const extracted = spawnSync('tar', ['-xzf', path.join(temporary, metadata.filename), '--strip-components=1', '-C', destination], { stdio: 'inherit' });
      if (extracted.error || extracted.status !== 0) throw new Error(`cannot extract ${packagePath}`);
      console.log(`  • prepared SDK native dependency  package=${packagePath} target=${platform}-${arch}`);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
}

function prepareDeepseekRuntime(context) {
  const { platform, arch } = targetFromContext(context);
  const projectDir = context.packager.projectDir;
  const profileDir = path.join(projectDir, 'dev-fixtures', 'deepseek-harness');
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('npm_execpath is required to prepare DeepSeek Harness');
  prepareSdkTargetDependencies(projectDir, npmCli, platform, arch);
  const crossArch = platform === process.platform && arch !== process.arch;
  const installArgs = ['ci', '--prefix', profileDir, `--os=${platform}`, `--cpu=${arch}`];
  if (crossArch) installArgs.push('--ignore-scripts');
  const result = spawnSync(
    process.execPath,
    [npmCli, ...installArgs],
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
