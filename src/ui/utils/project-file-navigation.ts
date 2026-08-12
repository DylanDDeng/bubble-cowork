import type { ProjectTreeNode } from '../types';
import { findProjectTreeFileMatches } from './resolve-tree-file';

export type ResolvedProjectFileReference =
  | { status: 'resolved'; cwd: string; path: string }
  | { status: 'not-found' }
  | { status: 'ambiguous'; paths: string[] };

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

/**
 * Resolve a relative transcript file reference without guessing.
 * Primary roots win when they contain a unique match. Other known workspaces
 * are considered only when the active session cannot resolve the reference.
 */
export async function resolveProjectFileReference(options: {
  requestedPath: string;
  primaryRoots: Array<string | null | undefined>;
  workspaceRoots: Array<string | null | undefined>;
  loadTree: (cwd: string) => Promise<ProjectTreeNode | null>;
}): Promise<ResolvedProjectFileReference> {
  const requestedPath = options.requestedPath.trim();
  if (!requestedPath) return { status: 'not-found' };

  const primaryRoots = uniqueRoots(options.primaryRoots);
  const primarySet = new Set(primaryRoots);
  const secondaryRoots = uniqueRoots(options.workspaceRoots).filter((root) => !primarySet.has(root));

  const resolveTier = async (roots: string[]): Promise<ResolvedProjectFileReference> => {
    const matches: Array<{ cwd: string; path: string; kind: string }> = [];
    await Promise.all(roots.map(async (cwd) => {
      try {
        const tree = await options.loadTree(cwd);
        if (!tree) return;
        for (const match of findProjectTreeFileMatches(tree, requestedPath)) {
          matches.push({ cwd, path: match.path, kind: match.kind });
        }
      } catch {
        // One stale recent workspace must not prevent other roots resolving.
      }
    }));

    if (matches.length === 0) return { status: 'not-found' };
    const bestKind = matches.some((match) => match.kind === 'exact')
      ? 'exact'
      : matches.some((match) => match.kind === 'suffix')
        ? 'suffix'
        : 'basename';
    const best = matches.filter((match) => match.kind === bestKind);
    const byPath = new Map(best.map((match) => [match.path, match]));
    const unique = Array.from(byPath.values());
    if (unique.length === 1) {
      return { status: 'resolved', cwd: unique[0].cwd, path: unique[0].path };
    }
    return { status: 'ambiguous', paths: unique.map((match) => match.path) };
  };

  const primary = await resolveTier(primaryRoots);
  if (primary.status !== 'not-found') return primary;
  return resolveTier(secondaryRoots);
}
