import assert from 'node:assert/strict';
import type { GitChangeEntry, ProjectTreeNode } from '../../src/shared/types';
import {
  DEFAULT_PROJECT_STARTER_PROMPTS,
  deriveProjectStarterPrompts,
} from '../../src/ui/utils/project-starter-prompts';

const tree: ProjectTreeNode = {
  name: 'coworker',
  path: '/repo/coworker',
  kind: 'dir',
  children: [
    { name: 'AGENTS.md', path: '/repo/coworker/AGENTS.md', kind: 'file' },
    { name: 'package.json', path: '/repo/coworker/package.json', kind: 'file' },
    { name: 'vite.config.ts', path: '/repo/coworker/vite.config.ts', kind: 'file' },
    {
      name: 'src',
      path: '/repo/coworker/src',
      kind: 'dir',
      children: [
        {
          name: 'electron',
          path: '/repo/coworker/src/electron',
          kind: 'dir',
          children: [{ name: 'main.ts', path: '/repo/coworker/src/electron/main.ts', kind: 'file' }],
        },
        {
          name: 'ui',
          path: '/repo/coworker/src/ui',
          kind: 'dir',
          children: [{ name: 'App.tsx', path: '/repo/coworker/src/ui/App.tsx', kind: 'file' }],
        },
      ],
    },
    {
      name: 'tests',
      path: '/repo/coworker/tests',
      kind: 'dir',
      children: [{ name: 'app.test.ts', path: '/repo/coworker/tests/app.test.ts', kind: 'file' }],
    },
  ],
};

const gitChanges: GitChangeEntry[] = [
  { filePath: 'src/ui/App.tsx', status: 'M', staged: false },
  { filePath: 'src/ui/PromptInput.tsx', status: 'M', staged: false },
];

const prompts = deriveProjectStarterPrompts({ tree, gitChanges });
assert.equal(prompts.length, 4);
assert.match(prompts[0], /Electron and React project architecture/);
assert.equal(prompts[1], 'Review the current changes in src and identify likely regressions');
assert.equal(prompts[2], 'Find the most important untested workflow and add coverage');
assert.equal(prompts[3], 'Compare the implementation with AGENTS.md and flag the most important gap');

assert.deepEqual(
  deriveProjectStarterPrompts({ tree: null, gitChanges: [] }),
  DEFAULT_PROJECT_STARTER_PROMPTS,
  'missing project signals should return the instant generic fallback'
);

console.log('project-starter-prompts: all unit tests passed');
