// Runtime tests for cross-agent delegation (docs/delegate-mcp-plan.md):
// the delegate-service core (attribution, depth guard, permission
// inheritance, mirror pipeline, blocking run loop) plus the renderer
// predicates that make delegate calls render as subagent capsules.

import assert from 'node:assert/strict';
import {
  __resetDelegateServiceForTests,
  applyPermissionTier,
  applyReasoningEffort,
  buildDelegateSummary,
  findPendingDelegateCall,
  hasActiveDelegationForParent,
  initializeDelegateService,
  isDelegateExecutionSession,
  isDelegateToolUseName,
  mirrorDelegateMessage,
  resolveDelegateModelId,
  resolveParentPermissionTier,
  runDelegateTask,
  transformDelegateMessage,
  type DelegateHost,
} from '../../src/electron/libs/delegate-service';
import type { SessionRow } from '../../src/electron/types';
import type { SessionStartPayload, StreamMessage } from '../../src/shared/types';
import { classifyToolUse } from '../../src/ui/utils/tool-summary';
import {
  formatDelegateModelDisplay,
  getDelegateAgentFromBlock,
  getDelegateCallInfo,
  isSubagentTaskBlock,
  latestTurnHasPendingDelegation,
} from '../../src/ui/utils/workstream';
import type { ContentBlock } from '../../src/ui/types';

const DELEGATE_NAME = 'mcp__aegis-delegate__delegate_task';

function assistantWithToolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
  extra?: Partial<StreamMessage>
): StreamMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input }] },
    ...extra,
  } as unknown as StreamMessage;
}

function userWithToolResult(toolUseId: string): StreamMessage {
  return {
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
  } as unknown as StreamMessage;
}

function makeRow(overrides: Partial<SessionRow>): SessionRow {
  return {
    id: 'row',
    title: 't',
    status: 'running',
    provider: 'claude',
    cwd: '/tmp/project',
    project_cwd: '/tmp/project',
    conversation_scope: 'project',
    ...overrides,
  } as unknown as SessionRow;
}

async function testToolNameRecognition() {
  assert.equal(isDelegateToolUseName('delegate_task'), true);
  assert.equal(isDelegateToolUseName(DELEGATE_NAME), true);
  assert.equal(isDelegateToolUseName('mcp__other__some_tool'), false);
  assert.equal(isDelegateToolUseName('Task'), false);
  console.log('PASS: delegate tool name recognition');
}

async function testAttributionMatcher() {
  const match = { agent: 'codex', prompt: 'review the diff' };
  const history: StreamMessage[] = [
    assistantWithToolUse('t1', DELEGATE_NAME, { agent: 'codex', prompt: 'review the diff' }),
    userWithToolResult('t1'),
    assistantWithToolUse('t2', DELEGATE_NAME, { agent: 'codex', prompt: 'review the diff' }),
    assistantWithToolUse('t3', DELEGATE_NAME, { agent: 'kimi', prompt: 'review the diff' }),
    // Subagent-issued delegate calls never anchor (depth guard renders them
    // moot, but the matcher must not misattribute either).
    assistantWithToolUse('t4', DELEGATE_NAME, { agent: 'codex', prompt: 'review the diff' }, {
      parentToolUseId: 'other',
    }),
  ];
  assert.equal(findPendingDelegateCall(history, match, new Set()), 't2', 'latest unresolved match wins');
  assert.equal(findPendingDelegateCall(history, match, new Set(['t2'])), null, 'claimed ids are skipped');
  assert.equal(
    findPendingDelegateCall(history, { agent: 'grok', prompt: 'review the diff' }, new Set()),
    null,
    'agent must match'
  );
  console.log('PASS: attribution matcher');
}

