#!/usr/bin/env node
// Verifies the composer model/permission pickers can open downward and that the
// centered new-thread surfaces request it, while the bottom chat composer keeps
// the default upward direction.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// 1. Each permission picker supports menuSide and has BOTH directional classes.
for (const file of [
  'src/ui/components/ClaudePermissionModePicker.tsx',
  'src/ui/components/CodexPermissionModePicker.tsx',
  'src/ui/components/KimiPermissionModePicker.tsx',
]) {
  const src = read(file);
  assert.ok(/menuSide\??:\s*'top'\s*\|\s*'bottom'/.test(src), `${file}: missing menuSide prop`);
  assert.ok(src.includes("menuSide = 'top'"), `${file}: menuSide should default to 'top'`);
  assert.ok(src.includes("'top-full mt-2'"), `${file}: missing downward (top-full mt-2) class`);
  assert.ok(src.includes("'bottom-full mb-2'"), `${file}: missing upward (bottom-full mb-2) class`);
}

// 2. The merged agent/model picker uses the prop instead of a hardcoded side.
const controls = read('src/ui/components/ComposerAgentControls.tsx');
assert.ok(
  /menuSide\??:\s*'top'\s*\|\s*'bottom'/.test(controls),
  'ComposerAgentControls: ComposerAgentModelPicker missing menuSide prop'
);
assert.ok(controls.includes('side={menuSide}'), 'ComposerAgentControls: should pass side={menuSide}');

// 3. PromptInput threads menuSide through to all four pickers and defaults to top.
const prompt = read('src/ui/components/PromptInput.tsx');
assert.ok(prompt.includes("menuSide = 'top'"), 'PromptInput: menuSide should default to top');
assert.equal(
  (prompt.match(/menuSide=\{menuSide\}/g) || []).length,
  4,
  'PromptInput: all four pickers should receive menuSide={menuSide}'
);

// 4. The centered new-thread landing (NewSessionView) opens every picker downward.
const newSession = read('src/ui/components/NewSessionView.tsx');
assert.equal(
  (newSession.match(/menuSide="bottom"/g) || []).length,
  4,
  'NewSessionView: all four pickers should pass menuSide="bottom"'
);

// 5. The empty-draft landing in ChatPane opens the composer downward, while the
//    bottom chat composers keep the default (no menuSide).
const chatPane = read('src/ui/components/ChatPane.tsx');
assert.ok(
  chatPane.includes('<PromptInput sessionId={sessionId} menuSide="bottom" />'),
  'ChatPane: the centered NewThreadLanding composer should pass menuSide="bottom"'
);
assert.ok(
  chatPane.includes('<PromptInput sessionId={sessionId} />'),
  'ChatPane: the bottom chat composer should keep the default upward direction'
);

console.log('picker-menu-side: all checks passed');
