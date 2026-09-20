const { CodexAppServerManager } = require('../../dist-electron/electron/libs/provider/codex-app-server-manager');
const { CodexAdapter } = require('../../dist-electron/electron/libs/provider/codex-adapter');

exports.editTraceFixture = function () {
  const manager = new CodexAppServerManager('/nonexistent-edit-test');
  manager.generation = 1;
  manager.sessions.set('edit-test', { threadId: 'edit-test', providerThreadId: 'native', generation: 1, cwd: '/tmp', status: 'ready' });
  const adapter = new CodexAdapter('/nonexistent-edit-test', { managerFactory: () => manager });
  adapter.runtimeManagers.set('edit-test', manager);
  adapter.setupEventForwarding(manager, 'edit-test');
  const messages = [{ type: 'user_prompt', prompt: 'Edit the fixtures' }];
  adapter.events.on('event', event => { if (event.type === 'message') messages.push(event.message); });
  const notify = (method, item) => manager.handleNotification({ method, params: { threadId: 'native', item } });
  const change = { path: '/project/src/example.ts', kind: { type: 'update', movePath: null }, diff: '@@ -29,2 +29,2 @@\n export interface ChildOperation {\n-  id: string;\n+  id: string; toolName: string;\n' };
  notify('item/started', { id: 'edit-one', type: 'fileChange', status: 'inProgress', changes: [change] });
  notify('item/completed', { id: 'edit-one', type: 'fileChange', status: 'completed', changes: [change] });
  // Completion-only details must survive start deduplication.
  notify('item/started', { id: 'edit-two', type: 'fileChange', status: 'inProgress', changes: [] });
  notify('item/completed', { id: 'edit-two', type: 'fileChange', status: 'completed', changes: [
    { path: '/project/src/new.ts', kind: { type: 'add' }, diff: '@@ -0,0 +1,2 @@\n+export const fresh = true;\n+export const label = "<script>";\n' },
    { path: '/project/src/old.ts', kind: { type: 'delete' }, diff: '@@ -1 +0,0 @@\n-export const old = true;\n' },
    { path: '/project/src/before.ts', kind: { type: 'update', movePath: '/project/src/after.ts' }, diff: '@@ -1 +1 @@\n-export const before = true;\n+export const after = true;\n' },
  ] });
  notify('item/started', { id: 'edit-failed', type: 'fileChange', status: 'inProgress', changes: [change] });
  notify('item/completed', { id: 'edit-failed', type: 'fileChange', status: 'failed', changes: [change], error: 'Patch failed' });
  return messages;
};
