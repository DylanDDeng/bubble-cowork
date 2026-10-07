import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Drives DevinAcpAdapter end to end against a scripted stand-in for
 * `devin acp` that reproduces the wire behavior observed on devin 3000.6.14:
 * - reverse requests carry UUID string ids (a numeric-only client misreads
 *   session/request_permission as a notification and the turn hangs);
 * - session/load replays the conversation as session/update notifications
 *   before responding;
 * - exec output streams as cumulative snapshots and the final `completed`
 *   update carries no content.
 */

const dir = mkdtempSync(path.join(tmpdir(), 'devin-acp-test-'));
const logPath = path.join(dir, 'calls.jsonl');
const fakeAgentPath = path.join(dir, 'devin');

writeFileSync(
  fakeAgentPath,
  `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const LOG = ${JSON.stringify(logPath)};
const FAIL_LOAD = process.env.FAKE_DEVIN_FAIL_LOAD === '1';
let buffer = '';
const pending = new Map();
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const update = (sessionId, payload) => send({ method: 'session/update', params: { sessionId, update: payload } });
const log = (entry) => appendFileSync(LOG, JSON.stringify(entry) + '\\n');
// Per-model thinking levels; a model switch resets the level to the model's
// own default and swe-2-medium has no thinking select at all (as observed).
const LEVELS = { 'swe-2-high': ['high', ['medium', 'high', 'max']], 'claude-opus-5-5-high': ['medium', ['low', 'medium', 'high', 'xhigh', 'max']] };
const state = { model: 'swe-2-high', level: 'high' };
const config = () => [
  { id: 'mode', category: 'mode', type: 'select', currentValue: 'accept-edits', options: [] },
  { id: 'model', category: 'model', type: 'select', currentValue: state.model, options: ['swe-2-high', 'swe-2-medium', 'claude-opus-5-5-high'].map((value) => ({ value, name: value })) },
  ...(LEVELS[state.model] ? [{ id: 'thought_level', category: 'thought_level', type: 'select', currentValue: state.level, options: LEVELS[state.model][1].map((value) => ({ value, name: value.toUpperCase() })) }] : []),
];
const commands = (sessionId) => update(sessionId, {
  sessionUpdate: 'available_commands_update',
  availableCommands: [{ name: 'plan', description: 'Switch to Plan mode', input: { hint: '[prompt]' } }, { name: 'compact', description: 'Compact' }],
});
const ask = (method, params) => new Promise((resolve) => {
  const id = 'b6f1c0de-0000-4000-8000-' + String(pending.size + 1).padStart(12, '0');
  pending.set(id, resolve);
  send({ id, method, params });
});

async function handle(message) {
  if (message.id !== undefined && !message.method) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve?.(message.result);
    return;
  }
  const { id, method, params } = message;
  log({ method, params });
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  } else if (method === 'session/new') {
    update('fresh-session', { sessionUpdate: 'current_mode_update', currentModeId: 'accept-edits' });
    commands('fresh-session');
    send({ id, result: { sessionId: 'fresh-session', modes: { currentModeId: 'accept-edits', availableModes: [] }, configOptions: config() } });
  } else if (method === 'session/load') {
    if (FAIL_LOAD) {
      send({ id, error: { code: -32002, message: 'Session not found' } });
      return;
    }
    const sid = params.sessionId;
    update(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old prompt' } });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED ANSWER' } });
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'old-call', title: 'Ran ls', kind: 'execute', rawInput: { command: 'ls' }, _meta: { 'cognition.ai/inferenceToolName': 'exec' } });
    update(sid, { sessionUpdate: 'usage_update', used: 1234, size: 200000, _meta: {} });
    commands(sid);
    send({ id, result: { modes: { currentModeId: 'plan', availableModes: [] }, configOptions: config() } });
  } else if (method === 'session/set_mode') {
    update(params.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: params.modeId });
    send({ id, result: {} });
  } else if (method === 'session/set_config_option') {
    if (params.configId === 'model') {
      state.model = params.value;
      state.level = LEVELS[params.value]?.[0];
    } else if (params.configId === 'thought_level') {
      if (!LEVELS[state.model]?.[1].includes(params.value)) {
        send({ id, error: { code: -32602, message: 'Invalid params', data: 'bad thought_level' } });
        return;
      }
      state.level = params.value;
    }
    send({ id, result: { configOptions: config() } });
  } else if (method === 'session/prompt' && String(params.prompt?.[0]?.text).startsWith('ASK')) {
    const reply = await ask('elicitation/create', {
      mode: 'form',
      sessionId: params.sessionId,
      message: 'Which fruits do you like?',
      requestedSchema: {
        type: 'object',
        properties: {
          q0: { type: 'array', title: 'Fruits', description: 'Which fruits do you like?', minItems: 1, items: { anyOf: [{ const: 'Apple', title: 'Crisp' }, { const: 'Banana', title: 'Soft' }] } },
          q1: { type: 'string', title: 'Color', description: 'Favorite color?', oneOf: [{ const: 'Red', title: 'Warm' }, { const: 'Blue', title: 'Cool' }] },
        },
        required: ['q0', 'q1'],
      },
      _meta: { 'cognition.ai/allowOther': true },
    });
    log({ method: 'elicitation_response', params: reply });
    send({ id, result: { stopReason: 'end_turn', usage: { totalTokens: 1, inputTokens: 1, outputTokens: 0 } } });
  } else if (method === 'session/prompt') {
    const sid = params.sessionId;
    update(sid, { sessionUpdate: 'session_info_update', title: 'functions.read_file:0{}' });
    update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Running it.' } });
    const exec = 'functions.exec:0#abc';
    update(sid, { sessionUpdate: 'tool_call', toolCallId: exec, title: 'Ran for', kind: 'execute', rawInput: { command: 'for i in 1 2; do echo line$i; done' }, _meta: { 'cognition.ai/inferenceToolName': 'exec' } });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: exec, status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'line1' } }] });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: exec, status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'line1\\nline2' } }] });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: exec, status: 'completed' });
    const curl = 'functions.exec:1#def';
    update(sid, { sessionUpdate: 'tool_call', toolCallId: curl, title: 'Ran curl', kind: 'execute', rawInput: { command: 'curl -sI https://example.com' }, _meta: { 'cognition.ai/inferenceToolName': 'exec' } });
    const decision = await ask('session/request_permission', {
      sessionId: sid,
      toolCall: { toolCallId: curl, _meta: { 'cognition.ai/editableCommand': 'curl -sI https://example.com' } },
      options: [
        { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'allow_session', name: 'Allow curl (session)', kind: 'allow_always' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
    });
    log({ method: 'permission_response', params: decision });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: curl, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'HTTP/2 200' } }] });
    update(sid, { sessionUpdate: 'usage_update', used: 25000, size: 262000, _meta: { 'cognition.ai/inputTokens': 24900, 'cognition.ai/outputTokens': 100, 'cognition.ai/cachedReadTokens': 24000 } });
    send({ method: '_cognition.ai/agent_stopped', params: { cause: 'complete' } });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' Done.' } });
    send({ id, result: { stopReason: 'end_turn', usage: { totalTokens: 25000, inputTokens: 24900, outputTokens: 100, cachedReadTokens: 24000 } } });
  } else {
    send({ id, error: { code: -32601, message: 'unknown ' + method } });
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) void handle(JSON.parse(line));
  }
});
`
);
chmodSync(fakeAgentPath, 0o755);
process.env.DEVIN_CLI_PATH = fakeAgentPath;

