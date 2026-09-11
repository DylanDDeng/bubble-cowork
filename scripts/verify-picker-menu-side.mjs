#!/usr/bin/env node
// All bottom-anchored composers open upward. Reusable controls still accept
// either direction and portal their menus outside the composer surface.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// 1. The unified permission picker (one component, per-provider mode maps)
//    supports menuSide and positions its portal accordingly.
{
  const file = 'src/ui/components/PermissionModePicker.tsx';
  const src = read(file);
  assert.ok(/menuSide\??:\s*'top'\s*\|\s*'bottom'/.test(src), `${file}: missing menuSide prop`);
  assert.ok(src.includes("menuSide = 'top'"), `${file}: menuSide should default to 'top'`);
  assert.ok(src.includes('side={menuSide}') && src.includes('<DropdownMenu.Portal>'), `${file}: menus must be portaled and honor their requested side`);
  assert.ok(!src.includes('Chevron'), `${file}: permission trigger should not show a dropdown arrow`);
  assert.ok(
    src.includes('text-[var(--text-muted)] hover:text-[var(--text-secondary)]'),
    `${file}: non-full-access modes should use muted trigger text`
  );
  assert.ok(
    src.includes('hover:bg-[var(--bg-tertiary)]'),
    `${file}: permission trigger should show a subtle hover background`
  );
  assert.ok(src.includes('rounded-lg'), `${file}: permission hover background should have rounded corners`);
}

// 2. The merged agent/model picker uses the prop instead of a hardcoded side.
const controls = read('src/ui/components/ComposerAgentControls.tsx');
assert.ok(
  /menuSide\??:\s*'top'\s*\|\s*'bottom'/.test(controls),
  'ComposerAgentControls: ComposerAgentModelPicker missing menuSide prop'
);
assert.ok(controls.includes('side={menuSide}'), 'ComposerAgentControls: should pass side={menuSide}');

// 3. PromptInput threads menuSide through to the model, preset and permission
//    pickers, and defaults to top.
const prompt = read('src/ui/components/PromptInput.tsx');
assert.ok(prompt.includes("menuSide = 'top'"), 'PromptInput: menuSide should default to top');
assert.equal(
  (prompt.match(/menuSide=\{menuSide\}/g) || []).length,
  9,
  'PromptInput: model, preset and permission pickers should receive menuSide={menuSide}'
);
// PromptInput supports a 'landing' surface that wraps the input in a gray tray
// and renders the context-pill footer inside it.
assert.ok(
  /composerSurface\??:\s*'chat'\s*\|\s*'landing'/.test(prompt),
  'PromptInput: must support a composerSurface prop'
);
assert.ok(
  prompt.includes('aegis-new-thread-composer-tray') && prompt.includes('isLandingSurface'),
  'PromptInput: landing surface must apply the gray tray background'
);
assert.ok(
  prompt.includes('footer && isLandingSurface'),
  'PromptInput: the footer (context pills) must render inside the landing tray'
);

// 4. The bottom-anchored new-thread landing (NewSessionView) opens every picker upward.
const newSession = read('src/ui/components/NewSessionView.tsx');
assert.equal(
  (newSession.match(/menuSide="top"/g) || []).length,
  9,
  'NewSessionView: model, preset and permission pickers should pass menuSide="top"'
);

// 5. The empty-draft landing in ChatPane opens the composer upward, while the
//    bottom chat composers keep the default (no menuSide).
const chatPane = read('src/ui/components/ChatPane.tsx');
assert.ok(
  /composerSurface="landing"/.test(chatPane) && /menuSide="top"/.test(chatPane),
  'ChatPane: the bottom-anchored NewThreadLanding composer should open upward (landing surface)'
);
assert.ok(
  chatPane.includes('<PromptInput sessionId={sessionId} />'),
  'ChatPane: the bottom chat composer should keep the default upward direction'
);

console.log('picker-menu-side: all checks passed');
