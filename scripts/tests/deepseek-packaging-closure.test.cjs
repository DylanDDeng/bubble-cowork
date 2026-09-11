const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { deepseekSdkPackagePaths, electronBuilderPackagePaths } = require('../deepseek-sdk-closure.cjs');

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

// Verify all supported release targets against the real locked graph without
// requiring foreign native binaries to be installed on the developer's host.
const root = path.resolve(__dirname, '../..');
const locked = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'))).packages;
const dependencies = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).dependencies;
for (const platform of ['darwin', 'linux', 'win32']) {
  for (const arch of ['arm64', 'x64']) {
    const target = { platform, arch };
    const collected = electronBuilderPackagePaths(locked, dependencies, target);
    assert.deepEqual([...deepseekSdkPackagePaths(locked, target)].filter((entry) => !collected.has(entry)), []);
  }
}
console.log('DeepSeek packaging: nested versions, peer coverage and six platform/architecture graphs passed');
