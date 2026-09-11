// electron-builder collects node_modules by walking `dependencies` /
// `optionalDependencies` edges from the root package (npm list _dependencies);
// it never follows peerDependencies. The SDK/CLI graph includes peer-only
// runtime edges, so every package reachable only through such a peer edge
// must be declared as a direct dependency or app.asar silently omits it.
const SDK_CLIENT = '@deepseek-ai/dsh-sdk-client';

// Resolve `name` from the package at `fromPath` the way Node does: nearest
// nested node_modules first, then each ancestor, then the top level.
function resolveLockPath(lockPackages, fromPath, name) {
  let base = fromPath;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (lockPackages[candidate]) return candidate;
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
    if (optional && (!matches(entry.os, platform) || !matches(entry.cpu, arch))) continue;
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

module.exports = {
  SDK_CLIENT, walkLockGraph, deepseekSdkClosure, electronBuilderCollected,
  deepseekSdkPackagePaths, electronBuilderPackagePaths,
};
