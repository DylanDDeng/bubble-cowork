import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveRightUtilityTabOpen } from '../../src/ui/utils/right-utility-tabs';
import { resolveDockedRightPanelWidth } from '../../src/ui/utils/right-panel-width';

async function main() {
  assert.equal(
    resolveDockedRightPanelWidth(820, 560),
    324,
    'a desktop-sized panel must remain docked at the right of the minimum window'
  );
  assert.equal(
    resolveDockedRightPanelWidth(820, 692),
    401,
    'compact windows must preserve a visible conversation pane'
  );
  assert.equal(
    resolveDockedRightPanelWidth(820, 1600),
    820,
    'wide windows must preserve the saved panel width'
  );

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
  assert.match(
    appSource,
    /onOpenChange=\{onNativeOverlayChange\}/,
    'the plus menu must suspend the native browser view while open'
  );
  assert.match(
    appSource,
    /useBrowserNativeOverlayRegistration\(nativeOverlayOpen\)/,
    'the plus menu must register with the shared native-view overlay manager'
  );
  assert.match(
    appSource,
    /BrowserNativeOverlayContext\.Provider value=\{browserNativeOverlayContextValue\}/,
    'app-level overlays must publish shared native-view visibility to BrowserPanel'
  );

  const panelSource = await readFile(
    new URL('../../src/ui/components/browser/BrowserPanel.tsx', import.meta.url),
    'utf8'
  );
  assert.match(
    panelSource,
    /nativeViewHidden = collapsed \|\| overlayOpen/,
    'BrowserPanel must hide the WebContentsView while an HTML overlay is open'
  );
  assert.match(
    panelSource,
    /useLayoutEffect\(\(\) => \{\s*if \(!nativeViewHidden\) return/,
    'collapsing a browser tab must detach the native view before the next paint'
  );

  const attachmentPreviewSource = await readFile(
    new URL('../../src/ui/components/AttachmentPreviewGrid.tsx', import.meta.url),
    'utf8'
  );
  assert.match(
    attachmentPreviewSource,
    /useBrowserNativeOverlayRegistration\(lightboxOpen\)/,
    'the attachment lightbox must hide the native browser view while open'
  );

  console.log('right-utility-tabs tests passed');
}

void main();
