import assert from 'node:assert/strict';
import { GrokAcpAdapter } from '../../src/electron/libs/provider/grok-acp-adapter';
import { deriveTranscriptTimelineItems } from '../../src/ui/utils/transcript-timeline';
import type { StreamMessage } from '../../src/ui/types';

/**
 * Grok narrates between tool calls. One text buffer per turn stamped at the
 * first chunk made that narration ride into the final answer and sort in among
 * the tool rows; a new tool call now closes the open text block.
 */

// Deterministic clock: real Date.now() collapses same-millisecond segments and
// makes the ordering assertions vacuous.
const realNow = Date.now;
let clock = 1_000_000;
Date.now = () => (clock += 1000);

type AnyAdapter = {
  events: { on: (event: 'event', listener: (payload: unknown) => void) => void };
  sessions: Map<string, unknown>;
  handleSessionUpdate: (threadId: string, update: Record<string, unknown>) => void;
  finalizeStreaming: (session: unknown) => void;
};

function harness(adapter: unknown) {
  const inner = adapter as unknown as AnyAdapter;
  const messages: StreamMessage[] = [];
  inner.events.on('event', (event) => {
    const typed = event as { type: string; message?: StreamMessage };
    if (typed.type === 'message' && typed.message) {
      messages.push(typed.message);
    }
  });
  const session = {
    threadId: 't1',
    providerSessionId: 'p1',
    status: 'running',
    cwd: '/tmp',
    toolCalls: new Map(),
    terminals: new Map(),
    nextBlockIndex: 0,
  };
  inner.sessions.set('t1', session);
  return {
    send: (update: Record<string, unknown>) => inner.handleSessionUpdate('t1', update),
    // What sendTurn does when the prompt RPC resolves: commit the open block.
    endTurn: () => inner.finalizeStreaming(session),
    messages,
  };
}

const text = (value: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } });
const toolCall = (id: string) => ({ sessionUpdate: 'tool_call', toolCallId: id, title: 'X search', rawInput: {} });

/** Latest state per uuid — the renderer upserts streaming messages in place. */
function upsert(messages: StreamMessage[]): StreamMessage[] {
  const byUuid = new Map<string, StreamMessage>();
  const order: string[] = [];
  for (const message of messages) {
    const uuid = (message as { uuid?: string }).uuid || `anon:${order.length}`;
    if (!byUuid.has(uuid)) order.push(uuid);
    const existing = byUuid.get(uuid) as { createdAt?: number } | undefined;
    byUuid.set(
      uuid,
      existing?.createdAt !== undefined
        ? ({ ...(message as object), createdAt: existing.createdAt } as StreamMessage)
        : message
    );
  }
  return order.map((uuid) => byUuid.get(uuid) as StreamMessage);
}

function assistantTexts(messages: StreamMessage[]): string[] {
  return messages
    .filter((message): message is StreamMessage & { type: 'assistant' } => message.type === 'assistant')
    .map((message) => {
      const blocks = (message.message?.content || []) as Array<{ type: string; text?: string }>;
      return blocks.filter((block) => block.type === 'text').map((block) => block.text || '').join('');
    })
    .filter(Boolean);
}

for (const [label, adapter] of [['grok', new GrokAcpAdapter()]] as const) {
  const { send, endTurn, messages } = harness(adapter);

  send(text('narration one'));
  send(toolCall('call-1'));
  // Repeat of a call already in flight: an input update, not a new block.
  send(toolCall('call-1'));
  send(text('narration two'));
  send(toolCall('call-2'));
  send(text('the real answer'));
  endTurn();

  const collapsed = upsert(messages);
  const texts = assistantTexts(collapsed);

  assert.deepEqual(
    texts,
    ['narration one', 'narration two', 'the real answer'],
    `${label}: each narration segment is its own message, and a repeated tool-call id does not split prose`
  );

  const stamps = collapsed
    .filter((message) => message.type === 'assistant')
    .map((message) => (message as { createdAt?: number }).createdAt ?? 0);
  assert.ok(
    stamps.every((stamp, index) => index === 0 || stamp >= stamps[index - 1]),
    `${label}: segments carry non-decreasing timestamps`
  );

  // The finished turn must promote only the last segment as the answer.
  const transcript: StreamMessage[] = [
    { type: 'user_prompt', prompt: 'go', createdAt: 999_000 } as unknown as StreamMessage,
    ...collapsed,
    { type: 'result', createdAt: Date.now() } as unknown as StreamMessage,
  ];
  const items = deriveTranscriptTimelineItems(transcript, { sessionRunning: false });
  const answers = items
    .filter(
      (item): item is Extract<typeof item, { type: 'message' }> =>
        item.type === 'message' && item.message.type === 'assistant'
    )
    .map((item) => {
      const blocks = ((item.message as { message?: { content?: unknown } }).message?.content ||
        []) as Array<{ type: string; text?: string }>;
      return blocks.filter((block) => block.type === 'text').map((block) => block.text || '').join('');
    });

  assert.deepEqual(
    answers,
    ['the real answer'],
    `${label}: only the final segment renders as the answer — narration stays in the trace`
  );
}

// ── Streaming shape: increments, not the whole buffer ───────────────────────
{
  const adapter = new GrokAcpAdapter();
  const { send, endTurn, messages } = harness(adapter);

  send(text('abc'));
  send(text('def'));
  send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'why' } });
  endTurn();

  const deltas = messages.filter((m) => m.type === 'stream_event') as Array<{
    event: { index?: number; delta?: { type: string; text?: string; thinking?: string } };
  }>;
  assert.deepEqual(
    deltas.map((d) => d.event.delta?.text ?? d.event.delta?.thinking),
    ['abc', 'def', 'why'],
    'each chunk emits only its own increment — never the accumulated buffer'
  );
  assert.deepEqual(
    deltas.map((d) => d.event.delta?.type),
    ['text_delta', 'text_delta', 'thinking_delta'],
    'reasoning and answer text stream as distinct delta types'
  );
  assert.equal(
    deltas[0].event.index,
    deltas[1].event.index,
    'one text block keeps one index so the coalescer can batch it'
  );
  assert.notEqual(
    deltas[2].event.index,
    deltas[0].event.index,
    'thinking opens its own block'
  );

  // The committed message still carries the full text for the transcript.
  assert.deepEqual(assistantTexts(messages), ['abcdef']);
}

// ── An unchanged command list is not re-broadcast ───────────────────────────
{
  const adapter = new GrokAcpAdapter();
  const { send, messages } = harness(adapter);
  const commands = {
    sessionUpdate: 'available_commands_update',
    availableCommands: [
      { name: 'compact', description: 'Compress conversation history' },
      { name: 'my-skill', description: 'A skill', _meta: { scope: 'user', path: '/s/SKILL.md' } },
    ],
  };

  send(commands);
  send(commands);
  send(commands);
  const pushes = messages.filter(
    (m) => m.type === 'system' && (m as { subtype?: string }).subtype === 'available_commands_update'
  );
  assert.equal(pushes.length, 1, 'identical repeats are dropped');

  send({ ...commands, availableCommands: [...commands.availableCommands, { name: 'new', description: 'x' }] });
  assert.equal(
    messages.filter(
      (m) => m.type === 'system' && (m as { subtype?: string }).subtype === 'available_commands_update'
    ).length,
    2,
    'a changed list still goes through'
  );
}

Date.now = realNow;
console.log('grok streaming + narration split OK');
