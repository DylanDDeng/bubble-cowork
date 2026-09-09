import assert from 'node:assert/strict';
import {
  formatCodexReasoningEffortLabel,
  getCodexReasoningOptions,
  getDefaultCodexReasoningEffort,
} from '../../src/ui/utils/codex-reasoning.ts';
import type { CodexModelConfig } from '../../src/shared/types.ts';

const GPT_56_SOL_LEVELS = [
  { effort: 'low', description: 'Fast responses with lighter reasoning' },
  { effort: 'medium', description: 'Balances speed and reasoning depth' },
  { effort: 'high', description: 'Greater reasoning depth' },
  { effort: 'xhigh', description: 'Extra high reasoning depth' },
  { effort: 'max', description: 'Maximum reasoning depth' },
  { effort: 'ultra', description: 'Ultra reasoning depth' },
];

function makeConfig(overrides: Partial<CodexModelConfig> = {}): CodexModelConfig {
  return {
    defaultModel: 'gpt-5.6-sol',
    defaultReasoningEffort: 'ultra',
    options: ['gpt-5.6-sol', 'gpt-5.4'],
    availableModels: [
      {
        name: 'gpt-5.6-sol',
        enabled: true,
        isDefault: true,
        defaultReasoningEffort: 'low',
        supportedReasoningLevels: GPT_56_SOL_LEVELS,
      },
      {
        name: 'gpt-5.4',
        enabled: true,
        isDefault: false,
        defaultReasoningEffort: 'medium',
        supportedReasoningLevels: GPT_56_SOL_LEVELS.slice(0, 4),
      },
    ],
    ...overrides,
  };
}

function testOptionsPassThroughCacheLevelsIncludingUltra() {
  const options = getCodexReasoningOptions(makeConfig(), 'gpt-5.6-sol');
  assert.deepEqual(
    options.map((option) => option.effort),
    ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    'effort options must mirror models_cache supported_reasoning_levels, not a hardcoded list'
  );
}

function testConfigUltraWinsOverPerModelDefault() {
  // config.toml model_reasoning_effort = "ultra" is what Codex Desktop honors;
  // it must beat the model's own cache default ("low" for gpt-5.6-sol).
  assert.equal(getDefaultCodexReasoningEffort(makeConfig(), 'gpt-5.6-sol'), 'ultra');
}

function testUnsupportedConfigEffortFallsBackToModelDefault() {
  // gpt-5.4 does not support "ultra" — the config default must not leak into
  // an unsupported model; fall back to the model's own default.
  assert.equal(getDefaultCodexReasoningEffort(makeConfig(), 'gpt-5.4'), 'medium');
}

function testNoMetadataDoesNotInventEfforts() {
  const config = makeConfig({
    defaultReasoningEffort: null,
    availableModels: [
      {
        name: 'gpt-x-unknown',
        enabled: true,
        isDefault: true,
        defaultReasoningEffort: null,
        supportedReasoningLevels: [],
      },
    ],
  });
  assert.equal(getDefaultCodexReasoningEffort(config, 'gpt-x-unknown'), undefined);
  assert.deepEqual(getCodexReasoningOptions(config, 'gpt-x-unknown'), []);
  assert.deepEqual(getCodexReasoningOptions(config, 'not-in-catalog'), []);
  const custom = makeConfig();
  custom.availableModels[0].supportedReasoningLevels = [{effort:'turbo',description:'Provider tier'}, {effort:'low',description:'Low'}];
  assert.deepEqual(getCodexReasoningOptions(custom, 'gpt-5.6-sol').map(o=>o.effort), ['turbo','low']);
}

function testEffortLabelsAreGeneric() {
  assert.equal(formatCodexReasoningEffortLabel('low'), 'Low');
  assert.equal(formatCodexReasoningEffortLabel('medium'), 'Medium');
  assert.equal(formatCodexReasoningEffortLabel('xhigh'), 'Extra High');
  assert.equal(formatCodexReasoningEffortLabel('max'), 'Max');
  assert.equal(formatCodexReasoningEffortLabel('ultra'), 'Ultra');
  // A hypothetical future level still renders sensibly with no code change.
  assert.equal(formatCodexReasoningEffortLabel('turbo'), 'Turbo');
}

testOptionsPassThroughCacheLevelsIncludingUltra();
testConfigUltraWinsOverPerModelDefault();
testUnsupportedConfigEffortFallsBackToModelDefault();
testNoMetadataDoesNotInventEfforts();
testEffortLabelsAreGeneric();
console.log('codex-reasoning-effort.test.ts: ok');
