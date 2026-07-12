import assert from 'node:assert/strict';
import {
  applySessionAgentSelection,
  resolveListedOrPendingModel,
} from '../../src/ui/utils/session-model';
import type { SessionView } from '../../src/ui/types';

function testPrefersSessionModelWhenListLoaded() {
  const resolved = resolveListedOrPendingModel(
    'grok-4.5',
    'other-preferred',
    'default-model',
    ['', 'grok-4.5', 'grok-composer-2.5-fast']
  );
  assert.equal(resolved, 'grok-4.5');
}

function testUsesPreferredWhileConfigStillLoading() {
  // Only the empty "Default" option is present (config not loaded yet).
  const resolved = resolveListedOrPendingModel(
    null,
    'grok-4.5',
    null,
    ['']
  );
  assert.equal(
    resolved,
    'grok-4.5',
    'preferred model must win while listed values are empty so UI does not flash Default'
  );
}

function testKeepsSessionModelMissingFromStaleList() {
  const resolved = resolveListedOrPendingModel(
    'grok-4.5',
    'preferred-other',
    null,
    ['', 'some-old-model']
  );
  assert.equal(
    resolved,
    'grok-4.5',
    'explicit session model must not be cleared just because the list is stale'
  );
}

function testFallsBackToConfigDefault() {
  const resolved = resolveListedOrPendingModel(null, null, 'grok-4.5', ['', 'grok-4.5']);
  assert.equal(resolved, 'grok-4.5');
}

function testReturnsNullOnlyWhenNothingKnown() {
  const resolved = resolveListedOrPendingModel(null, null, null, ['']);
  assert.equal(resolved, null);
}

/**
 * Simulate the session-switch selection application order that used to flash
 * "Default": previous session state → apply new selection key → label.
 */
function testSessionSwitchDoesNotPassThroughDefaultLabel() {
  // Previous session state (composer still holding old selection before sync).
  let provider: string = 'grok';
  let model: string | null = 'grok-4.5';

  // Switch to a new draft session: no model field, preferred is grok-4.5.
  const nextProvider = 'grok';
  const listed = ['']; // config not yet populated for the new mount path
  const nextModel = resolveListedOrPendingModel(null, 'grok-4.5', null, listed);
  provider = nextProvider;
  model = nextModel;

  assert.equal(provider, 'grok');
  assert.equal(model, 'grok-4.5');

  // Label resolution must not bind null model to empty Default option.
  const modelOptions = [
    { value: '', label: 'Default' },
    { value: 'grok-4.5', label: 'Grok 4.5' },
  ];
  const selectedOption =
    model == null
      ? null
      : modelOptions.find((option) => (option.value.trim() || null) === (model.trim() || null)) || null;

  assert.equal(selectedOption?.label, 'Grok 4.5');
  assert.notEqual(selectedOption?.label, 'Default');
}

function testCurrentSessionSelectionUpdatesImmediately() {
  const session = {
    id: 'draft-1',
    title: 'New Chat',
    status: 'idle',
    provider: 'claude',
    model: 'claude-old',
    compatibleProviderId: 'custom-provider',
  } as unknown as SessionView;

  const updated = applySessionAgentSelection(session, {
    provider: 'codex',
    model: 'gpt-5.6-terra',
    compatibleProviderId: null,
  });

  assert.equal(updated.provider, 'codex');
  assert.equal(updated.model, 'gpt-5.6-terra');
  assert.equal(
    updated.compatibleProviderId,
    undefined,
    'switching away from Claude must clear the compatible-provider selection'
  );
  assert.equal(session.model, 'claude-old', 'session updates must remain immutable');
}

function testDefaultModelClearsSessionOverride() {
  const session = {
    id: 'draft-2',
    title: 'New Chat',
    status: 'idle',
    provider: 'claude',
    model: 'claude-explicit',
  } as unknown as SessionView;

  const updated = applySessionAgentSelection(session, {
    provider: 'claude',
    model: null,
    compatibleProviderId: null,
  });

  assert.equal(updated.model, undefined);
  assert.equal(updated.compatibleProviderId, undefined);
}

testPrefersSessionModelWhenListLoaded();
testUsesPreferredWhileConfigStillLoading();
testKeepsSessionModelMissingFromStaleList();
testFallsBackToConfigDefault();
testReturnsNullOnlyWhenNothingKnown();
testSessionSwitchDoesNotPassThroughDefaultLabel();
testCurrentSessionSelectionUpdatesImmediately();
testDefaultModelClearsSessionOverride();
console.log('composer-agent-selection-session-switch.test.ts: ok');
