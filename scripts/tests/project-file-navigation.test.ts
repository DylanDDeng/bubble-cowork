import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveProjectFileReference } from '../../src/ui/utils/project-file-navigation';
import type { ProjectTreeNode } from '../../src/ui/types';

function tree(root: string, paths: string[]): ProjectTreeNode {
  const rootNode: ProjectTreeNode = {
    name: root.split('/').pop() || root,
    path: root,
    kind: 'dir',
    children: [],
  };
  for (const relativePath of paths) {
    const segments = relativePath.split('/');
    let parent = rootNode;
    segments.forEach((segment, index) => {
      const path = `${root}/${segments.slice(0, index + 1).join('/')}`;
      const kind = index === segments.length - 1 ? 'file' : 'dir';
      let node = parent.children?.find((child) => child.name === segment);
      if (!node) {
        node = { name: segment, path, kind, ...(kind === 'dir' ? { children: [] } : {}) };
        parent.children = [...(parent.children || []), node];
      }
      parent = node;
    });
  }
  return rootNode;
}

const coworker = '/Users/test/coworker';
const garden = '/Users/test/Documents/My Personal Digital Garden';
const archive = '/Users/test/archive';
const trees = new Map<string, ProjectTreeNode>([
  [coworker, tree(coworker, ['公众号选题.md', 'App.tsx'])],
  [garden, tree(garden, ['工作文档/公众号选题.md', 'src/ui/App.tsx'])],
  [archive, tree(archive, ['旧稿/公众号选题.md'])],
]);
const loadTree = async (cwd: string) => trees.get(cwd) || null;

async function main() {
assert.deepEqual(
  await resolveProjectFileReference({
    requestedPath: '公众号选题.md',
    primaryRoots: [coworker],
    workspaceRoots: [garden],
    loadTree,
  }),
  { status: 'resolved', cwd: coworker, path: `${coworker}/公众号选题.md` },
  'a primary exact match must win before secondary workspaces'
);

assert.deepEqual(
  await resolveProjectFileReference({
    requestedPath: '公众号选题.md',
    primaryRoots: ['/Users/test/empty'],
    workspaceRoots: [garden],
    loadTree,
  }),
  { status: 'resolved', cwd: garden, path: `${garden}/工作文档/公众号选题.md` },
  'a unique recent-workspace basename should resolve with its workspace root'
);

assert.deepEqual(
  await resolveProjectFileReference({
    requestedPath: '公众号选题.md',
    primaryRoots: ['/Users/test/empty'],
    workspaceRoots: [garden, archive],
    loadTree,
  }),
  {
    status: 'ambiguous',
    paths: [`${garden}/工作文档/公众号选题.md`, `${archive}/旧稿/公众号选题.md`],
  },
  'duplicate best matches must be reported instead of guessed'
);

assert.deepEqual(
  await resolveProjectFileReference({
    requestedPath: 'missing.md',
    primaryRoots: [coworker],
    workspaceRoots: [garden, archive],
    loadTree,
  }),
  { status: 'not-found' }
);

assert.deepEqual(
  await resolveProjectFileReference({
    requestedPath: 'src/ui/App.tsx',
    primaryRoots: ['/Users/test/empty'],
    workspaceRoots: [garden, coworker],
    loadTree,
  }),
  { status: 'resolved', cwd: garden, path: `${garden}/src/ui/App.tsx` },
  'an exact relative match must outrank another workspace basename match'
);

const [markdownSource, messageCardSource, treePanelSource, storeSource] = await Promise.all([
  readFile(new URL('../../src/ui/render/markdown.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../src/ui/components/MessageCard.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../src/ui/components/ProjectTreePanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../src/ui/store/useAppStore.ts', import.meta.url), 'utf8'),
]);
assert.ok(!`${markdownSource}${messageCardSource}${treePanelSource}`.includes('aegis:open-project-file'));
assert.ok(markdownSource.includes('openProjectFileInRightPanel'));
assert.ok(messageCardSource.includes('openProjectFileInRightPanel'));
assert.match(storeSource, /pendingProjectFileOpen:\s*\{/);
assert.match(storeSource, /rightUtilityTabs:\s*opened\.tabs/);

console.log('project-file-navigation tests passed');
}

void main();
