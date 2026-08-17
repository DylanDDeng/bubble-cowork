// electron-builder collects node_modules by walking `dependencies` /
// `optionalDependencies` edges from the root package (npm list _dependencies);
// it never follows peerDependencies. @deepseek-ai/dsh-sdk-client declares its
// whole runtime graph as peers, so every package reachable through a peer edge
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
function walkLockGraph(lockPackages, roots, { followPeers }) {
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
    if (seenPaths.has(lockPath)) continue;
    seenPaths.add(lockPath);
    names.add(name);
    const entry = lockPackages[lockPath];
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
  return names;
}

function deepseekSdkClosure(lockPackages) {
  return walkLockGraph(lockPackages, [SDK_CLIENT], { followPeers: true });
}

function electronBuilderCollected(lockPackages, rootDependencies) {
  return walkLockGraph(lockPackages, Object.keys(rootDependencies ?? {}), { followPeers: false });
}

module.exports = { SDK_CLIENT, walkLockGraph, deepseekSdkClosure, electronBuilderCollected };