async function testPermissionInheritance() {
  assert.equal(resolveParentPermissionTier(makeRow({ claude_access_mode: 'bypassPermissions' })), 'full');
  assert.equal(resolveParentPermissionTier(makeRow({ claude_access_mode: 'acceptEdits' })), 'autoEdit');
  assert.equal(resolveParentPermissionTier(makeRow({ claude_access_mode: 'default' })), 'safe');
  assert.equal(
    resolveParentPermissionTier(makeRow({ provider: 'codex', codex_permission_mode: 'fullAccess' })),
    'full'
  );
  assert.equal(
    resolveParentPermissionTier(makeRow({ provider: 'codex', codex_permission_mode: 'auto' })),
    'autoEdit'
  );
  assert.equal(resolveParentPermissionTier(null), 'safe');

  const payload = { title: 'x', prompt: 'y' } as SessionStartPayload;
  applyPermissionTier(payload, 'codex', 'full');
  assert.equal(payload.codexPermissionMode, 'fullAccess');
  applyPermissionTier(payload, 'claude', 'full');
  assert.equal(payload.claudeAccessMode, 'bypassPermissions');
  applyPermissionTier(payload, 'kimi', 'full');
  assert.equal(payload.kimiPermissionMode, 'yolo');
  applyPermissionTier(payload, 'claude', 'autoEdit');
  assert.equal(payload.claudeAccessMode, 'acceptEdits');
  applyPermissionTier(payload, 'opencode', 'safe');
  assert.equal(payload.opencodePermissionMode, 'defaultPermissions');

  // Reasoning effort routes to the target provider's own field, as an open
  // string (no whitelists — tiers are provider/model-specific).
  const effortPayload = { title: 'x', prompt: 'y' } as SessionStartPayload;
  applyReasoningEffort(effortPayload, 'codex', 'xhigh');
  assert.equal(effortPayload.codexReasoningEffort, 'xhigh');
  applyReasoningEffort(effortPayload, 'claude', 'high');
  assert.equal(effortPayload.claudeReasoningEffort, 'high');
  applyReasoningEffort(effortPayload, 'kimi', 'max');
  assert.equal(effortPayload.kimiThinking, 'max');
  console.log('PASS: permission inheritance mapping');
}

async function testMirrorTransform() {
  const exec = {
    parentToolUseId: 'anchor-1',
    agent: 'codex' as const,
    actualModel: 'gpt-5.6-sol',
    requestedModel: 'gpt-5.6',
  };
  const assistant = assistantWithToolUse('c1', 'Edit', { file_path: '/tmp/a.ts' });
  const mirrored = transformDelegateMessage(exec, assistant);
  assert.ok(mirrored, 'assistant messages mirror');
  assert.equal(mirrored?.parentToolUseId, 'anchor-1');
  assert.equal(mirrored?.sourceProvider, 'codex');
  assert.equal(mirrored?.sourceModel, 'gpt-5.6-sol', 'effective model wins over requested');
  assert.equal(
    transformDelegateMessage({ parentToolUseId: 'a', agent: 'codex' }, assistant)?.sourceModel,
    null,
    'no model info → null, not undefined-ish leakage'
  );

  const user = userWithToolResult('c1');
  assert.ok(transformDelegateMessage(exec, user), 'user messages mirror');

  const streamEvent = { type: 'stream_event', event: {} } as unknown as StreamMessage;
  assert.equal(transformDelegateMessage(exec, streamEvent), null, 'stream_events never mirror');
  const system = { type: 'system', subtype: 'init' } as unknown as StreamMessage;
  assert.equal(transformDelegateMessage(exec, system), null, 'system messages never mirror');
  console.log('PASS: mirror transform');
}

interface FakeWorld {
  parentRow: SessionRow;
  parentHistory: StreamMessage[];
  mirrored: Array<{ sessionId: string; message: StreamMessage }>;
  startPayloads: SessionStartPayload[];
  stops: string[];
  execStatus: string;
  host: DelegateHost;
}

