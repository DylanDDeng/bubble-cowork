import assert from 'node:assert/strict';
import { createBoardTaskStartPayload } from '../../src/ui/utils/board-task-start';
import { useBoardStore, type BoardTask } from '../../src/ui/store/useBoardStore';

const task: BoardTask = {
  id: 'board-test',
  title: '  inspect this project  ',
  description: 'private board notes that must not be sent',
  projectCwd: '/tmp/example-project',
  sessionConfig: {
    provider: 'codex',
    model: 'gpt-5.6-sol',
    codexPermissionMode: 'defaultPermissions',
  },
  stage: 'todo',
  sessionIds: [],
  createdAt: 1,
  updatedAt: 1,
  unread: false,
  events: [{ type: 'created', at: 1 }],
};

const payload = createBoardTaskStartPayload(task, 'workspace');

assert.equal(payload.title, 'inspect this project');
assert.equal(payload.prompt, 'inspect this project');
assert.equal(payload.projectCwd, '/tmp/example-project');
assert.equal(payload.channelId, 'workspace');
assert.equal(payload.provider, 'codex');
assert.equal('description' in payload, false, 'Board description must not enter the session payload');
assert.equal(payload.attachments, undefined, 'legacy tasks without attachments still start');
const image = { id: 'reference', kind: 'image' as const, name: 'reference.png', path: '/tmp/reference.png', mimeType: 'image/png', size: 100 };
assert.deepEqual(createBoardTaskStartPayload({ ...task, attachments: [image] }, 'workspace').attachments, [image]);

useBoardStore.setState({ tasks: {}, selectedTaskId: null });
const explicitTaskId = useBoardStore.getState().addTask({
  title: 'inspect this project',
  description: 'keep this on the Board',
  attachments: [image],
});
const transientTaskId = useBoardStore.getState().addTask({
  title: 'inspect this project',
  sessionId: 'session-race',
});
useBoardStore.getState().setSelectedTask(transientTaskId);
useBoardStore.getState().attachSession(explicitTaskId, 'session-race');

const attachedState = useBoardStore.getState();
assert.equal(attachedState.tasks[explicitTaskId]?.description, 'keep this on the Board');
assert.deepEqual(attachedState.tasks[explicitTaskId]?.attachments, [image], 'binding a real session preserves the task references');
assert.equal(attachedState.tasks[explicitTaskId]?.sessionIds[0], 'session-race');
assert.equal(attachedState.tasks[transientTaskId], undefined, 'transient duplicate must be removed');
assert.equal(attachedState.selectedTaskId, explicitTaskId, 'selection must follow the surviving task');

attachedState.updateTask(explicitTaskId, { description: '' });
assert.equal(
  useBoardStore.getState().tasks[explicitTaskId]?.description,
  '',
  'description must remain independently editable and clearable'
);
attachedState.updateTask(explicitTaskId, { attachments: [] });
assert.deepEqual(useBoardStore.getState().tasks[explicitTaskId]?.attachments, [], 'removing all references stays saved');

// Referencing earlier work must not transfer its session ownership or workspace.
const sourceSessionId = 'af98b1a1-65ef-4ca9-8a3d-a6562939f0cc';
const sourceTaskId = useBoardStore.getState().addTask({
  title: 'Earlier work', sessionId: sourceSessionId, projectCwd: '/tmp/old-project', stage: 'done',
});
const nextTaskId = useBoardStore.getState().addTask({
  title: 'Build on the result', sourceSessionId, projectCwd: '/tmp/new-project',
  description: 'Do not send these notes', sessionConfig: { provider: 'codex' },
});
const referenced = useBoardStore.getState().tasks[nextTaskId];
const nextPayload = createBoardTaskStartPayload(referenced, 'workspace');
assert.equal(nextPayload.title, 'Build on the result');
assert.match(nextPayload.prompt, new RegExp(`aegis://sessions/${sourceSessionId}`));
assert.equal(nextPayload.prompt.includes('Do not send these notes'), false);
assert.equal(nextPayload.cwd, '/tmp/new-project');
assert.equal(nextPayload.worktreePath, undefined);
assert.deepEqual(referenced.sessionIds, [], 'a source reference is not an owned session');
useBoardStore.getState().attachSession(nextTaskId, 'new-session');
assert.deepEqual(useBoardStore.getState().tasks[sourceTaskId].sessionIds, [sourceSessionId]);
assert.equal(useBoardStore.getState().tasks[sourceTaskId].stage, 'done');
assert.equal(useBoardStore.getState().tasks[nextTaskId].sourceSessionId, sourceSessionId);
useBoardStore.getState().removeTask(nextTaskId);
assert.ok(useBoardStore.getState().tasks[sourceTaskId], 'removing the new card keeps the source');

console.log('board task start payload tests passed');
