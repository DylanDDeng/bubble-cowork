// electron-builder collects node_modules by walking `dependencies` /
// `optionalDependencies` edges from the root package (npm list _dependencies);
// it never follows peerDependencies. The SDK/CLI graph includes peer-only
// runtime edges, so every package reachable only through such a peer edge
// must be declared as a direct dependency or app.asar silently omits it.
const SDK_CLIENT = '@deepseek-ai/dsh-sdk-client';

// Resolve `name` from the package at `fromPath` the way Node does: nearest
// nested node_modules first, then each ancestor, then the top level.
function resolveLockPath(lockPackages, fromPath, name) {
  return resolvePackagePath(fromPath, name, (candidate) => Boolean(lockPackages[candidate]));
}

function resolvePackagePath(fromPath, name, exists) {
  let base = fromPath;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (exists(candidate)) return candidate;
    if (!base) return null;
    const idx = base.lastIndexOf('/node_modules/');
    base = idx === -1 ? '' : base.slice(0, idx);
  }
}

// Walk the lockfile graph from `roots` (top-level package names). Returns the
// set of reachable package names. Optional edges (optionalDependencies, or
// peers flagged optional in peerDependenciesMeta) may be absent from the
// lockfile; any other unresolvable edge means the lockfile is stale and throws.
function walkLockGraph(lockPackages, roots, {
  followPeers,
  platform = process.platform,
  arch = process.arch,
  // Release Linux builds target glibc; callers can explicitly validate musl.
  libc = 'glibc',
  returnPaths = false,
}) {
  const seenPaths = new Set();
  const names = new Set();
  const queue = roots.map((name) => ({ name, fromPath: '', optional: false, from: '<root>' }));
  while (queue.length > 0) {
    const { name, fromPath, optional, from } = queue.shift();
    const lockPath = resolveLockPath(lockPackages, fromPath, name);
    if (!lockPath) {
      if (optional) continue;
      throw new Error(
        `package-lock.json cannot resolve ${name} (required by ${from}); run npm install`
      );
    }
    const entry = lockPackages[lockPath];
    // The lock records optional native binaries for every platform. Only the
    // target's packages are installed/collected, including in cross builds.
    const matches = (values, target) => !values || (
      !values.includes(`!${target}`) &&
      (!values.some((value) => !value.startsWith('!')) || values.includes('any') || values.includes(target))
    );
    if (optional && (!matches(entry.os, platform) || !matches(entry.cpu, arch) || (platform === 'linux' && !matches(entry.libc, libc)))) continue;
    if (seenPaths.has(lockPath)) continue;
    seenPaths.add(lockPath);
    names.add(name);
    const meta = entry.peerDependenciesMeta ?? {};
    const push = (deps, optionalEdge) => {
      for (const dep of Object.keys(deps ?? {})) {
        queue.push({ name: dep, fromPath: lockPath, optional: optionalEdge(dep), from: name });
      }
    };
    push(entry.dependencies, () => false);
    push(entry.optionalDependencies, () => true);
    if (followPeers) push(entry.peerDependencies, (dep) => meta[dep]?.optional === true);
  }
  return returnPaths ? seenPaths : names;
}

function deepseekSdkClosure(lockPackages, target = {}) {
  return walkLockGraph(lockPackages, [SDK_CLIENT], { ...target, followPeers: true });
}

function electronBuilderCollected(lockPackages, rootDependencies) {
  return walkLockGraph(lockPackages, Object.keys(rootDependencies ?? {}), { followPeers: false });
}

function deepseekSdkPackagePaths(lockPackages, target = {}) {
  return walkLockGraph(lockPackages, [SDK_CLIENT], { ...target, followPeers: true, returnPaths: true });
}

function electronBuilderPackagePaths(lockPackages, rootDependencies, target = {}) {
  return walkLockGraph(lockPackages, Object.keys(rootDependencies ?? {}), {
    ...target, followPeers: false, returnPaths: true,
  });
}

// electron-builder hoists production dependencies independently of npm's
// development tree. Verify each edge from its packaged parent rather than
// requiring the archive to preserve the lockfile's physical directory layout.
function verifyDeepseekSdkResolution(lockPackages, readManifest, target = {}) {
  const semver = require('semver');
  const { platform = process.platform, arch = process.arch, libc = 'glibc' } = target;
  const matches = (values, value) => !values || (
    !values.includes(`!${value}`) &&
    (!values.some((item) => !item.startsWith('!')) || values.includes('any') || values.includes(value))
  );
  const versionsByName = new Map();
  for (const [packagePath, entry] of Object.entries(lockPackages)) {
    if (!packagePath.includes('node_modules/')) continue;
    const name = packagePath.slice(packagePath.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!versionsByName.has(name)) versionsByName.set(name, new Map());
    versionsByName.get(name).set(entry.version, entry);
  }
  const queue = [{ name: SDK_CLIENT, range: lockPackages[`node_modules/${SDK_CLIENT}`].version, parent: '', optional: false }];
  const seen = new Set();
  while (queue.length) {
    const { name, range, parent, optional } = queue.shift();
    const lockedVersions = versionsByName.get(name);
    if (optional && (!lockedVersions || ![...lockedVersions.values()].some((entry) => matches(entry.os, platform) && matches(entry.cpu, arch) && (platform !== 'linux' || matches(entry.libc, libc))))) continue;
    const packagedPath = resolvePackagePath(parent, name, (candidate) => Boolean(readManifest(candidate)));
    if (!packagedPath) {
      const nativeTarget = [...(lockedVersions?.values() ?? [])].some((entry) => entry.os || entry.cpu);
      if (optional && !nativeTarget) continue;
      throw new Error(`packaged app is missing DeepSeek SDK package ${name} (required by ${parent || '<root>'})`);
    }
    const actual = readManifest(packagedPath);
    if (!lockedVersions?.has(actual.version)) {
      throw new Error(`packaged DeepSeek SDK package ${packagedPath} version ${actual.version} is not in the lockfile`);
    }
    if (!semver.satisfies(actual.version, range)) {
      throw new Error(`packaged DeepSeek SDK package ${packagedPath} is ${actual.version}, required range is ${range} from ${parent || '<root>'}`);
    }
    if (seen.has(packagedPath)) continue;
    seen.add(packagedPath);
    // Equal package versions may occur at multiple lockfile paths with
    // different compatible children. Check the shipped runtime graph against
    // its declared ranges and locked versions, not one development-tree path.
    const expected = lockedVersions.get(actual.version);
    const dependencies = { ...expected.dependencies, ...expected.optionalDependencies, ...expected.peerDependencies };
    for (const [dependency, dependencyRange] of Object.entries(dependencies)) {
      queue.push({
        name: dependency, range: dependencyRange, parent: packagedPath,
        optional: Object.hasOwn(expected.optionalDependencies ?? {}, dependency) || expected.peerDependenciesMeta?.[dependency]?.optional === true,
      });
    }
  }
  return seen.size;
}

module.exports = {
  SDK_CLIENT, walkLockGraph, deepseekSdkClosure, electronBuilderCollected,
  deepseekSdkPackagePaths, electronBuilderPackagePaths,
  verifyDeepseekSdkResolution,
};
