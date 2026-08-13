import type { ProjectTreeNode } from '../types';

export function normalizeProjectTreePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

export function isSameProjectTreeRoot(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  if (!left || !right) return false;
  return normalizeProjectTreePath(left) === normalizeProjectTreePath(right);
}

/**
 * The shared projectTree cache is also used by @-mentions. External folders
 * (Grok session images, citation paths) must not replace the workspace tree.
 */
export function shouldPublishProjectTreeToStore(
  panelCwd: string,
  workspaceCwd: string | null | undefined
): boolean {
  if (!workspaceCwd) return true;
  return isSameProjectTreeRoot(panelCwd, workspaceCwd);
}

export function selectVisibleProjectTree(params: {
  cwd: string | null;
  projectTree: ProjectTreeNode | null;
  projectTreeCwd: string | null;
  panelTree: ProjectTreeNode | null;
  panelTreeCwd: string | null;
}): ProjectTreeNode | null {
  const { cwd, projectTree, projectTreeCwd, panelTree, panelTreeCwd } = params;
  if (!cwd) return null;
  if (projectTree && isSameProjectTreeRoot(projectTreeCwd, cwd)) return projectTree;
  if (panelTree && isSameProjectTreeRoot(panelTreeCwd, cwd)) return panelTree;
  return null;
}
