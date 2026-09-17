const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deepseekSdkPackagePaths, electronBuilderPackagePaths, verifyDeepseekSdkResolution } = require('../deepseek-sdk-closure.cjs');

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

// Verify all supported release targets against the real locked graph without
// requiring foreign native binaries to be installed on the developer's host.
const root = path.resolve(__dirname, '../..');
const locked = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'))).packages;
const dependencies = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).dependencies;
for (const libc of ['glibc', 'musl']) {
  const closure = deepseekSdkPackagePaths(locked, { platform: 'linux', arch: 'x64', libc });
  const suffix = libc === 'musl' ? 'linuxmusl' : 'linux';
  const other = libc === 'musl' ? 'linux' : 'linuxmusl';
  assert(closure.has(`node_modules/@img/sharp-libvips-${suffix}-x64`));
  assert(!closure.has(`node_modules/@img/sharp-libvips-${other}-x64`));
}
for (const platform of ['darwin', 'linux', 'win32']) {
  for (const arch of ['arm64', 'x64']) {
    const target = { platform, arch };
    const collected = electronBuilderPackagePaths(locked, dependencies, target);
    assert.deepEqual([...deepseekSdkPackagePaths(locked, target)].filter((entry) => !collected.has(entry)), []);
  }
}
console.log('DeepSeek packaging: nested versions, peer coverage and six platform/architecture graphs passed');