function makeWorld(): FakeWorld {
  const world: FakeWorld = {
    parentRow: makeRow({ id: 'parent-1', claude_access_mode: 'bypassPermissions' }),
    parentHistory: [],
    mirrored: [],
    startPayloads: [],
    stops: [],
    execStatus: 'running',
    host: null as unknown as DelegateHost,
  };
  world.host = {
    startSession: async (payload) => {
      world.startPayloads.push(payload);
      return 'exec-1';
    },
    stopSession: (sessionId) => {
      world.stops.push(sessionId);
      world.execStatus = 'idle';
    },
    getSession: (sessionId) => {
      if (sessionId === 'parent-1') return world.parentRow;
      if (sessionId === 'exec-1') {
        return makeRow({ id: 'exec-1', status: world.execStatus, provider: 'codex' });
      }
      return null;
    },
    getSessionHistory: (sessionId) => (sessionId === 'parent-1' ? world.parentHistory : []),
    listRunningSessionIds: () => ['parent-1'],
    addMessageToSession: (sessionId, message) => {
      world.mirrored.push({ sessionId, message });
    },
  };
  return world;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function testRejections() {
  __resetDelegateServiceForTests();
  const world = makeWorld();
  initializeDelegateService(world.host);

  const unknown = await runDelegateTask({ agent: 'nonsense', prompt: 'x', callerSessionId: 'parent-1' });
  assert.equal(unknown.status, 'rejected');
  assert.match(unknown.summary, /Unknown agent/);

  const empty = await runDelegateTask({ agent: 'codex', prompt: '   ', callerSessionId: 'parent-1' });
  assert.equal(empty.status, 'rejected');

  const orphanHttp = await runDelegateTask(
    { agent: 'codex', prompt: 'no such pending call', callerSessionId: null },
    { attributionTimeoutMs: 300 }
  );
  assert.equal(orphanHttp.status, 'rejected', 'HTTP callers without a matching pending call are refused');
  console.log('PASS: rejection paths');
}

async function testHappyPathAndLocks() {
  __resetDelegateServiceForTests();
  const world = makeWorld();
  initializeDelegateService(world.host);
  world.parentHistory.push(
    assistantWithToolUse('anchor-1', DELEGATE_NAME, { agent: 'codex', prompt: 'review the diff' })
  );

  const resultPromise = runDelegateTask({
    agent: 'codex',
    prompt: 'review the diff',
    model: 'gpt-5.6',
    reasoningEffort: 'high',
    callerSessionId: 'parent-1',
  });
  await sleep(100);

  // Execution registered: steer lock + depth guard are live.
  assert.equal(hasActiveDelegationForParent('parent-1'), true, 'steer lock engages while running');
  assert.equal(isDelegateExecutionSession('exec-1'), true);
  const chained = await runDelegateTask({ agent: 'kimi', prompt: 'go deeper', callerSessionId: 'exec-1' });
  assert.equal(chained.status, 'rejected', 'chained delegation is refused');
  assert.match(chained.summary, /Chained delegation/);

  // Permission inheritance landed in the child payload.
  assert.equal(world.startPayloads.length, 1);
  const payload = world.startPayloads[0];
  assert.equal(payload.provider, 'codex');
  assert.equal(payload.codexPermissionMode, 'fullAccess', 'bypass parent → fullAccess codex child');
  assert.equal(payload.hiddenFromThreads, true);
  assert.equal(payload.skipTitleGeneration, true);
  assert.equal(payload.cwd, '/tmp/project');
  assert.equal(payload.model, 'gpt-5.6', 'requested model reaches the child payload');
  assert.equal(payload.codexReasoningEffort, 'high', 'requested effort routes to the codex field');

  // The child runtime's init reports the model it actually resolved; mirrored
  // messages carry it from then on.
  const handledInit = mirrorDelegateMessage('exec-1', {
    type: 'system',
    subtype: 'init',
    model: 'gpt-5.6-sol',
  } as unknown as StreamMessage);
  assert.equal(handledInit, true, 'system init is handled (swallowed, model captured)');

  // Child messages mirror into the parent with the anchor id; stream_events
  // are swallowed.
  const handledAssistant = mirrorDelegateMessage(
    'exec-1',
    assistantWithToolUse('c1', 'Edit', { file_path: '/tmp/project/a.ts' })
  );
  const handledText = mirrorDelegateMessage('exec-1', {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Reviewed. Two issues found.' }] },
  } as unknown as StreamMessage);
  const handledStream = mirrorDelegateMessage('exec-1', {
    type: 'stream_event',
    event: {},
  } as unknown as StreamMessage);
  assert.equal(handledAssistant && handledText && handledStream, true, 'all exec messages are handled');
  assert.equal(world.mirrored.length, 2, 'stream_event/init swallowed, assistant messages mirrored');
  assert.equal(world.mirrored[0].sessionId, 'parent-1');
  assert.equal(world.mirrored[0].message.parentToolUseId, 'anchor-1');
  assert.equal(world.mirrored[0].message.sourceProvider, 'codex');
  assert.equal(world.mirrored[0].message.sourceModel, 'gpt-5.6-sol', 'mirrored messages carry the effective model');

  world.execStatus = 'completed';
  const result = await resultPromise;
  assert.equal(result.ok, true);
  assert.equal(result.status, 'completed');
  assert.match(result.summary, /Reviewed\. Two issues found\./);
  assert.match(result.summary, /a\.ts/, 'summary lists changed files');
  assert.equal(hasActiveDelegationForParent('parent-1'), false, 'steer lock releases on settle');
  assert.equal(isDelegateExecutionSession('exec-1'), false);
  console.log('PASS: happy path, mirror, steer lock, depth guard');
}

async function testTimeout() {
  __resetDelegateServiceForTests();
  const world = makeWorld();
  initializeDelegateService(world.host);
  world.parentHistory.push(
    assistantWithToolUse('anchor-2', DELEGATE_NAME, { agent: 'codex', prompt: 'never finishes' })
  );
  const result = await runDelegateTask(
    { agent: 'codex', prompt: 'never finishes', callerSessionId: 'parent-1' },
    { timeoutMs: 1200 }
  );
  assert.equal(result.status, 'timeout');
  assert.deepEqual(world.stops, ['exec-1'], 'timed-out execution is stopped');
  assert.match(result.summary, /timed out/);
  console.log('PASS: timeout stops the execution');
}

async function testHttpAttribution() {
  __resetDelegateServiceForTests();
  const world = makeWorld();
  initializeDelegateService(world.host);
  world.parentHistory.push(
    assistantWithToolUse('anchor-3', DELEGATE_NAME, { agent: 'kimi', prompt: 'summarize' })
  );
  const resultPromise = runDelegateTask({ agent: 'kimi', prompt: 'summarize', callerSessionId: null });
  await sleep(100);
  assert.equal(hasActiveDelegationForParent('parent-1'), true, 'HTTP caller attributed via pending call');
  world.execStatus = 'completed';
  const result = await resultPromise;
  assert.equal(result.status, 'completed');
  assert.equal(world.startPayloads[0]?.provider, 'kimi');
  console.log('PASS: HTTP-caller attribution');
}

async function testModelResolution() {
  const kimiCatalog = [
    { id: 'kimi-code/k3', label: 'Kimi Code K3' },
    { id: 'kimi-code/k2.5', label: 'Kimi Code K2.5' },
  ];
  // The exact failure observed in the wild: the lead invented "kimi-k3-thinking".
  assert.equal(resolveDelegateModelId('kimi-k3-thinking', kimiCatalog).id, 'kimi-code/k3');
  assert.equal(resolveDelegateModelId('kimi code k3', kimiCatalog).id, 'kimi-code/k3');
  assert.equal(resolveDelegateModelId('k2.5', kimiCatalog).id, 'kimi-code/k2.5');
  assert.equal(resolveDelegateModelId('kimi-code/k3', kimiCatalog).id, 'kimi-code/k3', 'exact id wins');

  const codexCatalog = [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
    { id: 'gpt-5.3-codex-spark', label: 'GPT-5.3-Codex-Spark' },
  ];
  assert.equal(resolveDelegateModelId('gpt 5.6 sol', codexCatalog).id, 'gpt-5.6-sol');
  assert.equal(resolveDelegateModelId('sol', codexCatalog).id, 'gpt-5.6-sol');
  const ambiguous = resolveDelegateModelId('gpt 5.6', codexCatalog);
  assert.equal(ambiguous.id, null, 'gpt 5.6 alone is ambiguous');
  assert.deepEqual(ambiguous.ambiguous?.sort(), ['gpt-5.6-sol', 'gpt-5.6-terra']);
  assert.equal(resolveDelegateModelId('claude opus', codexCatalog).id, null, 'no overlap → no guess');
  assert.equal(
    resolveDelegateModelId('anything', []).id,
    'anything',
    'no catalog → pass through untouched'
  );
  console.log('PASS: fuzzy model resolution');
}

async function testModelResolutionInRun() {
  __resetDelegateServiceForTests();
  const world = makeWorld();
  world.host.listAgentModels = async () => [
    { id: 'kimi-code/k3', label: 'Kimi Code K3' },
    { id: 'kimi-code/k2.5', label: 'Kimi Code K2.5' },
  ];
  initializeDelegateService(world.host);
  world.parentHistory.push(
    assistantWithToolUse('anchor-m1', DELEGATE_NAME, { agent: 'kimi', prompt: 'analyze' })
  );

  // Unresolvable model → rejected fast WITH the catalog, before any child starts.
  const unknown = await runDelegateTask({
    agent: 'kimi',
    prompt: 'analyze',
    model: 'claude-opus-9',
    callerSessionId: 'parent-1',
  });
  assert.equal(unknown.status, 'rejected');
  assert.match(unknown.summary, /Unknown model "claude-opus-9"/);
  assert.match(unknown.summary, /kimi-code\/k3 \(Kimi Code K3\)/, 'catalog listed for retry');
  assert.equal(world.startPayloads.length, 0, 'no child session was started');

  // Fuzzy wording resolves to the exact catalog id before the child starts.
  const resultPromise = runDelegateTask({
    agent: 'kimi',
    prompt: 'analyze',
    model: 'kimi-k3-thinking',
    callerSessionId: 'parent-1',
  });
  await sleep(100);
  assert.equal(world.startPayloads[0]?.model, 'kimi-code/k3', 'fuzzy wording pinned to catalog id');
  world.execStatus = 'completed';
  await resultPromise;
  console.log('PASS: model resolution in runDelegateTask');
}

async function testErrorPassthrough() {
  __resetDelegateServiceForTests();
  const world = makeWorld();
  initializeDelegateService(world.host);
  world.parentHistory.push(
    assistantWithToolUse('anchor-e1', DELEGATE_NAME, { agent: 'codex', prompt: 'do it' })
  );
  const resultPromise = runDelegateTask({ agent: 'codex', prompt: 'do it', callerSessionId: 'parent-1' });
  await sleep(100);
  mirrorDelegateMessage('exec-1', {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: 'model not found: kimi-k3-thinking',
  } as unknown as StreamMessage);
  world.execStatus = 'error';
  const result = await resultPromise;
  assert.equal(result.status, 'error');
  assert.match(
    result.summary,
    /Error: model not found: kimi-k3-thinking/,
    'the child error reaches the lead so retries are informed'
  );
  console.log('PASS: child error text reaches the summary');
}

async function testChunkedFinalAnswer() {
  // Kimi commits one logical final answer as SEVERAL assistant messages (and
  // interleaves its own subagent tool results) — observed in the wild: the
  // lead received only the last fragment, starting mid-sentence.
  __resetDelegateServiceForTests();
  const world = makeWorld();
  initializeDelegateService(world.host);
  world.parentHistory.push(
    assistantWithToolUse('anchor-c1', DELEGATE_NAME, { agent: 'kimi', prompt: 'review files' })
  );
  const resultPromise = runDelegateTask({ agent: 'kimi', prompt: 'review files', callerSessionId: 'parent-1' });
  await sleep(100);

  const textMsg = (text: string) =>
    ({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) as unknown as StreamMessage;
  mirrorDelegateMessage('exec-1', textMsg('我并行派两个只读子代理分别全文评审。'));
  mirrorDelegateMessage('exec-1', assistantWithToolUse('t1', 'Read', { path: '/tmp/x.html' }));
  mirrorDelegateMessage('exec-1', userWithToolResult('t1'));
  mirrorDelegateMessage('exec-1', textMsg('已通读全文（941 行）。评审结论如下：'));
  mirrorDelegateMessage('exec-1', textMsg('**亮点** 零依赖单文件实现。'));
  mirrorDelegateMessage('exec-1', textMsg('**问题** 塞象眼+象不过河（L293–294）。'));

  world.execStatus = 'completed';
  const result = await resultPromise;
  assert.match(result.summary, /已通读全文（941 行）。评审结论如下：\n\*\*亮点\*\* 零依赖单文件实现。\n\*\*问题\*\*/,
    'chunked final answer is stitched back together in order');
  assert.doesNotMatch(result.summary, /并行派两个只读子代理/, 'narration before tool work is excluded');
  console.log('PASS: chunked final answer stitched');
}

async function testToolEndingFallback() {
  // A run whose last event is a tool call still surfaces its last narration.
  __resetDelegateServiceForTests();
  const world = makeWorld();
  initializeDelegateService(world.host);
  world.parentHistory.push(
    assistantWithToolUse('anchor-f1', DELEGATE_NAME, { agent: 'codex', prompt: 'write file' })
  );
  const resultPromise = runDelegateTask({ agent: 'codex', prompt: 'write file', callerSessionId: 'parent-1' });
  await sleep(100);
  mirrorDelegateMessage('exec-1', {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Writing the config now.' }] },
  } as unknown as StreamMessage);
  mirrorDelegateMessage('exec-1', assistantWithToolUse('t9', 'Write', { file_path: '/tmp/config.json' }));
  world.execStatus = 'completed';
  const result = await resultPromise;
  assert.match(result.summary, /Writing the config now\./, 'falls back to the last narration text');
  console.log('PASS: tool-ending run falls back to last narration');
}

async function testSummaryTruncation() {
  const exec = {
    execSessionId: 'exec-1',
    parentSessionId: 'parent-1',
    parentToolUseId: 'anchor',
    agent: 'codex' as const,
    startedAt: 0,
    finalTextRun: 'x'.repeat(10_000),
    lastAssistantText: '',
    changedFiles: new Set<string>(Array.from({ length: 60 }, (_, i) => `/tmp/f${i}.ts`)),
    mirroredCount: 0,
    settled: false,
    requestedModel: null,
    reasoningEffort: null,
    actualModel: null,
    errorText: null,
  };
  const summary = buildDelegateSummary(exec, 'completed');
  assert.ok(summary.includes('[truncated]'), 'long text is truncated');
  assert.ok(summary.length < 8_000, 'summary is bounded');
  assert.match(summary, /and 10 more/, 'file list is capped');
  console.log('PASS: summary truncation');
}

async function testRendererPredicates() {
  const delegateBlock = {
    type: 'tool_use',
    id: 'anchor-1',
    name: DELEGATE_NAME,
    input: { agent: 'codex', prompt: 'review the diff', description: 'codex review' },
  } as unknown as ContentBlock;

  assert.equal(classifyToolUse(DELEGATE_NAME, { agent: 'codex' }), 'subagent');
  assert.equal(classifyToolUse('delegate_task', { agent: 'codex' }), 'subagent');
  assert.equal(
    classifyToolUse('mcp__other__tool', {}),
    'mcp_tool_call',
    'other MCP tools keep their classification'
  );
  assert.equal(isSubagentTaskBlock(delegateBlock), true, 'delegate calls render as subagent capsules');
  assert.equal(getDelegateAgentFromBlock(delegateBlock), 'codex');

  // Panel model chip: requested model/effort from the anchor block, effective
  // model from the mirrored messages, formatted "gpt 5.6 sol high".
  const richBlock = {
    type: 'tool_use',
    id: 'anchor-2',
    name: DELEGATE_NAME,
    input: { agent: 'codex', prompt: 'x', model: 'gpt-5.6', reasoning_effort: 'high' },
  } as unknown as ContentBlock;
  assert.deepEqual(getDelegateCallInfo(richBlock), {
    agent: 'codex',
    model: 'gpt-5.6',
    reasoningEffort: 'high',
  });
  assert.equal(formatDelegateModelDisplay('gpt-5.6-sol', 'high'), 'gpt 5.6 sol high');
  assert.equal(formatDelegateModelDisplay('gpt-5.6-sol', null), 'gpt 5.6 sol');
  assert.equal(formatDelegateModelDisplay(null, 'high'), 'high');
  assert.equal(formatDelegateModelDisplay(null, null), '', 'nothing known → no chip');
  assert.equal(
    getDelegateAgentFromBlock({
      type: 'tool_use',
      id: 'x',
      name: 'Task',
      input: { subagent_type: 'Explore' },
    } as unknown as ContentBlock),
    null,
    'plain subagent Tasks are not delegates'
  );

  const messages: StreamMessage[] = [
    { type: 'user_prompt', prompt: 'go' } as unknown as StreamMessage,
    assistantWithToolUse('anchor-1', DELEGATE_NAME, { agent: 'codex', prompt: 'review the diff' }),
  ];
  assert.equal(latestTurnHasPendingDelegation(messages), true, 'pending delegate locks steer');
  messages.push(userWithToolResult('anchor-1'));
  assert.equal(latestTurnHasPendingDelegation(messages), false, 'resolved delegate unlocks steer');
  console.log('PASS: renderer predicates');
}

async function main() {
  await testToolNameRecognition();
  await testAttributionMatcher();
  await testPermissionInheritance();
  await testMirrorTransform();
  await testRejections();
  await testHappyPathAndLocks();
  await testTimeout();
  await testHttpAttribution();
  await testModelResolution();
  await testModelResolutionInRun();
  await testErrorPassthrough();
  await testChunkedFinalAnswer();
  await testToolEndingFallback();
  await testSummaryTruncation();
  await testRendererPredicates();
  console.log('delegate-mcp tests: ALL PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
