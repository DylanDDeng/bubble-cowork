import { promises as fs } from 'fs';
import type { Dirent } from 'fs';
import { basename, join } from 'path';
import type { ProjectTreeNode } from '../types';

async function buildNode(fullPath: string, name: string): Promise<ProjectTreeNode> {
  let stat;
  try {
    stat = await fs.lstat(fullPath);
  } catch {
    return { name, path: fullPath, kind: 'file' };
  }

  if (!stat.isDirectory()) {
    return { name, path: fullPath, kind: 'file' };
  }

  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(fullPath, { withFileTypes: true });
  } catch {
    return { name, path: fullPath, kind: 'dir', children: [] };
  }

  const children: ProjectTreeNode[] = [];
  for (const entry of entries) {
    const childPath = join(fullPath, entry.name);
    if (entry.isDirectory()) {
      children.push(await buildNode(childPath, entry.name));
    } else {
      children.push({ name: entry.name, path: childPath, kind: 'file' });
    }
  }

  return { name, path: fullPath, kind: 'dir', children };
}

export async function readProjectTree(rootPath: string): Promise<ProjectTreeNode> {
  const name = basename(rootPath) || rootPath;
  return buildNode(rootPath, name);
}
