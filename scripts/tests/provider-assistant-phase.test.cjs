const assert = require('node:assert/strict');
const { PiSdkAdapter } = require('../../dist-electron/electron/libs/provider/pi-sdk-adapter.js');
const { BubbleSdkAdapter } = require('../../dist-electron/electron/libs/provider/bubble-sdk-adapter.js');

// Exercise native event conversion without starting a runtime or paid turn.
for (const [stopReason, expected] of [['stop', 'final_answer'], ['toolUse', 'commentary'], ['length', undefined], ['aborted', undefined], [undefined, undefined]]) {
  const adapter = new PiSdkAdapter();
  const events = [];
  adapter.events.on('event', event => events.push(event));
  const session = {
    threadId: 'phase-test', session: {}, usage: {}, totalCostUsd: 0,
    ingestedUsageKeys: new Set(), emittedAssistantKeys: new Set(),
    emittedToolCallIds: new Set(['tool-1']), currentAssistant: null,
  };
  adapter.handleMessageEnd(session, {
    role: 'assistant', stopReason, timestamp: 1000,
    content: [{ type: 'text', text: 'Response' },
      ...(stopReason === 'toolUse' ? [{ type: 'toolCall', id: 'tool-1', name: 'read', arguments: {} }] : [])],
  });
  assert.equal(events.at(-1).message.phase, expected, `Pi ${stopReason}`);
}

for (const [willContinue, expected] of [[false, 'final_answer'], [true, 'commentary'], [undefined, undefined]]) {
  const adapter = new BubbleSdkAdapter();
  const events = [];
  adapter.events.on('event', event => events.push(event));
  const session = {
    threadId: 'phase-test', usage: {}, totalCostUsd: 0,
    currentAssistant: { uuid: 'answer', createdAt: 1000, text: 'Response', thinking: '' },
  };
  adapter.handleBubbleEvent(session, { type: 'turn_end', willContinue });
  assert.equal(events.at(-1).message.phase, expected, `Bubble ${willContinue}`);
  assert.equal(session.currentAssistant, null);
}

console.log('provider assistant phase: native completion, continuation and absent metadata passed');
