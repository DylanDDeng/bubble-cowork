const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-retry-persistence-'));
app.setPath('userData', scratch);
app.whenReady().then(() => {
  const sessions = require('../../dist-electron/electron/libs/session-store.js');
  const { StreamRetryTracker } = require('../../dist-electron/electron/libs/stream-retry-tracker.js');
  try {
    sessions.initialize();
    const session = sessions.createSession({ title: 'Retry durability', provider: 'claude', cwd: scratch });
    const tracker = new StreamRetryTracker();
    const attribution = { agentId: 'profile', agentRunId: 'run-profile' };
    const observe = message => {
      const result = tracker.observe(message, attribution);
      for (const event of [result.resolved, result.message]) {
        if (event && event.type !== 'stream_event') sessions.addMessage(session.id, event);
      }
      return result;
    };
    const reasoning = 'Long interrupted reasoning. '.repeat(4000); // Exercises external payload storage too.
    observe({ type: 'stream_event', event: { type: 'content_block_delta', index: 0,
      delta: { type: 'thinking_delta', thinking: reasoning } } });
    observe({ type: 'system', subtype: 'api_retry', uuid: 'retry-db', session_id: session.id,
      attempt: 1, maxRetries: 10, delayMs: 1000, errorStatus: null });
    sessions.close();
    sessions.initialize();
    let history = sessions.getSessionHistory(session.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].snapshot.thinking, reasoning);
    assert.equal(history[0].snapshot.agentRunId, attribution.agentRunId);
    assert.equal(history[0].type, 'system', 'display-only reasoning is never persisted as an unsigned Claude assistant message');
    observe({ type: 'stream_event', event: { type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: 'Recovered' } } });
    sessions.close();
    sessions.initialize();
    history = sessions.getSessionHistory(session.id);
    assert.equal(history.at(-1).subtype, 'api_retry_resolved');
    assert.equal(history.at(-1).retryId, 'retry-db');
    assert.equal(history.at(-1).snapshot.thinking, reasoning);
    assert(!history.some(m => m.type === 'stream_event'));
    console.log('retry persistence: SQLite reopen, external payload, agent attribution and recovery marker passed');
    sessions.close();
    fs.rmSync(scratch, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    sessions.close();
    fs.rmSync(scratch, { recursive: true, force: true });
    app.exit(1);
  }
});
