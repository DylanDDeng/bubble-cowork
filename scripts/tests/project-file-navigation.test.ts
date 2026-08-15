import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  chooseProjectFileMatches,
  createProjectFileRevealTarget,
  resolveExistingProjectFile,
  resolveProjectFileReference,
  selectProjectFileRevealTarget,
} from '../../src/ui/utils/project-file-navigation';
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
const firstReveal = createProjectFileRevealTarget({
  cwd: coworker,
  path: `${coworker}/src/ui/First.tsx`,
  line: 900,
  token: 1,
});
assert.ok(firstReveal, 'a valid file line reference must create a reveal target');
assert.equal(
  selectProjectFileRevealTarget(firstReveal, coworker, `${coworker}/src/ui/First.tsx`),
  firstReveal,
  'the file that created the target must receive it unchanged'
);
assert.equal(
  selectProjectFileRevealTarget(firstReveal, coworker, `${coworker}/notes/Second.md`),
  null,
  'switching to another open file must not inherit the previous file line'
);
assert.equal(
  selectProjectFileRevealTarget(firstReveal, `${coworker}/`, `${coworker}/src/ui/First.tsx/`),
  firstReveal,
  'equivalent normalized paths must still match the originating file'
);

const repeatedReveal = createProjectFileRevealTarget({
  cwd: coworker,
  path: `${coworker}/src/ui/First.tsx`,
  line: 900,
  token: 2,
});
assert.ok(repeatedReveal);
assert.notEqual(
  repeatedReveal.token,
  firstReveal.token,
  'repeating the same file-line click must carry a new token so scrolling runs again'
);
assert.equal(
  createProjectFileRevealTarget({ cwd: coworker, path: `${coworker}/App.tsx`, line: 0, token: 3 }),
  null,
  'invalid line references must clear rather than create a reusable target'
);

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
    matches: [
      { cwd: garden, path: `${garden}/工作文档/公众号选题.md`, relativePath: '工作文档/公众号选题.md' },
      { cwd: archive, path: `${archive}/旧稿/公众号选题.md`, relativePath: '旧稿/公众号选题.md' },
    ],
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

const coworkerWithWorktree = '/Users/test/coworker-with-worktree';
const worktreeCheckout = '/Users/test/coworker-with-worktree/.worktrees/iso-fix';
trees.set(coworkerWithWorktree, tree(coworkerWithWorktree, [
  'src/shared/types.ts',
  'src/ui/types.ts',
  'src/electron/types.ts',
  '.worktrees/iso-fix/src/shared/types.ts',
]));
trees.set(worktreeCheckout, tree(worktreeCheckout, [
  'src/shared/types.ts',
  'src/ui/types.ts',
  'src/electron/types.ts',
]));

assert.deepEqual(
  await resolveProjectFileReference({
    requestedPath: 'shared/types.ts',
    primaryRoots: [coworkerWithWorktree],
    workspaceRoots: [],
    loadTree,
  }),
  { status: 'resolved', cwd: coworkerWithWorktree, path: `${coworkerWithWorktree}/src/shared/types.ts` },
  'a shallower in-tree suffix must beat a nested worktree clone of the same path'
);

assert.deepEqual(
  await resolveProjectFileReference({
    requestedPath: 'shared/types.ts',
    primaryRoots: [worktreeCheckout, coworkerWithWorktree],
    workspaceRoots: [],
    loadTree,
  }),
  { status: 'resolved', cwd: worktreeCheckout, path: `${worktreeCheckout}/src/shared/types.ts` },
  'a worktree session cwd must win over the same relative file in the project root'
);

assert.deepEqual(
  await resolveProjectFileReference({
    requestedPath: 'shared/types.ts',
    primaryRoots: ['/Users/test/empty', coworkerWithWorktree],
    workspaceRoots: [],
    loadTree,
  }),
  { status: 'resolved', cwd: coworkerWithWorktree, path: `${coworkerWithWorktree}/src/shared/types.ts` },
  'the next primary root should resolve when the session cwd has no match'
);

assert.deepEqual(
  await resolveProjectFileReference({
    requestedPath: 'types.ts',
    primaryRoots: [coworkerWithWorktree],
    workspaceRoots: [],
    loadTree,
  }),
  {
    status: 'ambiguous',
    matches: [
      { cwd: coworkerWithWorktree, path: `${coworkerWithWorktree}/src/electron/types.ts`, relativePath: 'src/electron/types.ts' },
      { cwd: coworkerWithWorktree, path: `${coworkerWithWorktree}/src/shared/types.ts`, relativePath: 'src/shared/types.ts' },
      { cwd: coworkerWithWorktree, path: `${coworkerWithWorktree}/src/ui/types.ts`, relativePath: 'src/ui/types.ts' },
    ],
  },
  'same-depth basename matches in one project must stay ambiguous'
);

