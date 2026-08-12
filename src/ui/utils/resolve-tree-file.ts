interface TreeFileNode {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  children?: TreeFileNode[];
}

export type ProjectTreeFileMatchKind = 'exact' | 'suffix' | 'basename';

export interface ProjectTreeFileMatch {
  path: string;
  relativePath: string;
  kind: ProjectTreeFileMatchKind;
}

/** Return every plausible file match so callers can reject ambiguous links. */
export function findProjectTreeFileMatches(
  root: TreeFileNode,
  requestedPath: string
): ProjectTreeFileMatch[] {
  const normalized = requestedPath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .trim();
  if (!normalized) return [];

  const requestedBase = normalized.split('/').filter(Boolean).pop() || normalized;
  const suffix = `/${normalized}`;
  const matches: ProjectTreeFileMatch[] = [];

  const walk = (node: TreeFileNode, relSegments: string[]) => {
    if (node.kind === 'file') {
      const relativePath = relSegments.join('/');
      const kind =
        relativePath === normalized
          ? 'exact'
          : relativePath.endsWith(suffix)
            ? 'suffix'
            : node.name === requestedBase
              ? 'basename'
              : null;
      if (kind) matches.push({ path: node.path, relativePath, kind });
      return;
    }
    for (const child of node.children || []) {
      walk(child, [...relSegments, child.name]);
    }
  };

  for (const child of root.children || []) {
    walk(child, [child.name]);
  }

  const kindRank: Record<ProjectTreeFileMatchKind, number> = {
    exact: 0,
    suffix: 1,
    basename: 2,
  };
  return matches.sort((a, b) => {
    const rankDelta = kindRank[a.kind] - kindRank[b.kind];
    if (rankDelta !== 0) return rankDelta;
    const depthDelta = a.relativePath.split('/').length - b.relativePath.split('/').length;
    if (depthDelta !== 0) return depthDelta;
    return a.relativePath.localeCompare(b.relativePath);
  });
}

/**
 * Resolve a chat-mentioned file path against the loaded project tree.
 *
 * Assistant messages often reference files by bare name ("workstream-stages.ts")
 * or by a partial path ("utils/workstream.ts"); opening those verbatim against
 * the project root yields "File not found". This walks the in-memory tree and
 * picks the best real file: exact relative match, then path-suffix match, then
 * basename match — shallower (fewer segments) candidates win ties.
 *
 * Returns the node's absolute path, or null when nothing matches.
 */
export function resolveProjectTreeFile(
  root: TreeFileNode,
  requestedPath: string
): string | null {
  return findProjectTreeFileMatches(root, requestedPath)[0]?.path ?? null;
}
