#!/usr/bin/env node
// Verifies the subagent detail-panel logic layer (persona naming, per-session
// registry derivation, and the transcript scope filter). UI wiring assertions
// are added as the panel/store pieces land.

import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();

// ── Source presence assertions ───────────────────────────────────────────────
const personaSrc = fs.readFileSync(path.join(root, 'src', 'ui', 'utils', 'subagent-persona.ts'), 'utf8');
assert.ok(
  personaSrc.includes('export function getSubagentPersona'),
  'subagent-persona must export getSubagentPersona'
);
assert.ok(
  personaSrc.includes('functionalName') && personaSrc.includes('persona') && personaSrc.includes('colorHue'),
  'persona must carry functionalName (primary) + persona/color (accent)'
);

const registrySrc = fs.readFileSync(path.join(root, 'src', 'ui', 'utils', 'subagent-registry.ts'), 'utf8');
assert.ok(
  registrySrc.includes('export function deriveSubagentSummaries'),
  'subagent-registry must export deriveSubagentSummaries'
);
assert.ok(
  registrySrc.includes('if (message.parentToolUseId) continue;'),
  'registry must list TOP-LEVEL subagents only (skip nested)'
);

const timelineSrc = fs.readFileSync(path.join(root, 'src', 'ui', 'utils', 'transcript-timeline.ts'), 'utf8');
assert.ok(
  timelineSrc.includes('subagentScopeId'),
  'deriveTranscriptTimelineItems must accept a subagentScopeId scope'
);
assert.ok(
  timelineSrc.includes('message.parentToolUseId !== options.subagentScopeId'),
  'scope must keep only the scoped subagent messages'
);

// ── UI wiring assertions ─────────────────────────────────────────────────────
const typesSrc = fs.readFileSync(path.join(root, 'src', 'ui', 'types.ts'), 'utf8');
assert.ok(
  /ProjectUtilityPanelKind =[^;]*'subagent'/.test(typesSrc),
  'types: subagent must be a ProjectUtilityPanelKind'
);
assert.ok(
  typesSrc.includes('openSubagentPanel') && typesSrc.includes('subagent:${string}'),
  'types: store must expose openSubagentPanel + per-subagent `subagent:<id>` tab targets'
);

const storeSrc = fs.readFileSync(path.join(root, 'src', 'ui', 'store', 'useAppStore.ts'), 'utf8');
assert.ok(
  storeSrc.includes('openSubagentPanel:') && storeSrc.includes('`subagent:${subagentId}`'),
  'store: openSubagentPanel must open/focus that subagent\'s own top-level tab (no wrapper tab)'
);

const panelSrc = fs.readFileSync(path.join(root, 'src', 'ui', 'components', 'SubagentPanel.tsx'), 'utf8');
assert.ok(
  panelSrc.includes('deriveSubagentSummaries') && panelSrc.includes('subagentScopeId'),
  'panel: must derive per-session subagents and render the scoped transcript'
);
assert.ok(
  panelSrc.includes('requestChatInjection') && !/(<PromptInput|composer.*subagent)/i.test(panelSrc),
  'panel: follow-up must inject a visible quote into the MAIN composer, not host a subagent composer'
);
assert.ok(
  panelSrc.includes('moved to the background'),
  'panel: must show an explicit frozen-state banner for backgrounded subagents'
);

const appSrc = fs.readFileSync(path.join(root, 'src', 'ui', 'App.tsx'), 'utf8');
assert.ok(
  appSrc.includes('<SubagentPanel') && appSrc.includes('subagentUtilityTabs.map'),
  'App: one SubagentPanel must mount per open subagent tab'
);
assert.ok(
  appSrc.includes('<SubagentAvatar') && appSrc.includes('getSubagentPersona'),
  'App: strip tabs must show the pixel avatar + persona short name'
);

const workstreamCmpSrc = fs.readFileSync(path.join(root, 'src', 'ui', 'components', 'AssistantWorkstream.tsx'), 'utf8');
assert.ok(
  workstreamCmpSrc.includes('openSubagentPanel(entry.block.id)'),
  'inline board: a lane must open the detail panel'
);

const envHubSrc = fs.readFileSync(path.join(root, 'src', 'ui', 'components', 'environment', 'EnvironmentHub.tsx'), 'utf8');
assert.ok(
  envHubSrc.includes('EnvironmentSubagentSection') && envHubSrc.includes('openSubagentPanel'),
  'env hub: must list subagents and open the panel on click'
);

// ── Behavioral tests (compiled + run) ────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-subagent-'));
const tscBin = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsc.cmd' : 'tsc'
);

const testFiles = [
  'scripts/tests/subagent-persona.test.ts',
  'scripts/tests/subagent-registry.test.ts',
  'scripts/tests/subagent-scope.test.ts',
];

try {
  const compile = spawnSync(
    tscBin,
    [
      '--target', 'ES2022',
      '--module', 'CommonJS',
      '--moduleResolution', 'Node',
      '--skipLibCheck',
      '--esModuleInterop',
      '--strict',
      '--outDir', tmpDir,
      ...testFiles,
    ],
    { cwd: root, stdio: 'inherit' }
  );
  assert.equal(compile.status, 0, 'subagent test compile failed');

  for (const testFile of testFiles) {
    const jsPath = path.join(tmpDir, testFile.replace(/\.ts$/, '.js'));
    const run = spawnSync(process.execPath, [jsPath], { cwd: root, stdio: 'inherit' });
    assert.equal(run.status, 0, `${testFile} failed`);
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log('verify-subagent-panel: OK');
