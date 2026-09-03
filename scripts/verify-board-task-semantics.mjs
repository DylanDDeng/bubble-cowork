#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const [boardView, boardDetail, boardStore, boardTaskStart] = await Promise.all([
  readFile(new URL('src/ui/components/BoardView.tsx', root), 'utf8'),
  readFile(new URL('src/ui/components/BoardTaskDetail.tsx', root), 'utf8'),
  readFile(new URL('src/ui/store/useBoardStore.ts', root), 'utf8'),
  readFile(new URL('src/ui/utils/board-task-start.ts', root), 'utf8'),
]);

const startTask = boardView.match(
  /const startTask = async[\s\S]+?(?=\n\s*\/\/ Send a follow-up prompt)/
)?.[0];
assert.ok(startTask, 'BoardView must define the direct task start flow');
assert.match(
  startTask,
  /createBoardTaskStartPayload/,
  'starting a Board task must use the guarded payload builder'
);
assert.match(boardTaskStart, /prompt: title/, 'the Board title must become the agent prompt');
assert.doesNotMatch(boardTaskStart, /task\.description/, 'description must stay out of the payload');

const taskShape = boardStore.match(/export interface BoardTask \{[\s\S]+?\n\}/)?.[0];
assert.ok(taskShape, 'BoardTask interface must remain inspectable');
assert.match(taskShape, /description: string;/, 'BoardTask must store description independently');
assert.doesNotMatch(taskShape, /\bprompt: string;/, 'BoardTask must not overload description as prompt');
assert.match(boardStore, /version: 6/, 'the Board persistence version must migrate legacy tasks');
assert.match(
  boardStore,
  /description: legacyTask\.description \?\? legacyPrompt \?\? ''/,
  'legacy task prompts must survive as Board descriptions'
);
assert.match(
  boardStore,
  /preferSessionOwner\(task, currentOwner\)/,
  'migration must collapse duplicate cards created by the session attach race'
);
assert.match(
  boardStore,
  /delete tasks\[otherTaskId\]/,
  'attaching a session must remove its transient auto-materialized card'
);

assert.match(
  boardDetail,
  /\{task\.description\}/,
  'the detail page must render the stored description'
);
assert.doesNotMatch(
  boardDetail,
  /hasDistinctDescription|firstRunPrompt/,
  'the detail page must not hide a description that matches Activity'
);
assert.match(
  boardView,
  /not sent to (?:the )?agent/,
  'the composer must explain that description is Board-only metadata'
);

console.log('board task semantics verification passed');