type Event = { type: string; [key: string]: unknown };

function readCalls(): Array<{ method: string; params: Record<string, unknown> }> {
  try {
    return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function resetCalls(): void {
  writeFileSync(logPath, '');
}

// A misrouted reverse request leaves the turn waiting forever; fail loudly instead.
function withTimeout<T>(promise: Promise<T>, label: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function main(): Promise<void> {
  const { DevinAcpAdapter } = await import('../../src/electron/libs/provider/devin-acp-adapter');

  // ── New session + one turn ────────────────────────────────────────────────
  {
    resetCalls();
    const adapter = new DevinAcpAdapter();
    const events: Event[] = [];
    adapter.events.on('event', (event: Event) => {
      events.push(event);
      if (event.type === 'permission_request') {
        void adapter.respondToRequest('t1', event.requestId as string, { behavior: 'allow', updatedInput: {} });
      }
    });

    const session = await adapter.startSession({
      threadId: 't1',
      cwd: dir,
      prompt: '',
      model: 'claude-opus-5-5-high',
      devinPermissionMode: 'smart',
    } as never);
    assert.equal(session.providerSessionId, 'fresh-session');
    assert.equal(session.model, 'claude-opus-5-5-high', 'start applies the requested model via set_config_option');

    const startCalls = readCalls();
    assert.deepEqual(
      startCalls.map((call) => call.method),
      ['initialize', 'session/new', 'session/set_config_option', 'session/set_mode']
    );
    assert.deepEqual(
      startCalls[0].params.clientCapabilities,
      { elicitation: { form: {} } },
      'no fs/terminal (Devin runs its own tools); form elicitation for its questions'
    );
    assert.equal(startCalls[3].params.modeId, 'smart');

    const init = events.find((event) => event.type === 'system_init');
    assert.equal(init?.sessionId, 'fresh-session');
    const commandMessages = events.filter(
      (event) => event.type === 'message' && (event.message as { subtype?: string }).subtype === 'available_commands_update'
    );
    assert.equal(commandMessages.length, 1, 'startup command list is emitted once, after binding');

    events.length = 0;
    resetCalls();
    await withTimeout(
      adapter.sendTurn({ threadId: 't1', prompt: 'go', model: 'claude-opus-5-5-high', devinPermissionMode: 'smart' } as never),
      'turn with a permission request'
    );

    const calls = readCalls();
    assert.deepEqual(
      calls.map((call) => call.method),
      ['session/prompt', 'permission_response'],
      'unchanged model/mode must not be re-sent'
    );
    assert.deepEqual(calls[1].params, { outcome: { outcome: 'selected', optionId: 'allow_once' } });

    const messages = events
      .filter((event) => event.type === 'message')
      .map((event) => event.message as Record<string, unknown>);
    const toolUses = messages.flatMap((message) =>
      ((message.message as { content?: Array<Record<string, unknown>> })?.content || []).filter((block) => block.type === 'tool_use')
    );
    assert.ok(toolUses.length >= 2);
    assert.ok(toolUses.every((block) => block.name === 'Bash'), 'exec maps to the Bash card');
    assert.equal((toolUses[0].input as { command: string }).command, 'for i in 1 2; do echo line$i; done');

    const deltas = events.filter((event) => event.type === 'tool_output_delta').map((event) => event.delta);
    assert.deepEqual(deltas, ['line1', '\nline2'], 'cumulative snapshots become incremental deltas');

    const results = messages.flatMap((message) =>
      ((message.message as { content?: Array<Record<string, unknown>> })?.content || []).filter((block) => block.type === 'tool_result')
    );
    assert.deepEqual(
      results.map((block) => [block.tool_use_id, block.content, block.is_error]),
      [
        ['functions.exec:0#abc', 'line1\nline2', false],
        ['functions.exec:1#def', 'HTTP/2 200', false],
      ],
      'an empty completed update reports the last output snapshot'
    );

    const permission = events.find((event) => event.type === 'permission_request');
    assert.ok(permission, 'UUID-id permission requests must reach the UI');
    const permissionInput = permission.input as { provider: string; title: string; question: string; toolName: string };
    assert.equal(permissionInput.provider, 'devin');
    assert.equal(permissionInput.title, 'Ran curl', 'title comes from the preceding tool_call');
    assert.equal(permissionInput.question, 'curl -sI https://example.com');
    assert.equal(permissionInput.toolName, 'Bash');

    const usage = messages.find((message) => message.subtype === 'token_usage') as
      | { provider: string; usage: { totalTokens: number; contextWindow: number } }
      | undefined;
    assert.equal(usage?.provider, 'devin');
    assert.equal(usage?.usage.totalTokens, 25000);
    assert.equal(usage?.usage.contextWindow, 262000);

    const assistantTexts = messages
      .filter((message) => message.type === 'assistant')
      .flatMap((message) => ((message.message as { content?: Array<Record<string, unknown>> }).content || []))
      .filter((block) => block.type === 'text')
      .map((block) => block.text);
    assert.deepEqual(assistantTexts, ['Running it.', ' Done.'], 'a tool call closes the narration block');

    const result = messages.find((message) => message.type === 'result') as
      | { subtype: string; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } }
      | undefined;
    assert.equal(result?.subtype, 'success');
    assert.equal(result?.usage.input_tokens, 24900);
    assert.equal(result?.usage.cache_read_input_tokens, 24000);

    // Model and mode switches apply live, before the next prompt.
    resetCalls();
    await withTimeout(
      adapter.sendTurn({ threadId: 't1', prompt: 'again', model: 'swe-2-medium', devinPermissionMode: 'plan' } as never),
      'turn after a live model/mode switch'
    );
    assert.deepEqual(
      readCalls().slice(0, 3).map((call) => call.method),
      ['session/set_config_option', 'session/set_mode', 'session/prompt']
    );

    // A model the session does not offer is skipped once, not retried per turn.
    resetCalls();
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
    try {
      for (let turn = 0; turn < 2; turn += 1) {
        await withTimeout(
          adapter.sendTurn({ threadId: 't1', prompt: 'x', model: 'swe-9-ultra', devinPermissionMode: 'plan' } as never),
          'turn with an unoffered model'
        );
      }
    } finally {
      console.warn = warn;
    }
    assert.ok(!readCalls().some((call) => call.method === 'session/set_config_option'));
    assert.equal(warnings.filter((line) => line.includes('swe-9-ultra')).length, 1);

    await adapter.stopAll();
  }

  // ── Thinking level: applied after the model, re-applied after a switch ───
  {
    resetCalls();
    const adapter = new DevinAcpAdapter();
    adapter.events.on('event', (event: Event) => {
      if (event.type === 'permission_request') {
        void adapter.respondToRequest('t4', event.requestId as string, { behavior: 'allow', updatedInput: {} });
      }
    });
    await adapter.startSession({
      threadId: 't4',
      cwd: dir,
      prompt: '',
      model: 'claude-opus-5-5-high',
      devinThoughtLevel: 'max',
    } as never);
    const start = readCalls().filter((call) => call.method === 'session/set_config_option');
    assert.deepEqual(
      start.map((call) => [call.params.configId, call.params.value]),
      [['model', 'claude-opus-5-5-high'], ['thought_level', 'max']],
      'the level is applied after the model (a switch resets it)'
    );

    resetCalls();
    await withTimeout(
      adapter.sendTurn({ threadId: 't4', prompt: 'x', model: 'claude-opus-5-5-high', devinThoughtLevel: 'max' } as never),
      'turn with an unchanged level'
    );
    assert.ok(!readCalls().some((call) => call.method === 'session/set_config_option'), 'unchanged level is not re-sent');

    resetCalls();
    await withTimeout(
      adapter.sendTurn({ threadId: 't4', prompt: 'x', model: 'swe-2-high', devinThoughtLevel: 'max' } as never),
      'turn after a model switch'
    );
    assert.deepEqual(
      readCalls().filter((call) => call.method === 'session/set_config_option').map((call) => [call.params.configId, call.params.value]),
      [['model', 'swe-2-high'], ['thought_level', 'max']],
      'the switch reset the level to high, so max is re-applied'
    );

    resetCalls();
    await withTimeout(
      adapter.sendTurn({ threadId: 't4', prompt: 'x', model: 'swe-2-medium', devinThoughtLevel: 'max' } as never),
      'turn on a model without thinking control'
    );
    assert.deepEqual(
      readCalls().filter((call) => call.method === 'session/set_config_option').map((call) => call.params.configId),
      ['model'],
      'a model without a thought_level select gets no level'
    );
    await adapter.stopAll();
  }

  // ── Questions: elicitation/create ↔ AskUserQuestion card ─────────────────
  {
    const answerWith = async (decision: Record<string, unknown>) => {
      resetCalls();
      const adapter = new DevinAcpAdapter();
      let card: Event | undefined;
      adapter.events.on('event', (event: Event) => {
        if (event.type === 'permission_request') {
          card = event;
          void adapter.respondToRequest('t5', event.requestId as string, decision as never);
        }
      });
      await adapter.startSession({ threadId: 't5', cwd: dir, prompt: '' } as never);
      await withTimeout(adapter.sendTurn({ threadId: 't5', prompt: 'ASK me' } as never), 'turn with a question');
      await adapter.stopAll();
      return { card, reply: readCalls().find((call) => call.method === 'elicitation_response')?.params };
    };

    const accepted = await answerWith({
      behavior: 'allow',
      updatedInput: { answers: { 'Which fruits do you like?': 'Apple,Durian, ripe', 'Favorite color?': 'Blue' } },
    });
    assert.equal(accepted.card?.toolName, 'AskUserQuestion');
    assert.deepEqual(accepted.card?.input, {
      questions: [
        { question: 'Which fruits do you like?', header: 'Fruits', options: [{ label: 'Apple', description: 'Crisp' }, { label: 'Banana', description: 'Soft' }], multiSelect: true },
        { question: 'Favorite color?', header: 'Color', options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }] },
      ],
    });
    assert.deepEqual(
      accepted.reply,
      { action: 'accept', content: { q0: ['Apple', 'Durian, ripe'], q1: 'Blue' } },
      'choices map to their consts; "Other" text stays whole, commas included'
    );

    const declined = await answerWith({ behavior: 'deny', message: 'User cancelled the request' });
    assert.deepEqual(declined.reply, { action: 'decline' });

    const { parseDevinElicitation, buildDevinElicitationContent } = await import('../../src/electron/libs/provider/devin-acp-adapter');
    assert.equal(parseDevinElicitation({ mode: 'url', url: 'https://x' }), null, 'only form mode has a UI');
    const mixed = parseDevinElicitation({
      message: 'Setup',
      requestedSchema: { properties: { a: { type: 'string', title: 'Name' }, b: { type: 'boolean', title: 'Proceed?' }, c: { type: 'integer', description: 'Count?' } } },
    })!;
    assert.deepEqual(
      buildDevinElicitationContent(mixed, { Name: 'Ada, Lovelace', 'Proceed?': 'Yes', 'Count?': '3' }),
      { a: 'Ada, Lovelace', b: true, c: 3 },
      'free text is kept whole; booleans and numbers are typed'
    );
  }

  // ── Skill library: `devin skills list --json` / `devin skills show` ──────
  {
    const { parseDevinSkillList, parseDevinSkillShowContent } = await import('../../src/electron/libs/devin-cli');
    const { mkdirSync } = await import('node:fs');
    const project = path.join(dir, 'project');
    const userSkill = path.join(dir, 'home', '.agents', 'skills', 'clarify');
    const projectSkill = path.join(project, '.devin', 'skills', 'deploy');
    mkdirSync(userSkill, { recursive: true });
    mkdirSync(projectSkill, { recursive: true });
    writeFileSync(path.join(userSkill, 'SKILL.md'), '# clarify');
    writeFileSync(path.join(projectSkill, 'SKILL.md'), '# deploy');
    const listing = parseDevinSkillList(
      JSON.stringify([
        { name: 'deploy', description: 'Ship it', provider: 'Devin', base_dir: projectSkill, triggers: ['user'] },
        { name: 'clarify', description: 'Better copy', provider: 'Devin', base_dir: userSkill, triggers: ['user', 'model'] },
        { name: 'upload-secrets', description: 'Secrets', provider: 'Builtin', base_dir: '', triggers: ['model', 'user'] },
        { name: 'clarify', description: 'duplicate', provider: 'Claude', base_dir: userSkill },
      ]),
      project
    );
    assert.deepEqual(
      listing.map((entry) => [entry.descriptor.name, entry.descriptor.scope, entry.descriptor.path, entry.needsInlineContent]),
      [
        ['clarify', 'user', path.join(userSkill, 'SKILL.md'), false],
        ['deploy', 'project', path.join(projectSkill, 'SKILL.md'), false],
        ['upload-secrets', 'system', 'devin-builtin:upload-secrets', true],
      ],
      'file-backed skills get their SKILL.md; builtins are System with inline content; duplicates collapse'
    );
    assert.equal(
      parseDevinSkillShowContent(
        'Skill: x\n\nDescription: mentions Content: inline\nTriggers: user\n\nContent:\n────────────\nBody line 1\n\nBody line 2\n'
      ),
      'Body line 1\n\nBody line 2',
      'the body starts after the Content: line and its rule, not at an inline mention'
    );
    assert.equal(parseDevinSkillShowContent('Skill: x\nno body'), null);
  }

  // ── Thinking level parsing ───────────────────────────────────────────────
  {
    const { parseDevinThoughtLevels } = await import('../../src/electron/libs/devin-cli');
    assert.deepEqual(
      parseDevinThoughtLevels([
        { id: 'model', currentValue: 'x', options: [] },
        { id: 'thought_level', category: 'thought_level', currentValue: 'high', options: [{ value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }, { value: 'xhigh', name: 'XHigh' }] },
      ]),
      { levels: [{ id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'xhigh', label: 'XHigh' }], defaultLevel: 'high' }
    );
    assert.deepEqual(parseDevinThoughtLevels([{ id: 'model', options: [] }]), { levels: [], defaultLevel: null });
  }

  // ── Tool naming: Devin ids → Claude-shaped cards ─────────────────────────
  {
    const { devinToolName, devinToolInput } = await import('../../src/electron/libs/provider/devin-acp-adapter');
    const named = (id: string) => devinToolName({ _meta: { 'cognition.ai/inferenceToolName': id } });
    assert.deepEqual(
      ['exec', 'read', 'write', 'edit', 'grep', 'find_file_by_name', 'notebook_edit', 'mcp__x__y'].map(named),
      ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'NotebookEdit', 'mcp__x__y']
    );
    assert.equal(devinToolName({ kind: 'execute', title: 'Ran ls' }), 'Bash', 'ACP kind is the fallback');
    assert.deepEqual(devinToolInput('Glob', { query: '**/note.txt' }), { query: '**/note.txt', pattern: '**/note.txt' });
    assert.deepEqual(devinToolInput('Bash', { command: 'ls' }), { command: 'ls' });
    assert.equal(named('ask_user_question'), 'AskUserQuestion');
    assert.deepEqual(
      devinToolInput('AskUserQuestion', { questions: [{ question: 'Q?', multi_select: true, options: [{ label: 'a' }] }] }),
      { questions: [{ question: 'Q?', options: [{ label: 'a' }], multiSelect: true }] }
    );
  }

  // ── Catalog parsing: flat and grouped model selects ──────────────────────
  {
    const { parseDevinAcpModelOptions } = await import('../../src/electron/libs/devin-cli');
    assert.deepEqual(
      parseDevinAcpModelOptions([
        { id: 'mode', options: [{ value: 'plan', name: 'Plan' }] },
        { id: 'model', category: 'model', currentValue: 'swe-2-high', options: [{ value: 'adaptive', name: 'Adaptive' }, { value: 'swe-2-high', name: 'SWE-2' }] },
      ]),
      { defaultModel: 'swe-2-high', availableModels: [{ id: 'adaptive', label: 'Adaptive' }, { id: 'swe-2-high', label: 'SWE-2' }] }
    );
    assert.deepEqual(
      parseDevinAcpModelOptions([
        { id: 'model', currentValue: 'b', options: [{ group: 'g1', name: 'Group', options: [{ value: 'a', name: 'A' }, { value: 'b' }] }, { value: 'a', name: 'dup' }] },
      ]),
      { defaultModel: 'b', availableModels: [{ id: 'a', label: 'A' }, { id: 'b', label: 'b' }] }
    );
    assert.deepEqual(parseDevinAcpModelOptions(undefined), { defaultModel: null, availableModels: [] });
  }

  // ── Resume: load replay is dropped, startup state is kept ────────────────
  {
    resetCalls();
    const adapter = new DevinAcpAdapter();
    const events: Event[] = [];
    adapter.events.on('event', (event: Event) => events.push(event));
    const session = await adapter.startSession({
      threadId: 't2',
      cwd: dir,
      prompt: '',
      resumeSessionId: 'old-session',
      devinPermissionMode: 'plan',
    } as never);
    assert.equal(session.providerSessionId, 'old-session');
    assert.deepEqual(
      readCalls().map((call) => call.method),
      ['initialize', 'session/load'],
      'the loaded session is already in plan mode: no set_mode'
    );
    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes('REPLAYED ANSWER'), 'replayed transcript must not re-enter the thread');
    assert.ok(!serialized.includes('old-call'), 'replayed tool calls must not re-enter the thread');
    const usage = events.find(
      (event) => event.type === 'message' && (event.message as { subtype?: string }).subtype === 'token_usage'
    );
    assert.ok(usage, 'the replayed context watermark seeds the context ring');
    assert.ok(
      events.some((event) => event.type === 'message' && (event.message as { subtype?: string }).subtype === 'available_commands_update')
    );
    await adapter.stopAll();
  }

  // ── Resume failure falls back to a fresh session ─────────────────────────
  {
    resetCalls();
    process.env.FAKE_DEVIN_FAIL_LOAD = '1';
    const adapter = new DevinAcpAdapter();
    const warn = console.warn;
    console.warn = () => {};
    try {
      const session = await adapter.startSession({
        threadId: 't3',
        cwd: dir,
        prompt: '',
        resumeSessionId: 'gone-session',
      } as never);
      assert.equal(session.providerSessionId, 'fresh-session');
      assert.deepEqual(readCalls().map((call) => call.method), ['initialize', 'session/load', 'session/new']);
    } finally {
      console.warn = warn;
      delete process.env.FAKE_DEVIN_FAIL_LOAD;
      await adapter.stopAll();
    }
  }

  console.log('devin-acp-adapter: all checks passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