const worktreeOnlyUiApp = '/Users/test/worktree-ui-app';
const projectRootApp = '/Users/test/project-root-app';
trees.set(worktreeOnlyUiApp, tree(worktreeOnlyUiApp, ['src/ui/App.tsx']));
trees.set(projectRootApp, tree(projectRootApp, ['App.tsx']));

assert.deepEqual(
  await resolveProjectFileReference({
    requestedPath: 'App.tsx',
    primaryRoots: [worktreeOnlyUiApp, projectRootApp],
    workspaceRoots: [],
    loadTree,
  }),
  { status: 'resolved', cwd: projectRootApp, path: `${projectRootApp}/App.tsx` },
  'an exact match in the project root must outrank a suffix in the session cwd'
);

assert.deepEqual(
  chooseProjectFileMatches(
    [
      { cwd: coworker, path: `${coworker}/src/types.ts`, relativePath: 'src/types.ts', kind: 'basename' },
      { cwd: coworker, path: `${coworker}/src/ui/types.ts`, relativePath: 'src/ui/types.ts', kind: 'basename' },
    ],
    [coworker]
  ),
  { status: 'resolved', cwd: coworker, path: `${coworker}/src/types.ts` },
  'a unique shallower basename must win over a deeper one'
);

assert.deepEqual(
  await resolveExistingProjectFile(
    'images/1.jpg',
    [coworker],
    async (cwd, relativePath) => cwd === coworker && relativePath === 'images/1.jpg'
      ? `${coworker}/images/1.jpg`
      : null
  ),
  { status: 'resolved', cwd: coworker, path: `${coworker}/images/1.jpg` },
  'a newly written relative file should resolve from disk when the tree is stale'
);

assert.deepEqual(
  await resolveExistingProjectFile('images/1.jpg', [coworker], async () => null),
  { status: 'not-found' }
);

assert.deepEqual(
  await resolveProjectFileReference({
    requestedPath: 'images/1.jpg',
    primaryRoots: [coworker],
    workspaceRoots: [],
    loadTree,
    statFile: async (cwd, relativePath) =>
      cwd === coworker && relativePath === 'images/1.jpg' ? `${coworker}/images/1.jpg` : null,
  }),
  { status: 'resolved', cwd: coworker, path: `${coworker}/images/1.jpg` },
  'disk fallback must recover a new file the cached tree does not contain'
);

const [
  markdownSource,
  messageCardSource,
  treePanelSource,
  storeSource,
  appSource,
  textEditorSource,
  highlightedCodeSource,
] = await Promise.all([
  readFile(new URL('../../src/ui/render/markdown.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../src/ui/components/MessageCard.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../src/ui/components/ProjectTreePanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../src/ui/store/useAppStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../src/ui/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../src/ui/components/ProjectTextEditor.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../../src/ui/components/HighlightedCode.tsx', import.meta.url), 'utf8'),
]);
assert.ok(!`${markdownSource}${messageCardSource}${treePanelSource}`.includes('aegis:open-project-file'));
assert.ok(!markdownSource.includes('Use a more specific path'));
assert.ok(markdownSource.includes('pickProjectFileMatch'));
assert.ok(markdownSource.includes('openProjectFileInRightPanel'));
assert.ok(messageCardSource.includes('openProjectFileInRightPanel'));
assert.ok(treePanelSource.includes('selectVisibleProjectTree'));
assert.ok(treePanelSource.includes('shouldPublishProjectTreeToStore'));
assert.ok(appSource.includes('ProjectFileMatchDialogHost'));
assert.match(storeSource, /pendingProjectFileOpen:\s*\{/);
assert.match(storeSource, /rightUtilityTabs:\s*opened\.tabs/);
assert.ok(!treePanelSource.includes('sliceTextLineRange'));
assert.ok(treePanelSource.includes('setFileRevealTarget(null)'));
assert.ok(treePanelSource.includes('scrollTarget={activeFileRevealTarget}'));
assert.ok(treePanelSource.includes('revealTarget={activeFileRevealTarget}'));
assert.ok(textEditorSource.includes("effects: EditorView.scrollIntoView(line.from, { y: 'center' })"));
assert.ok(highlightedCodeSource.includes("scrollIntoView({ block: 'center', inline: 'nearest' })"));

await import('./project-file-reveal-electron.test.mjs');

console.log('project-file-navigation tests passed');
}

void main();
