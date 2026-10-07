import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * Drives MimoAcpAdapter end to end against a scripted stand-in for
 * `mimo acp` that reproduces the wire behavior observed on mimo 0.1.14:
 * - the model select lists `provider/model` and `provider/model/variant`;
 * - tool calls start `pending` with `{}` input, then carry OpenCode's
 *   camelCase arguments; bash output streams as cumulative snapshots;
 * - a permission request is titled with the permission key and carries the
 *   tool's metadata; after an approved edit MiMo sends fs/write_text_file;
 * - usage_update carries the session's running cost;
 * - a failed model call ends with a plain end_turn and zero usage, the error
 *   only stored in MiMo's database;
 * - session/load replays the conversation before it responds.
 */

const dir = mkdtempSync(path.join(tmpdir(), 'mimo-acp-test-'));
const logPath = path.join(dir, 'calls.jsonl');
const fakeAgentPath = path.join(dir, 'mimo');
const dbPath = path.join(dir, 'mimocode.db');

writeFileSync(
  fakeAgentPath,
  `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const LOG = ${JSON.stringify(logPath)};
let buffer = '';
const pending = new Map();
let nextId = 0;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
const update = (sessionId, payload) => send({ method: 'session/update', params: { sessionId, update: payload } });
const log = (entry) => appendFileSync(LOG, JSON.stringify(entry) + '\\n');
const state = { model: 'xiaomi/mimo-v2.6-pro', mode: 'build', cost: 0.01 };
const MODELS = ['mimo/mimo-auto', 'mimo/mimo-auto/high', 'xiaomi/mimo-v2.6-pro', 'xiaomi/mimo-v2.6-pro/low', 'xiaomi/mimo-v2.6-pro/high', 'xiaomi/mimo-v2.6-flash'];
const config = () => [
  { id: 'model', category: 'model', type: 'select', currentValue: state.model, options: MODELS.map((value) => ({ value, name: value })) },
  { id: 'mode', category: 'mode', type: 'select', currentValue: state.mode, options: ['build', 'plan', 'ask'].map((value) => ({ value, name: value })) },
];
const ask = (method, params) => new Promise((resolve) => {
  const id = ++nextId;
  pending.set(id, resolve);
  send({ id, method, params });
});

async function handle(message) {
  if (message.id !== undefined && !message.method) {
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve?.(message.result ?? message.error);
    return;
  }
  const { id, method, params } = message;
  log({ method, params, ...(method === 'initialize' ? { configContent: process.env.MIMOCODE_CONFIG_CONTENT } : {}) });
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  } else if (method === 'session/new') {
    send({ id, result: { sessionId: 'ses_fresh', configOptions: config(), modes: { currentModeId: state.mode, availableModes: [] } } });
    update('ses_fresh', { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'review changes' }] });
    update('ses_fresh', { sessionUpdate: 'usage_update', used: 0, size: 1048576, cost: { amount: state.cost, currency: 'USD' } });
  } else if (method === 'session/load') {
    const sid = params.sessionId;
    update(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old prompt' } });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED ANSWER' } });
    update(sid, { sessionUpdate: 'usage_update', used: 4321, size: 1048576, cost: { amount: 0.5, currency: 'USD' } });
    send({ id, result: { configOptions: config(), modes: { currentModeId: state.mode, availableModes: [] } } });
  } else if (method === 'session/set_mode') {
    state.mode = params.modeId;
    send({ id, result: {} });
  } else if (method === 'session/set_config_option') {
    if (params.configId === 'model') {
      if (!MODELS.includes(params.value)) {
        send({ id, error: { code: -32602, message: 'Invalid params' } });
        return;
      }
      state.model = params.value;
    }
    send({ id, result: { configOptions: config() } });
  } else if (method === 'session/prompt' && String(params.prompt?.[0]?.text).startsWith('FAIL')) {
    // A failed model call: nothing streamed, zero usage, plain end_turn.
    update(params.sessionId, { sessionUpdate: 'usage_update', used: 0, size: 1048576, cost: { amount: state.cost, currency: 'USD' } });
    send({ id, result: { stopReason: 'end_turn', usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 }, _meta: {} } });
  } else if (method === 'session/prompt') {
    const sid = params.sessionId;
    update(sid, { sessionUpdate: 'agent_thought_chunk', messageId: 'm1', content: { type: 'text', text: 'thinking' } });
    update(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'Editing.' } });
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'call_edit', title: 'edit', kind: 'edit', status: 'pending', locations: [], rawInput: {} });
    const editInput = { filePath: '/tmp/a.ts', oldString: 'a', newString: 'b' };
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call_edit', status: 'in_progress', kind: 'edit', title: 'edit', rawInput: editInput });
    const decision = await ask('session/request_permission', {
      sessionId: sid,
      toolCall: { toolCallId: 'call_edit', status: 'pending', title: 'edit', kind: 'edit', rawInput: { filepath: '/tmp/a.ts', diff: '-a\\n+b' } },
      options: [
        { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
        { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
      ],
    });
    log({ method: 'permission_response', params: decision });
    const written = await ask('fs/write_text_file', { sessionId: sid, path: '/tmp/a.ts', content: 'b' });
    log({ method: 'write_text_file_response', params: written });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call_edit', status: 'completed', kind: 'edit', title: 'a.ts', rawInput: editInput, content: [{ type: 'content', content: { type: 'text', text: 'Edit applied.' } }, { type: 'diff', path: '/tmp/a.ts', oldText: 'a', newText: 'b' }] });
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'call_bash', title: 'bash', kind: 'execute', status: 'pending', locations: [], rawInput: {} });
    const bashInput = { command: 'echo hi', description: 'Say hi' };
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call_bash', status: 'in_progress', kind: 'execute', title: 'bash', rawInput: bashInput, content: [{ type: 'content', content: { type: 'text', text: 'line1' } }] });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call_bash', status: 'in_progress', kind: 'execute', title: 'bash', rawInput: bashInput, content: [{ type: 'content', content: { type: 'text', text: 'line1\\nline2' } }] });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call_bash', status: 'completed', kind: 'execute', title: 'Say hi', rawInput: bashInput, content: [{ type: 'content', content: { type: 'text', text: 'line1\\nline2' } }] });
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 'call_grep', title: 'grep', kind: 'search', status: 'pending', locations: [], rawInput: {} });
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'call_grep', status: 'failed', kind: 'search', title: 'grep', rawInput: { pattern: 'x', include: '*.ts' }, content: [{ type: 'content', content: { type: 'text', text: 'boom' } }] });
    update(sid, { sessionUpdate: 'agent_message_chunk', messageId: 'm2', content: { type: 'text', text: 'Done.' } });
    state.cost += 0.0025;
    update(sid, { sessionUpdate: 'usage_update', used: 30000, size: 1048576, cost: { amount: state.cost, currency: 'USD' } });
    send({ id, result: { stopReason: 'end_turn', usage: { totalTokens: 31000, inputTokens: 1000, outputTokens: 200, cachedReadTokens: 29000, cachedWriteTokens: 800 }, _meta: {} } });
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
process.env.MIMO_CLI_PATH = fakeAgentPath;
process.env.MIMOCODE_DB = dbPath;

// MiMo's message table, as the CLI stores it: the failed turn's assistant
// message carries the API error.
{
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT NOT NULL DEFAULT 'main',
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
  db.close();
}

function recordFailedTurn(sessionId: string, error = { name: 'APIError', data: { message: 'Invalid API Key: Please provide valid API Key', statusCode: 401 } }): void {
  const db = new Database(dbPath);
  // Stamped ahead: the turn reads only messages created after it started.
  const now = Date.now() + 1000;
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
    `msg_${now}`,
    sessionId,
    now,
    now,
    JSON.stringify({
      role: 'assistant',
      tokens: { input: 0, output: 0 },
      error,
    })
  );
  db.close();
}

type Event = { type: string; [key: string]: unknown };

function clearFailedTurns(): void {
  const db = new Database(dbPath);
  db.exec("DELETE FROM message WHERE json_extract(data, '$.error') IS NOT NULL");
  db.close();
}

function readCalls(): Array<{ method: string; params: Record<string, unknown>; configContent?: string }> {
  try {
    return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function resetCalls(): void {
  writeFileSync(logPath, '');
}

function withTimeout<T>(promise: Promise<T>, label: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function messages(events: Event[]): Array<Record<string, unknown>> {
  return events.filter((event) => event.type === 'message').map((event) => event.message as Record<string, unknown>);
}

function contentBlocks(events: Event[], type: string): Array<Record<string, unknown>> {
  return messages(events)
    .filter((message) => message.type === 'assistant')
    .flatMap((message) => ((message.message as { content: Array<Record<string, unknown>> }).content))
    .filter((block) => block.type === type);
}

async function main(): Promise<void> {
  const { MimoAcpAdapter, splitMimoModelValue, mimoToolInput, MIMO_AEGIS_CONFIG } = await import(
    '../../src/electron/libs/provider/mimo-acp-adapter'
  );
  const { parseMimoModelList, parseMimoSkillList } = await import('../../src/electron/libs/mimo-cli');

  // ── Pure helpers ──────────────────────────────────────────────────────────
  {
    const values = new Set(['xiaomi/mimo-v2.6-pro', 'xiaomi/mimo-v2.6-pro/high', 'openrouter/anthropic/claude']);
    assert.deepEqual(splitMimoModelValue('xiaomi/mimo-v2.6-pro/high', values), { model: 'xiaomi/mimo-v2.6-pro', effort: 'high' });
    assert.deepEqual(splitMimoModelValue('xiaomi/mimo-v2.6-pro', values), { model: 'xiaomi/mimo-v2.6-pro' });
    // A slash inside the model id is not a variant when the prefix is no model.
    assert.deepEqual(splitMimoModelValue('openrouter/anthropic/claude', values), { model: 'openrouter/anthropic/claude' });
    assert.deepEqual(mimoToolInput('Grep', { pattern: 'x', include: '*.ts' }), { pattern: 'x', glob: '*.ts' });

    const listing = [
      'mimo/mimo-auto — window 1M, compacts at 900K',
      '{ "id": "mimo-auto", "providerID": "mimo", "name": "MiMo Auto", "limit": { "context": 1000000 }, "variants": { "high": {} } }',
      'xiaomi/mimo-v2.6-pro — window 1.05M, compacts at 944K',
      '{', '  "id": "mimo-v2.6-pro",', '  "name": "MiMo-V2.6-Pro",', '  "limit": { "context": 1048576 },',
      '  "variants": { "low": { "reasoningEffort": "low" }, "medium": {}, "high": {} }', '}',
      'anthropic/claude — window 200K', '{ "id": "claude", "name": "MiMo Auto" }',
    ].join('\n');
    assert.deepEqual(parseMimoModelList(listing), [
      { id: 'mimo/mimo-auto', label: 'MiMo Auto (mimo)', reasoningEfforts: ['high'], contextWindow: 1000000 },
      { id: 'xiaomi/mimo-v2.6-pro', label: 'MiMo-V2.6-Pro', reasoningEfforts: ['low', 'medium', 'high'], contextWindow: 1048576 },
      { id: 'anthropic/claude', label: 'MiMo Auto (anthropic)', reasoningEfforts: [] },
    ]);
  }

  // ── Skill listing (`GET /skill`) ─────────────────────────────────────────
  {
    const home = process.env.HOME || '';
    const skills = parseMimoSkillList(
      [
        { name: 'zeta', description: 'User skill', location: `${home}/.agents/skills/zeta/SKILL.md`, content: 'Z' },
        { name: 'arxiv', description: 'Builtin', location: `${home}/.local/share/mimocode/builtin_skills/0.1.14/skills/arxiv/SKILL.md`, content: 'A' },
        { name: 'local', description: '', location: '/repo/.mimocode/skills/local/SKILL.md', content: 'L' },
        { name: 'shipped', description: 'Bundled', location: '/opt/elsewhere/SKILL.md', content: 'S', bundled: true },
        { name: 'zeta', description: 'Duplicate', location: '/elsewhere/SKILL.md', content: 'dup' },
        { description: 'no name' },
      ],
      '/repo'
    );
    assert.deepEqual(
      skills.map((skill) => [skill.name, skill.scope, skill.content]),
      [['arxiv', 'system', 'A'], ['local', 'project', 'L'], ['shipped', 'system', 'S'], ['zeta', 'user', 'Z']]
    );
    assert.equal(skills.find((skill) => skill.name === 'local')?.description, undefined);
  }

  // ── New session + one turn ────────────────────────────────────────────────
  {
    resetCalls();
    const adapter = new MimoAcpAdapter();
    const events: Event[] = [];
    adapter.events.on('event', (event: Event) => {
      events.push(event);
      if (event.type === 'permission_request') {
        void adapter.respondToRequest('t1', event.requestId as string, { behavior: 'allow', updatedInput: {} });
      }
    });

    const session = await withTimeout(
      adapter.startSession({
        threadId: 't1',
        cwd: dir,
        prompt: '',
        model: 'xiaomi/mimo-v2.6-pro',
        mimoReasoningEffort: 'high',
        mimoPermissionMode: 'ask',
      }),
      'startSession'
    );
    assert.equal(session.providerSessionId, 'ses_fresh');
    assert.equal(session.model, 'xiaomi/mimo-v2.6-pro', 'the reported model is the base id, variant stripped');

    const calls = readCalls();
    assert.deepEqual(JSON.parse(calls.find((call) => call.method === 'initialize')!.configContent!), MIMO_AEGIS_CONFIG);
    assert.deepEqual(calls.find((call) => call.method === 'initialize')!.params.clientCapabilities, {});
    const mcpServers = calls.find((call) => call.method === 'session/new')!.params.mcpServers as Array<Record<string, unknown>>;
    assert.equal(mcpServers.length, 1, 'chat sessions get the Aegis session MCP server');
    assert.equal(mcpServers[0].type, 'http');
    assert.equal(mcpServers[0].name, 'aegis-sessions');
    assert.ok(
      (mcpServers[0].headers as Array<{ name: string; value: string }>).some((header) => header.name === 'Authorization' && header.value.startsWith('Bearer ')),
      'the session MCP endpoint is called with its bearer token'
    );
    assert.deepEqual(
      calls.filter((call) => call.method === 'session/set_config_option').map((call) => call.params.value),
      ['xiaomi/mimo-v2.6-pro/high'],
      'model and reasoning level are one select value'
    );
    assert.deepEqual(calls.filter((call) => call.method === 'session/set_mode').map((call) => call.params.modeId), ['ask']);

    // Startup state that arrived before the bind is applied once bound.
    const commandsUpdate = messages(events).find((message) => message.subtype === 'available_commands_update');
    assert.deepEqual(commandsUpdate?.availableCommands, [{ name: 'review', description: 'review changes' }]);

    resetCalls();
    await withTimeout(
      adapter.sendTurn({ threadId: 't1', prompt: 'go', model: 'xiaomi/mimo-v2.6-pro', mimoReasoningEffort: 'high', mimoPermissionMode: 'ask' }),
      'sendTurn'
    );
    const turnCalls = readCalls();
    assert.equal(turnCalls.filter((call) => call.method === 'session/set_config_option').length, 0, 'unchanged config is not re-sent');
    assert.equal(turnCalls.filter((call) => call.method === 'session/set_mode').length, 0);
    assert.deepEqual(turnCalls.find((call) => call.method === 'permission_response')?.params, {
      outcome: { outcome: 'selected', optionId: 'once' },
    });
    assert.deepEqual(turnCalls.find((call) => call.method === 'write_text_file_response')?.params, {}, 'fs/write_text_file is acknowledged');

    const permission = events.find((event) => event.type === 'permission_request')!;
    assert.equal(permission.toolName, 'Edit');
    const permissionInput = permission.input as Record<string, unknown>;
    assert.equal(permissionInput.provider, 'mimo');
    assert.equal(permissionInput.title, 'Edit /tmp/a.ts');
    assert.deepEqual((permissionInput.toolCall as Record<string, unknown>).rawInput, {
      file_path: '/tmp/a.ts',
      old_string: 'a',
      new_string: 'b',
    });

    const toolUses = contentBlocks(events, 'tool_use');
    const lastInput = (id: string) => toolUses.filter((block) => block.id === id).at(-1)?.input;
    assert.deepEqual(lastInput('call_edit'), { file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b' });
    assert.equal(toolUses.find((block) => block.id === 'call_bash')?.name, 'Bash');
    assert.deepEqual(lastInput('call_bash'), { command: 'echo hi', description: 'Say hi' });
    assert.deepEqual(lastInput('call_grep'), { pattern: 'x', glob: '*.ts' });

    const deltas = events.filter((event) => event.type === 'tool_output_delta').map((event) => event.delta);
    assert.deepEqual(deltas, ['line1', '\nline2'], 'cumulative bash snapshots stream as suffixes');

    const results = contentBlocks(events, 'tool_result');
    const result = (id: string) => results.find((block) => block.tool_use_id === id);
    assert.equal(result('call_edit')?.content, 'Edit applied.');
    assert.equal(result('call_bash')?.content, 'line1\nline2');
    assert.equal(result('call_grep')?.is_error, true);

    const texts = contentBlocks(events, 'text').map((block) => block.text);
    assert.deepEqual(texts, ['Editing.', 'Done.']);

    const turnResult = messages(events).find((message) => message.type === 'result')!;
    assert.equal(turnResult.subtype, 'success');
    assert.ok(Math.abs((turnResult.total_cost_usd as number) - 0.0025) < 1e-9, 'turn cost is the running-cost delta');
    assert.deepEqual(turnResult.usage, {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 29000,
      cache_creation_input_tokens: 800,
      total_tokens: 31000,
    });
    const ring = messages(events).filter((message) => message.subtype === 'token_usage').at(-1)!;
    assert.deepEqual(
      { used: (ring.usage as Record<string, number>).totalTokens, size: (ring.usage as Record<string, number>).contextWindow },
      { used: 30000, size: 1048576 }
    );

    // Switching the level alone re-selects the model value.
    resetCalls();
    await withTimeout(
      adapter.sendTurn({ threadId: 't1', prompt: 'FAIL quietly', model: 'xiaomi/mimo-v2.6-pro', mimoReasoningEffort: 'low', mimoPermissionMode: 'plan' }),
      'level switch'
    );
    assert.deepEqual(
      readCalls().filter((call) => call.method === 'session/set_config_option').map((call) => call.params.value),
      ['xiaomi/mimo-v2.6-pro/low']
    );
    assert.deepEqual(readCalls().filter((call) => call.method === 'session/set_mode').map((call) => call.params.modeId), ['plan']);

    // A silent turn with nothing stored is not an error.
    assert.equal(events.filter((event) => event.type === 'error').length, 0);

    // A silent turn whose model call failed surfaces MiMo's stored error.
    recordFailedTurn('ses_fresh');
    const before = events.length;
    await withTimeout(adapter.sendTurn({ threadId: 't1', prompt: 'FAIL loudly' }), 'failed turn');
    const failure = events.slice(before).find((event) => event.type === 'error');
    assert.match(String((failure?.error as Error)?.message), /Invalid API Key/);
    const failedResult = messages(events.slice(before)).find((message) => message.type === 'result');
    assert.equal(failedResult?.subtype, 'error');
    clearFailedTurns();

    // A content-filtered reply streams a refusal and still ends with
    // end_turn; the stored error must surface anyway.
    recordFailedTurn('ses_fresh', { name: 'ContentFilterError', data: { message: "The response was withheld by the model provider's content safety filter." } });
    const filteredStart = events.length;
    await withTimeout(adapter.sendTurn({ threadId: 't1', prompt: 'go filtered' }), 'filtered turn');
    const filtered = events.slice(filteredStart);
    assert.ok(contentBlocks(filtered, 'text').length > 0, 'the streamed reply still renders');
    assert.match(String((filtered.find((event) => event.type === 'error')?.error as Error)?.message), /content safety filter/);
    clearFailedTurns();

    // Every model step is its own stored message; the turn's usage sums them,
    // not just the last step ACP reports.
    {
      const db = new Database(dbPath);
      const at = Date.now() + 2000;
      const insert = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)');
      insert.run('step_1', 'ses_fresh', at, at, JSON.stringify({ role: 'assistant', cost: 0.007, tokens: { input: 49912, output: 34, reasoning: 15, cache: { read: 0, write: 0 } } }));
      insert.run('step_2', 'ses_fresh', at + 1, at + 1, JSON.stringify({ role: 'assistant', cost: 0.0002, tokens: { input: 250, output: 3, reasoning: 21, cache: { read: 50432, write: 0 } } }));
      insert.run('older', 'ses_fresh', 1, 1, JSON.stringify({ role: 'assistant', cost: 9, tokens: { input: 999999, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }));
      db.close();
      const start = events.length;
      await withTimeout(adapter.sendTurn({ threadId: 't1', prompt: 'go again' }), 'summed turn');
      const summed = messages(events.slice(start)).find((message) => message.type === 'result')!;
      assert.deepEqual(summed.usage, {
        input_tokens: 50162,
        output_tokens: 73,
        cache_read_input_tokens: 50432,
        cache_creation_input_tokens: 0,
        total_tokens: 100667,
      });
      assert.ok(Math.abs((summed.total_cost_usd as number) - 0.0072) < 1e-9);
      const clear = new Database(dbPath);
      clear.exec("DELETE FROM message WHERE id IN ('step_1', 'step_2', 'older')");
      clear.close();
    }

    // A variant the model does not offer falls back to the base model.
    resetCalls();
    await withTimeout(
      adapter.sendTurn({ threadId: 't1', prompt: 'FAIL', model: 'xiaomi/mimo-v2.6-flash', mimoReasoningEffort: 'high' }),
      'model switch'
    );
    assert.deepEqual(
      readCalls().filter((call) => call.method === 'session/set_config_option').map((call) => call.params.value),
      ['xiaomi/mimo-v2.6-flash']
    );

    await adapter.stopAll();
  }

  // ── Resume: the load replay is dropped, startup usage kept ────────────────
  {
    resetCalls();
    const adapter = new MimoAcpAdapter();
    const events: Event[] = [];
    adapter.events.on('event', (event: Event) => events.push(event));
    const session = await withTimeout(
      adapter.startSession({ threadId: 't2', cwd: dir, prompt: '', resumeSessionId: 'ses_old' }),
      'resume'
    );
    assert.equal(session.providerSessionId, 'ses_old');
    assert.equal(contentBlocks(events, 'text').length, 0, 'replayed transcript must not re-render');
    assert.equal(
      events.filter((event) => event.type === 'message' && (event.message as Record<string, unknown>).type === 'stream_event').length,
      0
    );
    const ring = messages(events).find((message) => message.subtype === 'token_usage');
    assert.equal((ring?.usage as Record<string, number>).totalTokens, 4321);
    assert.equal(readCalls().filter((call) => call.method === 'session/set_mode').length, 0, 'no mode requested, none set');
    await adapter.stopAll();
  }

  console.log('mimo-acp-adapter: all checks passed');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
