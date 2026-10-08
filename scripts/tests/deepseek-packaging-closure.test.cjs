const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  deepseekSdkPackagePaths, electronBuilderPackagePaths, unusedLauncherPackagePaths, unusedLauncherPackageNames,
  verifyDeepseekSdkResolution, findUnresolvedPackagedDependencies,
} = require('../deepseek-sdk-closure.cjs');

const sdk = 'node_modules/@deepseek-ai/dsh-sdk-client';
const nested = `${sdk}/node_modules/shared`;
const packages = {
  [sdk]: { dependencies: { shared: '2' }, optionalDependencies: { arm: '1', x64: '1' } },
  'node_modules/shared': { version: '1' },
  [nested]: { version: '2', peerDependencies: { peer: '1' } },
  'node_modules/peer': { version: '1' },
  'node_modules/arm': { os: ['darwin'], cpu: ['arm64'] },
  'node_modules/x64': { os: ['darwin'], cpu: ['x64'] },
};
for (const arch of ['arm64', 'x64']) {
  const target = { platform: 'darwin', arch };
  const required = deepseekSdkPackagePaths(packages, target);
  assert(required.has(nested), 'nested versions must be verified at their actual path');
  assert(!required.has('node_modules/shared'), 'a root version cannot stand in for a nested dependency');
  assert(required.has(`node_modules/${arch === 'arm64' ? 'arm' : 'x64'}`));
  assert(!required.has(`node_modules/${arch === 'arm64' ? 'x64' : 'arm'}`));
  const collected = electronBuilderPackagePaths(packages, { '@deepseek-ai/dsh-sdk-client': '1' }, target);
  assert(!collected.has('node_modules/peer'), 'electron-builder does not follow peer edges');
  const complete = electronBuilderPackagePaths(packages, { '@deepseek-ai/dsh-sdk-client': '1', peer: '1' }, target);
  assert([...required].every((entry) => complete.has(entry)));
}
const broken = { ...packages }; delete broken[nested]; delete broken['node_modules/shared'];
assert.throws(() => deepseekSdkPackagePaths(broken), /cannot resolve shared/);

// Production hoisting may replace a root development version with the SDK's
// nested version. Validate runtime resolution, while still rejecting fallback
// to an incompatible version or a package missing from the archive.
const hoistedLock = {
  [sdk]: { version: '1.0.0', dependencies: { shared: '2', other: '1' } },
  [nested]: { version: '2.0.0', peerDependencies: { peer: '1' } },
  'node_modules/shared': { version: '1.0.0', dev: true },
  'node_modules/peer': { version: '1.0.0' },
  'node_modules/other': { version: '1.0.0', dependencies: { shared: '3' } },
  'node_modules/other/node_modules/shared': { version: '3.0.0' },
};
const archive = {
  [sdk]: { version: '1.0.0' },
  'node_modules/shared': { version: '2.0.0' },
  'node_modules/peer': { version: '1.0.0' },
  'node_modules/other': { version: '1.0.0' },
  'node_modules/other/node_modules/shared': { version: '3.0.0' },
};
assert.equal(verifyDeepseekSdkResolution(hoistedLock, (p) => archive[p]), 5);
assert.throws(
  () => verifyDeepseekSdkResolution(hoistedLock, (p) => p === 'node_modules/shared' ? { version: '1.0.0' } : archive[p]),
  /required range is 2/
);
assert.throws(
  () => verifyDeepseekSdkResolution(hoistedLock, (p) => p === 'node_modules/peer' ? null : archive[p]),
  /missing DeepSeek SDK package peer/
);
assert.throws(
  () => verifyDeepseekSdkResolution(hoistedLock, (p) => p === 'node_modules/other/node_modules/shared' ? null : archive[p]),
  /required range is 3/
);
assert.throws(
  () => verifyDeepseekSdkResolution(hoistedLock, (p) => p === 'node_modules/shared' ? { version: '2.1.0' } : archive[p]),
  /not in the lockfile/
);
// A production hoister can merge equal parents whose compatible child
// versions differed in the npm tree (for example the Smithy SDK packages).
const compatibleLock = {
  ...hoistedLock,
  [sdk]: { version: '1.0.0', dependencies: { shared: '^2.0.0', other: '1' } },
  'node_modules/elsewhere/node_modules/shared': { version: '2.1.0', peerDependencies: { peer: '1' } },
};
assert.equal(verifyDeepseekSdkResolution(compatibleLock, (p) => p === 'node_modules/shared' ? { version: '2.1.0' } : archive[p]), 5);
const nativeLock = {
  [sdk]: { version: '1.0.0', optionalDependencies: { native: '1' } },
  'node_modules/native': { version: '1.0.0', os: ['darwin'], cpu: ['x64'] },
};
assert.throws(
  () => verifyDeepseekSdkResolution(nativeLock, (p) => archive[p], { platform: 'darwin', arch: 'x64' }),
  /missing DeepSeek SDK package native/
);
assert.equal(verifyDeepseekSdkResolution(nativeLock, (p) => archive[p], { platform: 'darwin', arch: 'arm64' }), 1);

