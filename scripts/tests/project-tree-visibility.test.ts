import assert from 'node:assert/strict';
import type { ProjectTreeNode } from '../../src/ui/types';
import {
  selectVisibleProjectTree,
  shouldPublishProjectTreeToStore,
} from '../../src/ui/utils/project-tree-visibility';

const workspace: ProjectTreeNode = {
  name: 'coworker',
  path: '/Users/me/coworker',
  kind: 'dir',
  children: [{ name: 'src', path: '/Users/me/coworker/src', kind: 'dir', children: [] }],
};

const images: ProjectTreeNode = {
  name: 'images',
  path: '/Users/me/.grok/sessions/x/images',
  kind: 'dir',
  children: [{ name: '1.jpg', path: '/Users/me/.grok/sessions/x/images/1.jpg', kind: 'file' }],
};

assert.equal(
  shouldPublishProjectTreeToStore('/Users/me/coworker', '/Users/me/coworker'),
  true
);
assert.equal(
  shouldPublishProjectTreeToStore('/Users/me/.grok/sessions/x/images', '/Users/me/coworker'),
  false,
  'generated-media folders must not replace the workspace tree cache'
);
assert.equal(
  shouldPublishProjectTreeToStore('/Users/me/.grok/sessions/x/images', null),
  true
);

assert.equal(
  selectVisibleProjectTree({
    cwd: '/Users/me/.grok/sessions/x/images',
    projectTree: workspace,
    projectTreeCwd: '/Users/me/coworker',
    panelTree: images,
    panelTreeCwd: '/Users/me/.grok/sessions/x/images',
  }),
  images,
  'Files rail must keep the opened folder when the shared cache stays on the workspace'
);

assert.equal(
  selectVisibleProjectTree({
    cwd: '/Users/me/.grok/sessions/x/images',
    projectTree: workspace,
    projectTreeCwd: '/Users/me/coworker',
    panelTree: null,
    panelTreeCwd: null,
  }),
  null
);

assert.equal(
  selectVisibleProjectTree({
    cwd: '/Users/me/coworker',
    projectTree: workspace,
    projectTreeCwd: '/Users/me/coworker',
    panelTree: images,
    panelTreeCwd: '/Users/me/.grok/sessions/x/images',
  }),
  workspace
);

console.log('project-tree-visibility tests passed');
