import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { SessionRightPanelLiveFields, SessionRightPanelSnapshot } from '../../src/ui/types';
import {
  captureLiveRightPanel,
  emptyRightPanelSnapshot,
  liveFieldsFromRightPanel,
  migrateRightPanelSessionId,
  persistRightPanelBySessionId,
  pruneRightPanelBySessionId,
  rightPanelSessionKey,
  switchSessionRightPanel,
  withFileTabsForUtilityTab,
} from '../../src/ui/utils/session-right-panel';

function live(partial: Partial<SessionRightPanelLiveFields> = {}): SessionRightPanelLiveFields {
  return {
    rightUtilityTabs: [],
    activeRightUtilityTab: null,
    rightUtilityPanelHidden: false,
    rightPanelFullscreen: null,
    projectTreeCollapsed: true,
    projectPanelView: 'files',
    browserPanelOpen: false,
    reviewDiffSelection: null,
    ...partial,
  };
}

function snapshot(partial: Partial<SessionRightPanelSnapshot> = {}): SessionRightPanelSnapshot {
  const next = {
    ...emptyRightPanelSnapshot(),
    ...partial,
  };
  if (partial.hidden === undefined && next.tabs.length > 0) {
    next.hidden = false;
  }
  return next;
}

function testSameCwdSessionsKeepIndependentPanels() {
  const sessions = { 'session-a': {}, 'session-b': {} };
  const sessionA = live({
    rightUtilityTabs: ['files:aaa', 'browser'],
    activeRightUtilityTab: 'files:aaa',
    projectTreeCollapsed: false,
  });
  const map = withFileTabsForUtilityTab(
    {
      [rightPanelSessionKey('session-a')]: snapshot({
        tabs: ['files:aaa', 'browser'],
        activeTab: 'files:aaa',
      }),
    },
    'session-a',
    'files:aaa',
    {
      files: [{ cwd: '/shared', filePath: '/shared/a.ts', name: 'a.ts', viewMode: 'code' }],
      activeFile: { cwd: '/shared', filePath: '/shared/a.ts' },
    },
    sessionA
  );

  const switchedToB = switchSessionRightPanel({
    prevSessionId: 'session-a',
    nextSessionId: 'session-b',
    live: sessionA,
    rightPanelBySessionId: map,
    sessions,
  });

  assert.deepEqual(switchedToB.rightUtilityTabs, [], 'session B must start with its own empty panel');
  assert.equal(switchedToB.activeRightUtilityTab, null);
  assert.equal(
    switchedToB.rightUtilityPanelHidden,
    true,
    'a session that never opened the right panel must not expand it'
  );
  assert.equal(switchedToB.rightPanelFullscreen, null);
  assert.equal(switchedToB.browserPanelOpen, false);
  assert.equal(
    switchedToB.rightPanelBySessionId['session-a']?.fileTabsByUtilityTab['files:aaa']?.files[0]?.filePath,
    '/shared/a.ts',
    'session A file tabs are stored, not shared via cwd'
  );

  const sessionB = live({
    rightUtilityTabs: ['browser'],
    activeRightUtilityTab: 'browser',
    browserPanelOpen: true,
  });
  const afterB = switchSessionRightPanel({
    prevSessionId: 'session-b',
    nextSessionId: 'session-a',
    live: sessionB,
    rightPanelBySessionId: {
      ...switchedToB.rightPanelBySessionId,
      'session-b': captureLiveRightPanel(sessionB, switchedToB.rightPanelBySessionId, 'session-b'),
    },
    sessions,
  });

  assert.deepEqual(afterB.rightUtilityTabs, ['files:aaa', 'browser']);
  assert.equal(afterB.activeRightUtilityTab, 'files:aaa');
  assert.equal(
    afterB.rightPanelBySessionId['session-a']?.fileTabsByUtilityTab['files:aaa']?.files[0]?.filePath,
    '/shared/a.ts'
  );
  assert.deepEqual(afterB.rightPanelBySessionId['session-b']?.tabs, ['browser']);
}

function testPersistStripsEphemeralTabs() {
  const persisted = persistRightPanelBySessionId({
    'session-a': snapshot({
      tabs: ['files:aaa', 'browser', 'side-chat:fork-1', 'subagent:tool-1'],
      activeTab: 'side-chat:fork-1',
      fileTabsByUtilityTab: {
        'files:aaa': {
          files: [{ cwd: '/shared', filePath: '/shared/a.ts' }],
          activeFile: { cwd: '/shared', filePath: '/shared/a.ts' },
        },
      },
    }),
  });

  assert.deepEqual(persisted['session-a']?.tabs, ['files:aaa', 'browser']);
  assert.equal(persisted['session-a']?.activeTab, 'files:aaa');
  assert.equal(persisted['session-a']?.reviewDiffSelection, null);
  assert.equal(
    persisted['session-a']?.fileTabsByUtilityTab['files:aaa']?.files[0]?.filePath,
    '/shared/a.ts'
  );
}

