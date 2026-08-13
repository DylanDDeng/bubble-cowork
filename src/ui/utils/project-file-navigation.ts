import type { ProjectTreeNode } from '../types';
import {
  findProjectTreeFileMatches,
  type ProjectTreeFileMatchKind,
} from './resolve-tree-file';

export interface ProjectFileReferenceMatch {
  cwd: string;
  path: string;
  relativePath: string;
  kind: ProjectTreeFileMatchKind;
}

export type ResolvedProjectFileReference =
  | { status: 'resolved'; cwd: string; path: string }
  | { status: 'not-found' }
  | { status: 'ambiguous'; matches: Array<Pick<ProjectFileReferenceMatch, 'cwd' | 'path' | 'relativePath'>> };

function normalizeRoot(root: string | null | undefined): string | null {
  const normalized = root?.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized || null;
}

function uniqueRoots(roots: Array<string | null | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const normalized = normalizeRoot(root);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function bestKindOf(matches: ProjectFileReferenceMatch[]): ProjectTreeFileMatchKind {
  if (matches.some((match) => match.kind === 'exact')) return 'exact';
  if (matches.some((match) => match.kind === 'suffix')) return 'suffix';
  return 'basename';
}

function relativeDepth(relativePath: string): number {
  return relativePath.split('/').filter(Boolean).length;
}

/**
 * Same relative path in two checkouts is one file (worktree copy).
 * Earlier roots win — session cwd is listed before the project root.
 */
function dedupeByRelativePath(
  matches: ProjectFileReferenceMatch[],
  rootOrder: string[]
): ProjectFileReferenceMatch[] {
  const rank = new Map(rootOrder.map((root, index) => [root, index]));
  const byRelative = new Map<string, ProjectFileReferenceMatch>();
  for (const match of matches) {
    const existing = byRelative.get(match.relativePath);
    if (!existing) {
      byRelative.set(match.relativePath, match);
      continue;
    }
    const existingRank = rank.get(existing.cwd) ?? Number.POSITIVE_INFINITY;
    const nextRank = rank.get(match.cwd) ?? Number.POSITIVE_INFINITY;
    if (nextRank < existingRank) {
      byRelative.set(match.relativePath, match);
    }
  }
  return Array.from(byRelative.values());
}

/**
 * Pick a unique winner from already-collected matches.
 *
 * Copies of the same relative path collapse first. Remaining candidates
 * keep exact > suffix > basename, then the unique shallowest path. Equal
 * kind and depth is true ambiguity — the caller should let the user pick.
 */
export function chooseProjectFileMatches(
  matches: ProjectFileReferenceMatch[],
  rootOrder: string[]
): ResolvedProjectFileReference {
  if (matches.length === 0) return { status: 'not-found' };

  const kind = bestKindOf(matches);
  const unique = dedupeByRelativePath(
    matches.filter((match) => match.kind === kind),
    rootOrder
  );
  if (unique.length === 1) {
    return { status: 'resolved', cwd: unique[0].cwd, path: unique[0].path };
  }

  const minDepth = Math.min(...unique.map((match) => relativeDepth(match.relativePath)));
  const shallowest = unique.filter((match) => relativeDepth(match.relativePath) === minDepth);
  if (shallowest.length === 1) {
    return { status: 'resolved', cwd: shallowest[0].cwd, path: shallowest[0].path };
  }

  const sorted = [...shallowest].sort((left, right) => {
    if (left.relativePath !== right.relativePath) {
      return left.relativePath < right.relativePath ? -1 : 1;
    }
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
  return {
    status: 'ambiguous',
    matches: sorted.map(({ cwd, path, relativePath }) => ({ cwd, path, relativePath })),
  };
}

async function collectMatches(
  roots: string[],
  requestedPath: string,
  loadTree: (cwd: string) => Promise<ProjectTreeNode | null>
): Promise<ProjectFileReferenceMatch[]> {
  const matches: ProjectFileReferenceMatch[] = [];
  await Promise.all(roots.map(async (cwd) => {
    try {
      const tree = await loadTree(cwd);
      if (!tree) return;
      for (const match of findProjectTreeFileMatches(tree, requestedPath)) {
        matches.push({
          cwd,
          path: match.path,
          relativePath: match.relativePath,
          kind: match.kind,
        });
      }
    } catch {
      // One stale recent workspace must not prevent other roots resolving.
    }
  }));
  return matches;
}

/**
 * Resolve a relative transcript file reference.
 *
 * Primary roots (session cwd, then project root) are one group: copies of
 * the same relative path collapse, exact beats a weaker match across those
 * roots, and only a unique winner opens automatically. Other known
 * workspaces are consulted only when the active project has no match.
 */
export async function resolveProjectFileReference(options: {
  requestedPath: string;
  primaryRoots: Array<string | null | undefined>;
  workspaceRoots: Array<string | null | undefined>;
  loadTree: (cwd: string) => Promise<ProjectTreeNode | null>;
  statFile?: (cwd: string, relativePath: string) => Promise<string | null>;
}): Promise<ResolvedProjectFileReference> {
  const requestedPath = options.requestedPath.trim();
  if (!requestedPath) return { status: 'not-found' };

  const primaryRoots = uniqueRoots(options.primaryRoots);
  const primarySet = new Set(primaryRoots);
  const secondaryRoots = uniqueRoots(options.workspaceRoots).filter((root) => !primarySet.has(root));

  const primary = chooseProjectFileMatches(
    await collectMatches(primaryRoots, requestedPath, options.loadTree),
    primaryRoots
  );
  if (primary.status !== 'not-found') return primary;

  const onDisk = options.statFile
    ? await resolveExistingProjectFile(requestedPath, primaryRoots, options.statFile)
    : { status: 'not-found' as const };
  if (onDisk.status !== 'not-found') return onDisk;

  const secondary = chooseProjectFileMatches(
    await collectMatches(secondaryRoots, requestedPath, options.loadTree),
    secondaryRoots
  );
  if (secondary.status !== 'not-found') return secondary;

  if (!options.statFile) return secondary;
  return resolveExistingProjectFile(requestedPath, secondaryRoots, options.statFile);
}

/**
 * Newly written files (e.g. Grok `images/1.jpg`) are often missing from the
 * cached project tree. A direct disk check against known roots recovers them.
 */
export async function resolveExistingProjectFile(
  requestedPath: string,
  roots: Array<string | null | undefined>,
  statFile: (cwd: string, relativePath: string) => Promise<string | null>
): Promise<ResolvedProjectFileReference> {
  const relativePath = requestedPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!relativePath) return { status: 'not-found' };

  for (const cwd of uniqueRoots(roots)) {
    try {
      const absolutePath = await statFile(cwd, relativePath);
      if (absolutePath) {
        return { status: 'resolved', cwd, path: absolutePath };
      }
    } catch {
      // Keep scanning other roots.
    }
  }
  return { status: 'not-found' };
}
