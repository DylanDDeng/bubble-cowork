interface TreeFileNode {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  children?: TreeFileNode[];
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
  const normalized = requestedPath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .trim();
  if (!normalized) return null;

  const requestedBase = normalized.split('/').filter(Boolean).pop() || normalized;
  const suffix = `/${normalized}`;

  let exact: string | null = null;
  const suffixMatches: { path: string; rel: string }[] = [];
  const baseMatches: { path: string; rel: string }[] = [];

  const walk = (node: TreeFileNode, relSegments: string[]) => {
    if (exact) return;
    if (node.kind === 'file') {
      const rel = relSegments.join('/');
      if (rel === normalized) {
        exact = node.path;
        return;
      }
      if (rel.endsWith(suffix)) {
        suffixMatches.push({ path: node.path, rel });
      } else if (node.name === requestedBase) {
        baseMatches.push({ path: node.path, rel });
      }
      return;
    }
    for (const child of node.children || []) {
      walk(child, [...relSegments, child.name]);
      if (exact) return;
    }
  };

  // The root node represents the cwd itself — its own name is not part of
  // project-relative paths.
  for (const child of root.children || []) {
    walk(child, [child.name]);
    if (exact) return exact;
  }

  const rank = (a: { rel: string }, b: { rel: string }) => {
    const depthA = a.rel.split('/').length;
    const depthB = b.rel.split('/').length;
    if (depthA !== depthB) return depthA - depthB;
    if (a.rel.length !== b.rel.length) return a.rel.length - b.rel.length;
    return a.rel.localeCompare(b.rel);
  };

  const candidates = suffixMatches.length > 0 ? suffixMatches : baseMatches;
  if (candidates.length === 0) return null;
  candidates.sort(rank);
  return candidates[0].path;
}
