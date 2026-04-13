import { promises as fs } from 'fs';
import type { Dirent } from 'fs';
import { basename, join } from 'path';
import type { ProjectTreeNode } from '../types';

const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'dist-electron',
  'build',
  '.next',
  '.nuxt',
  '.svelte-kit',
  'coverage',
  '.turbo',
  '.cache',
  '.vite',
  '.idea',
]);

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
    if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name)) {
      continue;
    }

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