function testMigrateDraftKeepsOpenFiles() {
  const draftId = 'draft-1';
  const realId = 'session-real';
  const map = withFileTabsForUtilityTab(
    {
      [draftId]: snapshot({
        tabs: ['files:draft'],
        activeTab: 'files:draft',
      }),
    },
    draftId,
    'files:draft',
    {
      files: [{ cwd: '/shared', filePath: '/shared/notes.md' }],
      activeFile: { cwd: '/shared', filePath: '/shared/notes.md' },
    }
  );
  const migrated = migrateRightPanelSessionId(map, draftId, realId);
  assert.equal(migrated[draftId], undefined);
  assert.deepEqual(migrated[realId]?.tabs, ['files:draft']);
  assert.equal(
    migrated[realId]?.fileTabsByUtilityTab['files:draft']?.files[0]?.filePath,
    '/shared/notes.md'
  );
}

function testDeletedSessionIsPruned() {
  const map = {
    'session-a': snapshot({ tabs: ['browser'], activeTab: 'browser' }),
    'session-b': snapshot({ tabs: ['files:bbb'], activeTab: 'files:bbb' }),
  };
  const pruned = pruneRightPanelBySessionId(map, ['session-b']);
  assert.equal(pruned['session-a'], undefined);
  assert.ok(pruned['session-b']);
}

function testLiveFieldsFollowActiveTab() {
  const fields = liveFieldsFromRightPanel(
    snapshot({
      tabs: ['files:aaa', 'browser'],
      activeTab: 'browser',
    })
  );
  assert.equal(fields.browserPanelOpen, true);
  assert.equal(fields.projectTreeCollapsed, true);
  assert.equal(fields.rightUtilityPanelHidden, false);
}

function testEmptySessionKeepsPanelCollapsed() {
  const fields = liveFieldsFromRightPanel(emptyRightPanelSnapshot());
  assert.deepEqual(fields.rightUtilityTabs, []);
  assert.equal(fields.activeRightUtilityTab, null);
  assert.equal(fields.rightUtilityPanelHidden, true);
  assert.equal(fields.rightPanelFullscreen, null);
  assert.equal(fields.browserPanelOpen, false);
}

function main() {
  testSameCwdSessionsKeepIndependentPanels();
  testPersistStripsEphemeralTabs();
  testMigrateDraftKeepsOpenFiles();
  testDeletedSessionIsPruned();
  testLiveFieldsFollowActiveTab();
  testEmptySessionKeepsPanelCollapsed();
  void assertWiring();
}

async function assertWiring() {
  const [appSource, storeSource, treePanelSource] = await Promise.all([
    readFile(new URL('../../src/ui/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/ui/store/useAppStore.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../src/ui/components/ProjectTreePanel.tsx', import.meta.url), 'utf8'),
  ]);
  assert.match(
    appSource,
    /key=\{\`\$\{activeSessionId \?\? 'new'\}:\$\{tabId\}\`\}/,
    'Files and Browser panels must remount per session so the same cwd cannot share React state'
  );
  assert.match(storeSource, /switchSessionRightPanel\(/);
  assert.match(storeSource, /rightPanelBySessionId:/);
  assert.match(
    appSource,
    /setRightPanelLauncherOpen\(false\);\s*\}, \[activeSessionId\]\)/,
    'switching sessions must dismiss the right-panel launcher so an empty session stays collapsed'
  );
  assert.match(treePanelSource, /syncSessionFileTabs\(/);
  assert.match(
    treePanelSource,
    /prevTreeResetCwdRef[\s\S]{0,400}setExpandedPaths\(new Set\(\)\)/,
    'cwd changes may reset tree chrome but must not be the old wipe-all-files effect'
  );
  assert.doesNotMatch(
    treePanelSource,
    /if \(openRequest && openRequest\.cwd === cwd\) return;[\s\S]{0,400}updateOpenFileTabs\(\(\) => \[\]\)/,
    'Files panels must not wipe open tabs just because cwd is shared across sessions'
  );
  console.log('session-right-panel tests passed');
}

void main();
