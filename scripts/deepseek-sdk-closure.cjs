// electron-builder collects node_modules by walking `dependencies` /
// `optionalDependencies` edges from the root package (npm list _dependencies);
// it never follows peerDependencies. The SDK/CLI graph includes peer-only
// runtime edges, so every package reachable only through such a peer edge
// must be declared as a direct dependency or app.asar silently omits it.
const SDK_CLIENT = '@deepseek-ai/dsh-sdk-client';
// The SDK client depends on the whole dsh CLI only to find a default launch
// binary when the caller passes no `dshBin`. Aegis always passes the bundled
// profile's runtime-bin.mjs, so the CLI graph (its Web UI, LibreOffice and
// speech runtimes, other model SDKs) is never loaded and is not packaged.
const UNUSED_SDK_LAUNCHER = '@deepseek-ai/dsh';

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
  // Package names whose edges are not followed (they are not packaged).
  skip = new Set(),
  // Keep optional native packages of every platform instead of one target.
  matchAllTargets = false,
}) {
  const seenPaths = new Set();
  const names = new Set();
  const queue = roots.map((name) => ({ name, fromPath: '', optional: false, from: '<root>' }));
  while (queue.length > 0) {
    const { name, fromPath, optional, from } = queue.shift();
    if (skip.has(name)) continue;
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
    if (optional && !matchAllTargets && (!matches(entry.os, platform) || !matches(entry.cpu, arch) || (platform === 'linux' && !matches(entry.libc, libc)))) continue;
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

const SKIP_LAUNCHER = new Set([UNUSED_SDK_LAUNCHER]);

function deepseekSdkClosure(lockPackages, target = {}) {
  return walkLockGraph(lockPackages, [SDK_CLIENT], { ...target, followPeers: true, skip: SKIP_LAUNCHER });
}

function electronBuilderCollected(lockPackages, rootDependencies) {
  return walkLockGraph(lockPackages, Object.keys(rootDependencies ?? {}), { followPeers: false });
}

function deepseekSdkPackagePaths(lockPackages, target = {}) {
  return walkLockGraph(lockPackages, [SDK_CLIENT], {
    ...target, followPeers: true, returnPaths: true, skip: SKIP_LAUNCHER,
  });
}

const packageName = (lockPath) => lockPath.slice(lockPath.lastIndexOf('node_modules/') + 'node_modules/'.length);

// What electron-builder ships: it still collects the launcher's dependency
// edges, then electron-builder.config.cjs drops every copy of the package
// names only the launcher needs. Packages the launcher shares stay packaged.
function electronBuilderPackagePaths(lockPackages, rootDependencies, target = {}) {
  const collected = walkLockGraph(lockPackages, Object.keys(rootDependencies ?? {}), {
    ...target, followPeers: false, returnPaths: true,
  });
  const unused = new Set(unusedLauncherPackageNames(lockPackages, rootDependencies));
  return new Set([...collected].filter((lockPath) => !unused.has(packageName(lockPath))));
}

// Lockfile paths electron-builder would collect only because of the unused
// launcher. A path still reachable from anything else — including through a
// peer edge of a kept package — is kept. Platform filters are not applied, so
// the result covers every release target.
function unusedLauncherPackagePaths(lockPackages, rootDependencies) {
  const roots = Object.keys(rootDependencies ?? {});
  const all = { returnPaths: true, matchAllTargets: true };
  const collected = walkLockGraph(lockPackages, roots, { ...all, followPeers: false });
  const kept = walkLockGraph(lockPackages, roots, { ...all, followPeers: true, skip: SKIP_LAUNCHER });
  const unused = [...collected].filter((lockPath) => !kept.has(lockPath)).sort();
  for (const lockPath of unused) {
    const top = lockPath.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/)[0];
    if (kept.has(top)) {
      throw new Error(`${lockPath} is only used by ${UNUSED_SDK_LAUNCHER} but sits under kept package ${top}`);
    }
  }
  return unused;
}

// Package names to exclude from the app. electron-builder re-hoists the
// production tree, so a kept nested copy (Pi's own pi-ai, for example) can
// land at the top-level path the launcher used. Exclude a name only when no
// kept path anywhere in the lockfile carries it, and then exclude every copy.
function unusedLauncherPackageNames(lockPackages, rootDependencies) {
  const unused = new Set(unusedLauncherPackagePaths(lockPackages, rootDependencies));
  const kept = new Set(Object.keys(lockPackages)
    .filter((lockPath) => lockPath.includes('node_modules/') && !unused.has(lockPath))
    .map(packageName));
  return [...new Set([...unused].map(packageName))].filter((name) => !kept.has(name)).sort();
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
    if (SKIP_LAUNCHER.has(name)) continue;
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

// Every required dependency edge of the packaged production graph, followed
// through the packaged manifests the way Node resolves them. Returns the
// edges that resolve to nothing, so an exclusion that removes a package
// something still requires fails the build instead of the app at runtime.
function findUnresolvedPackagedDependencies(rootNames, readManifest, { ignore = new Set() } = {}) {
  const unresolved = new Set();
  const seen = new Set();
  const queue = rootNames.map((name) => ({ name, parent: '', optional: false, by: '<root>' }));
  while (queue.length) {
    const { name, parent, optional, by } = queue.shift();
    if (SKIP_LAUNCHER.has(name) || ignore.has(name)) continue;
    const packagePath = resolvePackagePath(parent, name, (candidate) => Boolean(readManifest(candidate)));
    if (!packagePath) {
      if (!optional) unresolved.add(`${name} (required by ${by})`);
      continue;
    }
    if (seen.has(packagePath)) continue;
    seen.add(packagePath);
    const manifest = readManifest(packagePath);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      queue.push({ name: dependency, parent: packagePath, optional: false, by: manifest.name ?? name });
    }
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
      queue.push({ name: dependency, parent: packagePath, optional: true, by: manifest.name ?? name });
    }
  }
  return [...unresolved].sort();
}

module.exports = {
  SDK_CLIENT, UNUSED_SDK_LAUNCHER, walkLockGraph, deepseekSdkClosure, electronBuilderCollected,
  deepseekSdkPackagePaths, electronBuilderPackagePaths, unusedLauncherPackagePaths,
  unusedLauncherPackageNames, verifyDeepseekSdkResolution, findUnresolvedPackagedDependencies,
};
