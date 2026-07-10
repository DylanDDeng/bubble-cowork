import assert from 'node:assert/strict';
import {
  isTextLikeForOpenWith,
  rankOpenWithAppPaths,
} from '../../src/electron/libs/open-with-ranking.ts';

function testEditorsOutrankExtensionCollisions() {
  // Real-world .ts case: Qt Linguist claims the extension (Qt translation
  // sources are .ts) and wins the Launch Services default slot, but it cannot
  // open plain text; the actual editors can.
  const ranked = rankOpenWithAppPaths({
    fileApps: [
      '/Applications/anaconda3/bin/Linguist.app', // LS default
      '/Applications/Warp.app',
      '/Applications/Cursor.app',
      '/Applications/Zed.app',
    ],
    textApps: [
      '/Applications/Warp.app',
      '/Applications/Cursor.app',
      '/Applications/Zed.app',
      '/Applications/Visual Studio Code.app',
      '/System/Applications/TextEdit.app',
    ],
    limit: 8,
  });

  assert.deepEqual(ranked, [
    '/Applications/Warp.app',
    '/Applications/Cursor.app',
    '/Applications/Zed.app',
    '/Applications/Visual Studio Code.app',
    '/System/Applications/TextEdit.app',
    '/Applications/anaconda3/bin/Linguist.app',
  ]);
}

function testDuplicateInstallsCollapseByName() {
  const ranked = rankOpenWithAppPaths({
    fileApps: [
      '/Applications/anaconda3/bin/Linguist.app',
      '/Users/Shared/Previously Relocated Items/Security/anaconda3/bin/Linguist.app',
      '/Applications/Cursor.app',
    ],
    textApps: ['/Applications/Cursor.app'],
    limit: 8,
  });
  assert.deepEqual(ranked, [
    '/Applications/Cursor.app',
    '/Applications/anaconda3/bin/Linguist.app',
  ]);
}

function testHiddenDirectoryBundlesAreDropped() {
  const ranked = rankOpenWithAppPaths({
    fileApps: [],
    textApps: [
      '/Users/me/.cache/codex-runtimes/deps/LibreOfficeDev.app',
      '/Applications/Zed.app',
    ],
    limit: 8,
  });
  assert.deepEqual(ranked, ['/Applications/Zed.app']);
}

function testBinaryFilesKeepLaunchServicesOrder() {
  // No text probe for binaries: original LS order (default first) unchanged.
  const ranked = rankOpenWithAppPaths({
    fileApps: ['/System/Applications/Preview.app', '/Applications/Pixelmator Pro.app'],
    textApps: [],
    limit: 8,
  });
  assert.deepEqual(ranked, [
    '/System/Applications/Preview.app',
    '/Applications/Pixelmator Pro.app',
  ]);
}

function testLimitApplies() {
  const textApps = Array.from({ length: 20 }, (_, i) => `/Applications/Editor${i}.app`);
  const ranked = rankOpenWithAppPaths({ fileApps: [], textApps, limit: 8 });
  assert.equal(ranked.length, 8);
}

function testTextLikeDetection() {
  assert.equal(isTextLikeForOpenWith('/repo/src/worktree-threads.ts'), true);
  assert.equal(isTextLikeForOpenWith('/repo/Makefile'), true);
  assert.equal(isTextLikeForOpenWith('/repo/.gitignore'), true);
  assert.equal(isTextLikeForOpenWith('/repo/logo.png'), false);
  assert.equal(isTextLikeForOpenWith('/repo/demo.mp4'), false);
  assert.equal(isTextLikeForOpenWith('/repo/report.pdf'), false);
}

testEditorsOutrankExtensionCollisions();
testDuplicateInstallsCollapseByName();
testHiddenDirectoryBundlesAreDropped();
testBinaryFilesKeepLaunchServicesOrder();
testLimitApplies();
testTextLikeDetection();
console.log('open-with-ranking.test.ts: ok');
