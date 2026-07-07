#!/usr/bin/env node
// Verifies the Environment hub card stays anchored to its trigger icon.
//
// The card used to be position:fixed against the window's right edge
// (fixed right-3 top-11). With the right utility panel open, the chat
// header — and the Environment icon in it — moves left, but a
// viewport-fixed card kept rendering at the far right of the window,
// under the utility panel's controls. Anchoring the card absolutely
// inside the trigger's position:relative wrapper keeps it under the
// icon no matter how the surrounding layout shifts.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const hub = read('src/ui/components/environment/EnvironmentHub.tsx');

// 1. The trigger button and card share a position:relative wrapper.
assert.ok(
  /<div className="relative">/.test(hub),
  'EnvironmentHub: trigger wrapper must be position:relative so the card can anchor to it'
);

// 2. The card is absolutely positioned against that wrapper, directly
//    below the trigger and aligned to its right edge.
const panelClass = hub.match(/className="no-drag ([^"]*)w-\[318px\][^"]*"/);
assert.ok(panelClass, 'EnvironmentHub: could not locate the card container className');
assert.ok(
  panelClass[1].includes('absolute'),
  'EnvironmentHub: the card must use absolute positioning (anchored to the trigger wrapper)'
);
assert.ok(
  panelClass[1].includes('right-0') && panelClass[1].includes('top-full'),
  'EnvironmentHub: the card must open below the trigger (top-full) aligned to its right edge (right-0)'
);

// 3. No viewport-fixed placement anywhere in the card: `fixed` drifts away
//    from the icon whenever the right utility panel resizes the chat pane.
assert.ok(
  !/className="no-drag fixed/.test(hub),
  'EnvironmentHub: the card must not be position:fixed to the viewport'
);

console.log('environment-hub-anchor: all checks passed');