// Linux release builds target glibc unless musl is requested explicitly.
const libcLock = {
  [sdk]: { version: '1.0.0', optionalDependencies: { 'vips-linux': '1', 'vips-linuxmusl': '1' } },
  'node_modules/vips-linux': { version: '1.0.0', os: ['linux'], cpu: ['x64'], libc: ['glibc'] },
  'node_modules/vips-linuxmusl': { version: '1.0.0', os: ['linux'], cpu: ['x64'], libc: ['musl'] },
};
for (const libc of ['glibc', 'musl']) {
  const closure = deepseekSdkPackagePaths(libcLock, { platform: 'linux', arch: 'x64', libc });
  assert(closure.has(`node_modules/vips-${libc === 'musl' ? 'linuxmusl' : 'linux'}`));
  assert(!closure.has(`node_modules/vips-${libc === 'musl' ? 'linux' : 'linuxmusl'}`));
}

// The SDK's dependency on the dsh CLI is a default-launch fallback Aegis never
// uses: packages only that CLI reaches are excluded, shared ones are kept.
const launcherLock = {
  [sdk]: { version: '1.0.0', dependencies: { '@deepseek-ai/dsh': '1', protocol: '1' } },
  'node_modules/@deepseek-ai/dsh': { version: '1.0.0', dependencies: { office: '1', protocol: '1', helper: '1' } },
  'node_modules/@deepseek-ai/dsh/node_modules/private': { version: '1.0.0' },
  'node_modules/office': { version: '1.0.0', optionalDependencies: { 'office-win32-x64': '1' } },
  'node_modules/office-win32-x64': { version: '1.0.0', os: ['win32'], cpu: ['x64'] },
  'node_modules/protocol': { version: '1.0.0' },
  'node_modules/helper': { version: '1.0.0' },
  'node_modules/app': { version: '1.0.0', peerDependencies: { helper: '1' } },
};
assert.deepEqual([...deepseekSdkPackagePaths(launcherLock)].sort(), [sdk, 'node_modules/protocol']);
assert.deepEqual(
  unusedLauncherPackagePaths(launcherLock, { '@deepseek-ai/dsh-sdk-client': '1', app: '1' }),
  ['node_modules/@deepseek-ai/dsh', 'node_modules/office', 'node_modules/office-win32-x64'],
  'exclusions cover every target and keep a package another one needs as a peer'
);
// electron-builder may hoist a kept nested copy into the launcher's top-level
// path, so a name used anywhere else is never excluded.
const sharedNameLock = {
  ...launcherLock,
  'node_modules/app': { version: '1.0.0', dependencies: { office: '2' } },
  'node_modules/app/node_modules/office': { version: '2.0.0' },
};
const appRoot = { '@deepseek-ai/dsh-sdk-client': '1', app: '1' };
assert.deepEqual(unusedLauncherPackageNames(launcherLock, appRoot), ['@deepseek-ai/dsh', 'office', 'office-win32-x64']);
assert.deepEqual(unusedLauncherPackageNames(sharedNameLock, appRoot), ['@deepseek-ai/dsh', 'helper', 'office-win32-x64']);
assert(electronBuilderPackagePaths(sharedNameLock, appRoot).has('node_modules/office'), 'a shared name stays packaged');
assert.equal(
  verifyDeepseekSdkResolution(launcherLock, (p) => (p === 'node_modules/@deepseek-ai/dsh' ? null : launcherLock[p])),
  2,
  'a packaged app without the dsh CLI still resolves the SDK client'
);

// The packaged production graph must resolve through the archive's own layout.
// Here the hoister moved app's nested office copy to the top level, which an
// exclusion of that path would remove.
const packaged = {
  'node_modules/app': { name: 'app', dependencies: { office: '2', '@deepseek-ai/dsh': '1' }, optionalDependencies: { native: '1' } },
  'node_modules/office': { name: 'office', dependencies: { icons: '1' } },
};
assert.deepEqual(findUnresolvedPackagedDependencies(['app'], (p) => packaged[p] ?? null, { ignore: new Set(['icons']) }), []);
assert.deepEqual(
  findUnresolvedPackagedDependencies(['app'], (p) => (p === 'node_modules/office' ? null : packaged[p] ?? null)),
  ['office (required by app)']
);

// Verify all supported release targets against the real locked graph without
// requiring foreign native binaries to be installed on the developer's host.
const root = path.resolve(__dirname, '../..');
const locked = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'))).packages;
const dependencies = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).dependencies;
const excludedNames = new Set(unusedLauncherPackageNames(locked, dependencies));
assert(excludedNames.has('@deepseek-ai/dsh'));
const excluded = { has: (entry) => excludedNames.has(entry.slice(entry.lastIndexOf('node_modules/') + 13)) };
for (const platform of ['darwin', 'linux', 'win32']) {
  for (const arch of ['arm64', 'x64']) {
    const target = { platform, arch };
    const collected = electronBuilderPackagePaths(locked, dependencies, target);
    const closure = [...deepseekSdkPackagePaths(locked, target)];
    assert.deepEqual(closure.filter((entry) => !collected.has(entry)), []);
    assert.deepEqual(closure.filter((entry) => excluded.has(entry)), []);
  }
}
console.log('DeepSeek packaging: nested versions, peer coverage and six platform/architecture graphs passed');
