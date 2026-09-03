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

useBoardStore.setState({ tasks: {}, selectedTaskId: null });
const explicitTaskId = useBoardStore.getState().addTask({
  title: 'inspect this project',
  description: 'keep this on the Board',
});
const transientTaskId = useBoardStore.getState().addTask({
  title: 'inspect this project',
  sessionId: 'session-race',
});
useBoardStore.getState().setSelectedTask(transientTaskId);
useBoardStore.getState().attachSession(explicitTaskId, 'session-race');

const attachedState = useBoardStore.getState();
assert.equal(attachedState.tasks[explicitTaskId]?.description, 'keep this on the Board');
assert.equal(attachedState.tasks[explicitTaskId]?.sessionIds[0], 'session-race');
assert.equal(attachedState.tasks[transientTaskId], undefined, 'transient duplicate must be removed');
assert.equal(attachedState.selectedTaskId, explicitTaskId, 'selection must follow the surviving task');

attachedState.updateTask(explicitTaskId, { description: '' });
assert.equal(
  useBoardStore.getState().tasks[explicitTaskId]?.description,
  '',
  'description must remain independently editable and clearable'
);

console.log('board task start payload tests passed');
