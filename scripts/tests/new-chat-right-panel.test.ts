// A new chat starts with its own empty right panel: it does not inherit the
// previous chat's tabs (whose browser pages stay with that chat), and switching
// back to the previous chat brings its tabs back.
import assert from 'node:assert/strict';
import { useAppStore } from '../../src/ui/store/useAppStore';

const store = () => useAppStore.getState();

const first = store().createDraftSession('/projects/x');
assert.equal(store().activeSessionId, first);
useAppStore.setState({
  rightUtilityTabs: ['browser', 'browser:extra'],
  activeRightUtilityTab: 'browser:extra',
  rightUtilityPanelHidden: false,
});

const second = store().createDraftSession('/projects/x');
assert.equal(store().activeSessionId, second);
assert.deepEqual(store().rightUtilityTabs, [], 'the new chat has no tabs of its own yet');
assert.equal(store().activeRightUtilityTab, null);
assert.equal(store().rightUtilityPanelHidden, true, 'and its panel starts closed');

store().setActiveSession(first);
assert.deepEqual(store().rightUtilityTabs, ['browser', 'browser:extra'], 'the previous chat keeps its tabs');
assert.equal(store().activeRightUtilityTab, 'browser:extra');
assert.equal(store().rightUtilityPanelHidden, false);

console.log('new-chat-right-panel: fresh panel for a new chat, previous chat restored');
