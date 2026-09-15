import assert from 'node:assert/strict';
import { parseToolOutput } from '../../src/ui/utils/tool-result-content';
import { getAssistantPhase } from '../../src/shared/assistant-phase';
import { normalizeToolResultBlock } from '../../src/ui/utils/message-content';
import type { StreamMessage } from '../../src/shared/types';

assert.deepEqual(parseToolOutput('plain text'), [{ type: 'text', text: 'plain text' }]);
assert.deepEqual(parseToolOutput('[]'), [{ type: 'json', text: '[]' }]);
assert.deepEqual(parseToolOutput('{"content":[]}'), []);
assert.equal(parseToolOutput('{"content":[{"type":"text","text":"{\\"ok\\":true}"}],"structuredContent":{"ok":true}}').length, 1);
const rich = parseToolOutput(JSON.stringify({ content: [
  { type: 'text', text: 'Read this resource' },
  { type: 'resource_link', uri: 'resource://project/readme', name: 'README' },
  { type: 'resource', resource: { uri: 'resource://project/config', mimeType: 'application/json', text: '{}' } },
  { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
  { type: 'audio', mimeType: 'audio/wav', data: 'aGVsbG8=' },
  { type: 'vendor_specific', data: { preserved: true } },
] }));
assert.deepEqual(rich.map(part => part.type), ['text', 'resource', 'resource', 'image', 'audio', 'unknown']);
assert.equal(parseToolOutput('[{"type":"image","mimeType":"image/svg+xml","data":"PHN2Zz4="}]')[0].type, 'unknown', 'untrusted active formats stay data');
const normalized = normalizeToolResultBlock({ type: 'tool_result', tool_use_id: 't', content: 'Text', displayContent: JSON.stringify({ content: [{type:'resource_link',uri:'resource://a'}] }) });
assert.equal(parseToolOutput(normalized!.displayContent!)[0].type, 'resource', 'typed display data survives the transcript boundary');
const assistant = (reason?: string, tool = false): StreamMessage => ({ type: 'assistant', uuid: 'a', message: {
  stop_reason: reason, content: [{ type: 'text', text: 'Answer' }, ...(tool ? [{ type: 'tool_use' as const, id: 't', name: 'Read', input: {} }] : [])],
} });
assert.equal(getAssistantPhase(assistant('end_turn')), 'final_answer');
assert.equal(getAssistantPhase(assistant('tool_use', true)), 'commentary');
for (const reason of [undefined, 'max_tokens', 'pause_turn', 'refusal']) assert.equal(getAssistantPhase(assistant(reason)), undefined);
assert.equal(getAssistantPhase(assistant('end_turn', true)), 'commentary', 'tools preclude a guessed final answer');
console.log('tool output content and native assistant phases passed');
