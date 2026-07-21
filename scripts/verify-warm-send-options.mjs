// Verifies the warm-dispatch option envelope: one unconditional, complete
// per-turn options object for every provider (the provider-conditional chain
// it replaced silently dropped grok's permission-mode switch).
// Requires `npm run transpile:electron` to have produced dist-electron.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function ok(message) {
  console.log(`  ✓ ${message}`);
}

// ── Envelope completeness: derived from ProviderSendTurnInput, no hand list ──
function providerTurnOptionKeys() {
  const source = readFileSync(
    join(__dirname, '../src/electron/libs/provider/types.ts'),
    'utf8'
  );
  const start = source.indexOf('export interface ProviderSendTurnInput {');
  assert.ok(start >= 0, 'ProviderSendTurnInput must exist');
  const block = source.slice(start, source.indexOf('}', start));
  const keys = [...block.matchAll(/^\s{2}(\w+)\?:/gm)].map((m) => m[1]);
  // Non-envelope keys: per-call payload, not per-turn provider options.
  const excluded = new Set(['attachments', 'model', 'codexSkills', 'codexMentions']);
  return keys.filter((key) => !excluded.has(key));
}

function testBuilder() {
  console.log('buildWarmSendOptions');
  const { buildWarmSendOptions } = require('../dist-electron/electron/libs/warm-send-options.js');

  const expectedKeys = providerTurnOptionKeys();
  const envelope = buildWarmSendOptions({});
  assert.deepEqual(
    Object.keys(envelope).sort(),
    [...expectedKeys].sort(),
    'envelope keys must equal ProviderSendTurnInput per-turn option keys'
  );
  ok(`envelope carries all ${expectedKeys.length} per-turn option keys (derived, not hand-listed)`);

  const built = buildWarmSendOptions({
    codexReasoningEffort: '',
    grokPermissionMode: 'plan',
    kimiPermissionMode: 'yolo',
    qoderPermissionMode: 'acceptEdits',
  });
  assert.strictEqual(built.codexReasoningEffort, undefined, "'' effort must become undefined");
  assert.equal(built.grokPermissionMode, 'plan');
  assert.equal(built.kimiPermissionMode, 'yolo');
  assert.equal(built.qoderPermissionMode, 'acceptEdits');
  assert.strictEqual(built.opencodePermissionMode, undefined);
  ok('values pass through per key; empty effort normalized to undefined');
}

// ── Source pins: the 3-link grok chain and the unconditional dispatch site ──
function testSourcePins() {
  console.log('source pins');
  const ipcSource = readFileSync(join(__dirname, '../src/electron/ipc-handlers.ts'), 'utf8');

  const callStart = ipcSource.indexOf('const sendOptions = buildWarmSendOptions({');
  assert.ok(callStart >= 0, 'warm dispatch must build the envelope via buildWarmSendOptions');
  const callBlock = ipcSource.slice(callStart, ipcSource.indexOf('});', callStart));
  assert.ok(!callBlock.includes('nextProvider ==='), 'envelope must be unconditional');
  for (const key of providerTurnOptionKeys()) {
    assert.match(
      callBlock,
      new RegExp(`${key}: next`),
      `dispatch envelope must pass ${key} from a next* local`
    );
  }
  ok('dispatch site: unconditional envelope, every key wired to a next* local');

  assert.match(
    ipcSource,
    /existingEntry\.grokPermissionMode = nextGrokPermissionMode/,
    'warm dispatch must write back entry.grokPermissionMode (no dead store)'
  );
  ok('grok entry snapshot written back after warm dispatch');

  // Link 2: agent-loop merges the per-turn value over the start-time value.
  const agentLoop = readFileSync(join(__dirname, '../src/electron/libs/agent-loop.ts'), 'utf8');
  assert.match(
    agentLoop,
    /grokPermissionMode: sendOptions\?\.grokPermissionMode \?\? options\.grokPermissionMode/,
    'agent-loop must merge per-turn grokPermissionMode'
  );
  // Link 3: the adapter applies the per-turn mode on every send.
  const grokAdapter = readFileSync(
    join(__dirname, '../src/electron/libs/provider/grok-acp-adapter.ts'),
    'utf8'
  );
  const sendTurnBlock = grokAdapter.slice(grokAdapter.indexOf('async sendTurn('));
  assert.match(
    sendTurnBlock.slice(0, 2000),
    /applyPermissionMode\(session, input\.grokPermissionMode\)/,
    'grok sendTurn must apply the per-turn permission mode'
  );
  ok('grok chain: dispatch → agent-loop merge → applyPermissionMode (3-link pin)');
}

testBuilder();
testSourcePins();
console.log('\nverify:warm-send-options OK');
