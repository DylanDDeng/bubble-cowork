import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveRightUtilityTabOpen } from '../../src/ui/utils/right-utility-tabs';

async function main() {
  const first = resolveRightUtilityTabOpen([], 'files', { newTab: true });
  assert.equal(first.tabs.length, 1);
  assert.equal(first.activeTab, first.tabs[0]);
  assert.match(first.activeTab, /^files:/);

  const second = resolveRightUtilityTabOpen(first.tabs, 'files', { newTab: true });
  assert.equal(second.tabs.length, 2, 'Files from the plus menu must append another tab');
  assert.notEqual(second.activeTab, first.activeTab, 'the new Files tab must have its own identity');
  assert.equal(second.activeTab, second.tabs[1], 'the new Files tab must become active');

  const existing = resolveRightUtilityTabOpen(second.tabs, 'files');
  assert.deepEqual(existing.tabs, second.tabs, 'ordinary Files navigation should reuse a tab');
  assert.equal(existing.activeTab, first.activeTab);

  const appSource = await readFile(new URL('../../src/ui/App.tsx', import.meta.url), 'utf8');
  // Tabs must open via onSelect (click completion) so Base UI still closes
  // the popup itself. Firing on pointerdown reflows the tab strip mid-press,
  // the popup re-anchors, and the release no longer counts as an item click,
  // leaving the menu stuck open.
  assert.match(
    appSource,
    /onSelect=\{\(\) =>\s*onOpenTab\(/,
    'the plus menu must open tabs on select, not pointerdown'
  );
  assert.doesNotMatch(
    appSource,
    /onPointerDown=\{[\s\S]{0,200}?onOpenTab\(/,
    'opening tabs on pointerdown leaves the plus menu stuck open'
  );
  assert.match(
    appSource,
    /scrollIntoView\(\{ block: 'nearest', inline: 'nearest' \}\)/,
    'a newly active utility tab must be scrolled into view'
  );

  console.log('right-utility-tabs tests passed');
}

void main();
