import assert from 'node:assert/strict';
import { useAppStore } from '../../src/ui/store/useAppStore';
import type { ServerEvent, StreamMessage } from '../../src/ui/types';

/**
 * Grok streams its answer as deltas into the session's streaming buffer while
 * interleaving tool calls, tool results and command-list pushes. Those must not
 * clear the buffer: doing so wiped the visible answer mid-turn, leaving only
 * the trace until the committed message re-rendered it from scratch.
 */

const SESSION_ID = 'grok-partial-session';

function dispatch(event: ServerEvent): void {
  useAppStore.getState().handleServerEvent(event);
}

function streamMessage(message: StreamMessage): void {
  dispatch({ type: 'stream.message', payload: { sessionId: SESSION_ID, message } } as ServerEvent);
}

function textDelta(text: string): StreamMessage {
  return {
    type: 'stream_event',
    parentToolUseId: null,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  } as unknown as StreamMessage;
}

const partial = () => useAppStore.getState().sessions[SESSION_ID]?.streaming.text ?? '';

async function main() {
useAppStore.setState((state) => ({
  sessions: {
    ...state.sessions,
    [SESSION_ID]: {
      ...(state.sessions[SESSION_ID] || {}),
      id: SESSION_ID,
      title: 'grok',
      provider: 'grok',
      status: 'running',
      messages: [],
      streaming: { text: '', thinking: '', isStreaming: false },
      permissionRequests: [],
    },
  } as never,
}));

streamMessage(textDelta('Here is '));
streamMessage(textDelta('the answer'));
// The coalescer buffers deltas for 33ms; flush by asking for a status the way
// the store does, then assert on the settled buffer.
await new Promise((resolve) => setTimeout(resolve, 80));
assert.equal(partial(), 'Here is the answer', 'deltas accumulate into the streaming buffer');

// Mid-answer traffic: a tool call, its result, and a command-list push.
streamMessage({
  type: 'assistant',
  uuid: 'grok-tool-use:t:1',
  message: { content: [{ type: 'tool_use', id: 'call-1', name: 'X search', input: {} }] },
} as unknown as StreamMessage);
assert.equal(partial(), 'Here is the answer', 'a tool call must not wipe the visible answer');

streamMessage({
  type: 'assistant',
  uuid: 'grok-tool-result:t:1',
  message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }] },
} as unknown as StreamMessage);
assert.equal(partial(), 'Here is the answer', 'a tool result must not wipe it either');

streamMessage({
  type: 'system',
  subtype: 'available_commands_update',
  session_id: 'p1',
  availableCommands: [{ name: 'compact', description: 'x' }],
} as unknown as StreamMessage);
assert.equal(partial(), 'Here is the answer', 'a command-list push must not wipe it either');

// The commit of the block DOES clear it — otherwise the partial would render
// twice, once as the bubble and once as the message.
streamMessage({
  type: 'assistant',
  uuid: 'grok-assistant:t:1',
  message: { content: [{ type: 'text', text: 'Here is the answer' }] },
} as unknown as StreamMessage);
assert.equal(partial(), '', 'committing the text block clears the buffer');

  console.log('grok streaming partial survives interleaved messages OK');
}

void main();
