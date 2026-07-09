#!/usr/bin/env node
// Wiring checks for the Claude /rewind feature: SDK checkpointing must be on,
// the live query must be reachable through RunnerHandle, the IPC contract must
// exist end to end, and the UI entry points (message action + /rewind slash)
// must be hooked up.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// ── Runner / main process ────────────────────────────────────────────────────

const runner = read('src/electron/libs/runner.ts');
assert.ok(
  runner.includes('enableFileCheckpointing: true'),
  'runner must enable SDK file checkpointing so rewindFiles has snapshots'
);
assert.ok(
  runner.includes('rewindFiles: async (userMessageId, options)') &&
    runner.includes('activeQuery.rewindFiles(userMessageId'),
  'RunnerHandle must expose rewindFiles closing over the live query'
);

assert.ok(
  runner.includes("uuid: uuidv4() as SDKUserMessage['uuid']") &&
    runner.includes('uuid: message.uuid as string'),
  'runner must mint the user message uuid and echo it on the stream (the SDK never echoes streaming-input prompts, and rewind anchors on that uuid)'
);

const electronTypes = read('src/electron/types.ts');
assert.ok(
  electronTypes.includes('rewindFiles?:') && electronTypes.includes('RewindFilesResult'),
  'RunnerHandle type must declare the optional rewindFiles method'
);

const ipc = read('src/electron/ipc-handlers.ts');
assert.ok(ipc.includes("ipcMainHandle('claude-rewind'"), 'claude-rewind IPC handler must exist');
assert.ok(
  ipc.includes('runnerHandles.get(sessionId)') &&
    /claude-rewind[\s\S]*?bootstrapClaudeSessionFromHistory/.test(ipc),
  'claude-rewind must reach the live handle and reuse the history bootstrap for conversation rewind'
);
assert.ok(
  /claude-rewind[\s\S]*?replaceSessionHistory/.test(ipc),
  'conversation rewind must truncate the stored history'
);

const preload = read('src/electron/preload.cts');
assert.ok(preload.includes("ipcRenderer.invoke('claude-rewind'"), 'preload must bind claudeRewind');

const rendererTypes = read('src/types.d.ts');
assert.ok(rendererTypes.includes('claudeRewind:'), 'ElectronAPI must declare claudeRewind');

const shared = read('src/shared/types.ts');
assert.ok(
  shared.includes('ClaudeRewindScope') && shared.includes('ClaudeRewindResult'),
  'shared types must define the rewind IPC contract'
);

// ── UI wiring ────────────────────────────────────────────────────────────────

const dialog = read('src/ui/components/ClaudeRewindDialog.tsx');
assert.ok(
  dialog.includes("scope: 'files'") && dialog.includes('dryRun: true'),
  'the dialog must preview file impact with a dry run before executing'
);
assert.ok(
  dialog.includes("'conversation'") && dialog.includes("'both'"),
  'the dialog must offer conversation/files/both scopes'
);

const chatPane = read('src/ui/components/ChatPane.tsx');
assert.ok(
  chatPane.includes('resolveRewindTarget') && chatPane.includes('<ClaudeRewindDialog'),
  'ChatPane must resolve the SDK user-message anchor and render the dialog'
);
assert.ok(
  chatPane.includes("addEventListener('aegis-claude-rewind-open'"),
  'ChatPane must listen for the /rewind composer command'
);

const messageCard = read('src/ui/components/MessageCard.tsx');
assert.ok(
  messageCard.includes('onRewind?:') && messageCard.includes('actions.onRewind?.()'),
  'user prompt cards must expose the rewind action'
);

const promptInput = read('src/ui/components/PromptInput.tsx');
assert.ok(
  promptInput.includes("prompt.trim().toLowerCase() === '/rewind'") &&
    promptInput.includes("CustomEvent('aegis-claude-rewind-open'"),
  'the composer must intercept /rewind locally (case-insensitively) instead of sending it to the model'
);
assert.ok(
  promptInput.includes("addEventListener('aegis-composer-set-prompt'"),
  'the composer must accept the rewound-away prompt back'
);

const slash = read('src/ui/utils/claude-slash.ts');
assert.ok(slash.includes("title: '/rewind'"), '/rewind must appear in the Claude slash menu');
assert.ok(
  slash.includes('LOCAL_CLAUDE_UI_COMMANDS') &&
    (
      /withLocalClaudeUiCommands\(buildClaudeSlashCommands\(sessionCommands\)\)/.test(slash) ||
      /provider === 'claude' \? withLocalClaudeUiCommands/.test(slash) ||
      /if \(provider === 'claude'\)[\s\S]*withLocalClaudeUiCommands\(commands\)/.test(slash)
    ),
  '/rewind must be merged even when the session reports its own command list'
);

console.log('verify-claude-rewind: OK');
