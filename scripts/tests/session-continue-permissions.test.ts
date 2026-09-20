import assert from 'node:assert/strict';
import { sessionContinuePermissions } from '../../src/ui/utils/session-continue-permissions';
import { savePreferredQoderPermissionMode } from '../../src/ui/utils/qoder-permission';
import { savePreferredKimiPermissionMode } from '../../src/ui/utils/kimi-permission';
import { savePreferredDeepseekPermissionMode } from '../../src/ui/utils/deepseek-permission';
import { savePreferredBubblePermissionMode } from '../../src/ui/utils/bubble-permission';

// Isolated preference storage: use the real readers/writers without touching
// the user's renderer-state file or requesting a live agent turn.
const values = new Map<string, string>();
Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
Object.defineProperty(globalThis, 'localStorage', { value: {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
}, configurable: true });

assert.deepEqual(sessionContinuePermissions({ provider: 'qoder' }), { qoderPermissionMode: 'default' });
savePreferredQoderPermissionMode('bypassPermissions');
assert.deepEqual(sessionContinuePermissions({ provider: 'qoder' }), { qoderPermissionMode: 'bypassPermissions' });
savePreferredQoderPermissionMode('default');
assert.deepEqual(sessionContinuePermissions({ provider: 'qoder' }), { qoderPermissionMode: 'default' }, 'explicitly returning to Default must take effect');
savePreferredQoderPermissionMode('plan');
assert.deepEqual(sessionContinuePermissions({ provider: 'qoder' }), { qoderPermissionMode: 'plan' });

assert.deepEqual(sessionContinuePermissions({ provider: 'kimi' }), { kimiPermissionMode: 'default' });
savePreferredKimiPermissionMode('yolo');
assert.deepEqual(sessionContinuePermissions({ provider: 'kimi' }), { kimiPermissionMode: 'yolo' });
assert.deepEqual(sessionContinuePermissions({ provider: 'grok' }), { kimiPermissionMode: 'yolo', grokPermissionMode: 'yolo' });
assert.deepEqual(sessionContinuePermissions({ provider: 'deepseek' }), { deepseekPermissionMode: 'workspace-write' });
savePreferredDeepseekPermissionMode('danger-full-access');
assert.deepEqual(sessionContinuePermissions({ provider: 'deepseek' }), { deepseekPermissionMode: 'danger-full-access' });
savePreferredBubblePermissionMode('bypassPermissions');
assert.deepEqual(sessionContinuePermissions({ provider: 'bubble' }), { bubblePermissionMode: 'bypassPermissions' });
assert.deepEqual(sessionContinuePermissions({ provider: 'bubble', bubblePermissionMode: 'plan' }), { bubblePermissionMode: 'plan' }, 'Full Access preference must not exit a live plan');

for (const provider of ['claude', 'codex', 'opencode', 'pi'] as const) {
  assert.deepEqual(sessionContinuePermissions({ provider }), {}, `${provider} must not inherit another agent's permission preferences`);
}
console.log('session continue permission preferences passed');
