import assert from 'node:assert/strict';
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_VERSION,
  restorePersistedSidebarWidth,
  sanitizeSidebarWidth,
} from '../../src/ui/utils/sidebar-width';

assert.equal(DEFAULT_SIDEBAR_WIDTH, 255, 'sidebar should default to the compact width');
assert.equal(restorePersistedSidebarWidth(undefined, undefined), 255, 'missing width should use the default');
assert.equal(restorePersistedSidebarWidth(343, undefined), 255, 'legacy saved width should migrate once');
assert.equal(
  restorePersistedSidebarWidth(300, SIDEBAR_WIDTH_VERSION),
  300,
  'current-version custom width should be preserved'
);
assert.equal(sanitizeSidebarWidth(100), MIN_SIDEBAR_WIDTH, 'width should respect the minimum');
assert.equal(sanitizeSidebarWidth(500), MAX_SIDEBAR_WIDTH, 'width should respect the maximum');

console.log('sidebar-width: all unit tests passed');
