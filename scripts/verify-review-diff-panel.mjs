#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function expectIncludes(source, needle, message) {
  assert.ok(source.includes(needle), message);
}

function expectNotIncludes(source, needle, message) {
  assert.equal(source.includes(needle), false, message);
}

function expectMatches(source, pattern, message) {
  assert.ok(pattern.test(source), message);
}

const selection = read('src/ui/utils/review-diff-selection.ts');
const dataHook = read('src/ui/hooks/useAegisDiffPanelData.ts');
const panel = read('src/ui/components/AegisDiffPanel.tsx');
const chatPane = read('src/ui/components/ChatPane.tsx');
const turnCard = read('src/ui/components/TurnChangesCard.tsx');
const app = read('src/ui/App.tsx');

expectIncludes(selection, 'WORKSPACE_DIFF_SCOPES', 'review diff scopes must be defined in a shared util');
expectIncludes(selection, 'getTurnDiffKey', 'turn diff keys must come from a shared util');
expectIncludes(selection, 'getTurnDiffLabel', 'turn diff labels must come from a shared util');
expectIncludes(selection, 'buildReviewTurnSelection', 'turn selection builder must be shared');
expectIncludes(selection, 'buildWorkspaceReviewSelection', 'workspace selection builder must be shared');

expectIncludes(panel, '<DropdownMenuLabel>Workspace</DropdownMenuLabel>', 'selector menu must group workspace sources');
expectIncludes(panel, '<DropdownMenuLabel>Turns</DropdownMenuLabel>', 'selector menu must group turn sources');
expectIncludes(panel, 'isWorkspaceSelection(data.selection, entry.scope)', 'workspace source must show selected state');
expectIncludes(panel, 'isTurnSelection(data.selection, entry.key)', 'turn source must show selected state');
expectIncludes(panel, 'No files match filter', 'filtered empty state must not look like no changes');
expectNotIncludes(panel, 'Show all', 'review panel must not expose a show-all source');

expectIncludes(dataHook, 'inFlightWorkspaceKeyRef', 'workspace diff loading must dedupe in-flight requests');
expectIncludes(dataHook, 'cacheKey', 'workspace diff data must be cached by cwd and scope');
expectIncludes(dataHook, 'liveTurn?.summary.records || getTurnRecords(effectiveSelection)', 'turn diff must prefer live turn records and fall back to the selection snapshot');
expectIncludes(dataHook, "window.electron.getGitPatch(cwd, workspaceScope)", 'only workspace selections should call git patch IPC');
expectNotIncludes(dataHook, 'getGitPatch(cwd, effectiveSelection.source.scope)', 'workspace IPC must not depend on the full selection object');

expectIncludes(chatPane, 'buildReviewTurnSelection(turn, sessionId, record)', 'chat file change clicks must open the whole owning turn');
expectIncludes(chatPane, 'turns.find((entry) => entry.records.some((candidate) => candidate.id === record.id))', 'chat diff open must locate the owning turn');
expectNotIncludes(chatPane, "label: scope?.label || 'Selected turn'", 'fallback label must not imply an unknown selected turn');

expectIncludes(turnCard, 'getTurnDiffKey(summary)', 'turn change card must use the shared turn key');
expectIncludes(turnCard, 'getTurnDiffLabel(summary)', 'turn change card must use the shared turn label');

expectMatches(
  app,
  /<RightUtilityWorkspace[\s\S]*width=\{rightUtilityPanelWidth\}[\s\S]*<AegisDiffPanel/,
  'review panel must stay inside the shared right utility workspace'
);
expectMatches(
  app,
  /<ProjectTreePanel[\s\S]*sharedPanelWidth=\{rightUtilityPanelWidth\}/,
  'files panel must use the shared right panel width'
);
expectMatches(
  app,
  /<BrowserPanel[\s\S]*width=\{rightUtilityPanelWidth\}/,
  'browser panel must use the shared right panel width'
);
expectMatches(
  app,
  /<RightTerminalPanel[\s\S]*width=\{rightUtilityPanelWidth\}/,
  'terminal panel must use the shared right panel width'
);

console.log('review diff panel verification passed');
