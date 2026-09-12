const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-preferences-'));
const broadcasts = [], locks = new Set(), notices = [];
let focused = false, nextId = 0;
const electron = {
  app: { getPath: () => tmp },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (...args) => broadcasts.push(args) } }] },
  powerSaveBlocker: { start: type => { assert.equal(type, 'prevent-app-suspension'); locks.add(++nextId); return nextId; }, stop: id => locks.delete(id) },
  Notification: class { static isSupported() { return true; } constructor(options) { this.options = options; } on() {} show() { notices.push(this.options); } },
};
const original = Module._load;
Module._load = function(name, ...args) { return name === 'electron' ? electron : original.call(this, name, ...args); };
const root = path.resolve(__dirname, '../../dist-electron');
const preferencePath = path.join(root, 'electron/libs/app-preferences.js');
const notificationPath = path.join(root, 'electron/libs/notifications.js');
try {
  let prefs = require(preferencePath);
  assert.equal(prefs.getAppPreferences().enterBehavior, 'enter');
  prefs.setAppPreferences({ enterBehavior: 'modifier', defaultEditor: 'code', showContextUsage: false });
  assert.equal(broadcasts.length, 1);
  delete require.cache[preferencePath]; prefs = require(preferencePath);
  assert.equal(prefs.getAppPreferences().enterBehavior, 'modifier');
  assert.equal(prefs.getAppPreferences().showContextUsage, false);
  prefs.setAppPreferences({uiFontSize:16,codeFontSize:17,reduceMotion:'on',fontSmoothing:false,pointerCursors:false,diffMarkers:'signs'});
  delete require.cache[preferencePath]; prefs = require(preferencePath);
  assert.equal(prefs.getAppPreferences().uiFontSize,16);
  assert.equal(prefs.getAppPreferences().codeFontSize,17);
  assert.equal(prefs.getAppPreferences().reduceMotion,'on');
  assert.equal(prefs.getAppPreferences().fontSmoothing,false);
  assert.equal(prefs.getAppPreferences().pointerCursors,false);
  assert.equal(prefs.getAppPreferences().diffMarkers,'signs');
  assert.throws(() => prefs.setAppPreferences({ terminalShell: '/not/a/shell' }), /not available/);
  assert.equal(prefs.getAppPreferences().terminalShell, 'system');
  prefs.setAppPreferences({ preventSleep: true });
  prefs.trackTaskPowerState('a', true); prefs.trackTaskPowerState('a', true); prefs.trackTaskPowerState('b', true);
  assert.equal(locks.size, 1);
  prefs.trackTaskPowerState('a', false); assert.equal(locks.size, 1);
  prefs.setAppPreferences({ preventSleep: false }); assert.equal(locks.size, 0);
  prefs.setAppPreferences({ preventSleep: true }); assert.equal(locks.size, 1);
  prefs.trackTaskPowerState('b', false); assert.equal(locks.size, 0);
  // A failed write must not update cache or notify renderer windows.
  const target = path.join(tmp, 'app-preferences.json.tmp'); fs.mkdirSync(target);
  const before = broadcasts.length;
  assert.throws(() => prefs.setAppPreferences({ showContextUsage: true }));
  assert.equal(prefs.getAppPreferences().showContextUsage, false); assert.equal(broadcasts.length, before);
  fs.rmdirSync(target);

  fs.writeFileSync(path.join(tmp, 'notification-settings.json'), JSON.stringify({ enabled: false, onlyWhenUnfocused: true }));
  let n = require(notificationPath);
  assert.equal(n.getNotificationSettings().inputRequired, false); assert.equal(n.getNotificationSettings().approvalRequired, false);
  n.configureNotifications({ isWindowFocused: () => focused, onActivate() {} });
  const row = { id: 'a', title: 'Task', status: 'idle' };
  n.notifySessionInput(row, 'off', true); n.notifySessionDone(row); assert.equal(notices.length, 0);
  n.setNotificationSettings({ inputRequired: true }); n.notifySessionInput(row, 'input', true); n.notifySessionInput(row, 'input', true);
  assert.equal(notices.length, 1); assert.equal(notices[0].title, 'Agent needs your input');
  n.notifySessionInput(row, 'approval-off', false); assert.equal(notices.length, 1);
  n.setNotificationSettings({ enabled: true, onlyWhenUnfocused: false, approvalRequired: true });
  focused = true; n.notifySessionDone(row); n.notifySessionInput(row, 'focused', true);
  assert.equal(notices.length, 2, 'completion Always does not enable foreground input alerts');
  focused = false; n.notifySessionInput(row, 'approval', false); assert.equal(notices.length, 3);
  assert(n.isQuestionRequest('Question', {})); assert(n.isQuestionRequest('AskUserQuestion', {}));
  assert(n.isQuestionRequest('custom', { questions: [] })); assert(!n.isQuestionRequest('Bash', { command: 'ls' }));
  delete require.cache[notificationPath]; n = require(notificationPath); assert.equal(n.getNotificationSettings().inputRequired, true);

  const { composerEnterAction: action } = require(path.join(root, 'shared/app-preferences.js'));
  const enter = { key: 'Enter', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false };
  assert.deepEqual(action(enter, 'x', 'enter'), { send: true, invert: false });
  assert.deepEqual(action({ ...enter, metaKey: true }, 'x', 'enter'), { send: true, invert: true });
  for (const behavior of ['enter', 'multiline', 'modifier']) {
    assert.equal(action({ ...enter, isComposing: true }, 'x', behavior).send, false);
    assert.equal(action({ ...enter, shiftKey: true }, 'x', behavior).send, false);
  }
  assert.equal(action(enter, 'x', 'multiline').send, true);
  assert.equal(action(enter, 'x\ny', 'multiline').send, false);
  assert.equal(action({ ...enter, ctrlKey: true }, 'x\ny', 'multiline').send, true);
  assert.equal(action(enter, 'x', 'modifier').send, false);
  assert.deepEqual(action({ ...enter, ctrlKey: true, shiftKey: true }, 'x', 'modifier'), { send: true, invert: true });
  assert.deepEqual(action({ ...enter, metaKey: true }, 'x', 'multiline'), { send: true, invert: false });
  console.log('App preferences: persistence, failure, power lifecycle, notifications, keyboard passed');
} finally { Module._load = original; fs.rmSync(tmp, { recursive: true, force: true }); }
