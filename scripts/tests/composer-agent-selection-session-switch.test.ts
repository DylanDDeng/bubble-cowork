import assert from 'node:assert/strict';
import { resolveListedOrPendingModel } from '../../src/ui/hooks/useComposerAgentSelection.ts';

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

testPrefersSessionModelWhenListLoaded();
testUsesPreferredWhileConfigStillLoading();
testKeepsSessionModelMissingFromStaleList();
testFallsBackToConfigDefault();
testReturnsNullOnlyWhenNothingKnown();
testSessionSwitchDoesNotPassThroughDefaultLabel();
console.log('composer-agent-selection-session-switch.test.ts: ok');
