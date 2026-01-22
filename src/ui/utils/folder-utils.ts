import type { FolderConfig, SessionView } from '../types';

// 文件夹树节点
export interface FolderTreeNode {
  path: string;
  name: string;
  displayName?: string;
  color?: string;
  collapsed?: boolean;
  order: number;
  children: FolderTreeNode[];
  sessions: SessionView[];
  isUncategorized?: boolean;
}

// 从扁平配置构建文件夹树结构
export function buildFolderTree(folders: FolderConfig[]): FolderTreeNode[] {
  const nodeMap = new Map<string, FolderTreeNode>();
  const rootNodes: FolderTreeNode[] = [];

  // 按路径长度排序，确保父节点先创建
  const sortedFolders = [...folders].sort((a, b) => {
    const depthA = a.path.split('/').length;
    const depthB = b.path.split('/').length;
    if (depthA !== depthB) return depthA - depthB;
    return a.order - b.order;
  });

  for (const folder of sortedFolders) {
    const segments = folder.path.split('/');
    const name = segments[segments.length - 1];
    const parentPath = segments.slice(0, -1).join('/');

    const node: FolderTreeNode = {
      path: folder.path,
      name,
      displayName: folder.displayName,
      color: folder.color,
      collapsed: folder.collapsed,
      order: folder.order,
      children: [],
      sessions: [],
    };

    nodeMap.set(folder.path, node);

    if (parentPath && nodeMap.has(parentPath)) {
      nodeMap.get(parentPath)!.children.push(node);
    } else if (!parentPath) {
      rootNodes.push(node);
    } else {
      // 父节点不存在（不应该发生，因为 folder-config 会自动创建父节点）
      rootNodes.push(node);
    }
  }

  // 按 order 排序子节点
  const sortChildren = (nodes: FolderTreeNode[]) => {
    nodes.sort((a, b) => a.order - b.order);
    for (const node of nodes) {
      sortChildren(node.children);
    }
  };
  sortChildren(rootNodes);

  return rootNodes;
}

// 构建带 session 的文件夹树
export function buildFolderTreeWithSessions(
  folders: FolderConfig[],
  sessions: SessionView[]
): { tree: FolderTreeNode[]; uncategorized: SessionView[] } {
  const tree = buildFolderTree(folders);
  const nodeMap = new Map<string, FolderTreeNode>();

  // 构建路径到节点的映射
  const buildMap = (nodes: FolderTreeNode[]) => {
    for (const node of nodes) {
      nodeMap.set(node.path, node);
      buildMap(node.children);
    }
  };
  buildMap(tree);

  const uncategorized: SessionView[] = [];

  // 将 session 分配到对应的文件夹
  for (const session of sessions) {
    if (session.folderPath && nodeMap.has(session.folderPath)) {
      nodeMap.get(session.folderPath)!.sessions.push(session);
    } else {
      uncategorized.push(session);
    }
  }

  // 对每个节点的 sessions 按 updatedAt 降序排序
  const sortSessions = (nodes: FolderTreeNode[]) => {
    for (const node of nodes) {
      node.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      sortSessions(node.children);
    }
  };
  sortSessions(tree);

  // 对 uncategorized 也按 updatedAt 降序排序
  uncategorized.sort((a, b) => b.updatedAt - a.updatedAt);

  return { tree, uncategorized };
}

// 获取文件夹的显示名称
export function getFolderDisplayName(folder: FolderConfig | FolderTreeNode): string {
  if (folder.displayName) {
    return folder.displayName;
  }
  // 从路径获取最后一段
  const segments = folder.path.split('/');
  return segments[segments.length - 1];
}

// 获取所有文件夹路径（用于 FolderMenu 的下拉选项）
export function getAllFolderPaths(folders: FolderConfig[]): string[] {
  return folders.map(f => f.path).sort();
}

// 检查一个路径是否是另一个路径的祖先
export function isAncestorOf(ancestorPath: string, descendantPath: string): boolean {
  return descendantPath.startsWith(ancestorPath + '/');
}

// 获取路径的所有祖先路径
export function getAncestorPaths(path: string): string[] {
  const segments = path.split('/');
  const ancestors: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    ancestors.push(segments.slice(0, i).join('/'));
  }
  return ancestors;
}

// 统计文件夹下的 session 数量（包括子文件夹）
export function countSessionsInFolder(
  folderPath: string,
  sessions: SessionView[]
): number {
  return sessions.filter(
    s => s.folderPath === folderPath || (s.folderPath && s.folderPath.startsWith(folderPath + '/'))
  ).length;
}

// 统计文件夹节点下的 session 数量（递归）
export function countSessionsInNode(node: FolderTreeNode): number {
  let count = node.sessions.length;
  for (const child of node.children) {
    count += countSessionsInNode(child);
  }
  return count;
}
