import assert from 'node:assert/strict';
import {
  buildCodexModelOptions,
  formatCodexModelLabel,
} from '../../src/ui/utils/codex-model.ts';
import {
  expandCodexModelFamilies,
  isCodexGpt56FamilyMember,
  unionCodexModelNames,
} from '../../src/shared/codex-model-catalog.ts';
import type { CodexModelConfig } from '../../src/shared/types.ts';

function testFormatUsesDisplayName() {
  assert.equal(formatCodexModelLabel('gpt-5.6-sol', 'GPT-5.6-Sol'), 'GPT 5.6 Sol');
  assert.equal(formatCodexModelLabel('gpt-5.6-terra', 'GPT-5.6-Terra'), 'GPT 5.6 Terra');
  assert.equal(formatCodexModelLabel('gpt-5.6-luna', 'GPT-5.6-Luna'), 'GPT 5.6 Luna');
}

function testFormatSlugFallbackKeepsVariantsDistinct() {
  const sol = formatCodexModelLabel('gpt-5.6-sol');
  const terra = formatCodexModelLabel('gpt-5.6-terra');
  const luna = formatCodexModelLabel('gpt-5.6-luna');
  assert.ok(sol.toLowerCase().includes('sol'));
  assert.ok(terra.toLowerCase().includes('terra'));
  assert.ok(luna.toLowerCase().includes('luna'));
  assert.notEqual(sol, terra);
  assert.notEqual(terra, luna);
}

function testBuildOptionsIncludesAllEnabledFiveSixVariants() {
  const config: CodexModelConfig = {
    defaultModel: 'gpt-5.6-sol',
    defaultReasoningEffort: 'high',
    options: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
    availableModels: [
      { name: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', enabled: true, isDefault: true, priority: 1 },
      { name: 'gpt-5.6-terra', label: 'GPT-5.6-Terra', enabled: true, isDefault: false, priority: 2 },
      { name: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', enabled: true, isDefault: false, priority: 3 },
      { name: 'gpt-5.5', label: 'GPT-5.5', enabled: true, isDefault: false, priority: 4 },
    ],
  };

  const options = buildCodexModelOptions(config);
  assert.deepEqual(
    options.filter((name) => name.startsWith('gpt-5.6')),
    ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    'all 5.6 variants that Codex lists should appear in the picker'
  );
}

function testBuildOptionsRespectsLocalDisabledFlag() {
  const config: CodexModelConfig = {
    defaultModel: 'gpt-5.6-sol',
    defaultReasoningEffort: null,
    options: ['gpt-5.6-sol', 'gpt-5.6-terra'],
    availableModels: [
      { name: 'gpt-5.6-sol', enabled: true, isDefault: true },
      { name: 'gpt-5.6-terra', enabled: false, isDefault: false },
    ],
  };
  assert.deepEqual(buildCodexModelOptions(config), ['gpt-5.6-sol']);
}

function testFamilyExpansionFromSolDefault() {
  assert.equal(isCodexGpt56FamilyMember('gpt-5.6-sol'), true);
  assert.equal(isCodexGpt56FamilyMember('gpt-5.5'), false);

  const expanded = expandCodexModelFamilies(['gpt-5.6-sol', 'gpt-5.5']);
  assert.ok(expanded.includes('gpt-5.6-sol'));
  assert.ok(expanded.includes('gpt-5.6-terra'));
  assert.ok(expanded.includes('gpt-5.6-luna'));
  assert.ok(expanded.includes('gpt-5.5'));
}

function testFamilyExpansionDoesNotInventWhenNoFiveSix() {
  assert.deepEqual(expandCodexModelFamilies(['gpt-5.5', 'gpt-5.4']), ['gpt-5.5', 'gpt-5.4']);
}

function testUnionKeepsStickyModelsWhenCacheShrinks() {
  // Simulates incomplete online refresh dropping 5.6 while sticky memory still has them.
  const liveCache = ['gpt-5.5', 'gpt-5.4'];
  const sticky = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'];
  const merged = expandCodexModelFamilies(unionCodexModelNames(liveCache, sticky));
  assert.ok(merged.includes('gpt-5.6-sol'));
  assert.ok(merged.includes('gpt-5.6-terra'));
  assert.ok(merged.includes('gpt-5.6-luna'));
  assert.ok(merged.includes('gpt-5.5'));
  assert.ok(merged.includes('gpt-5.4'));
}

testFormatUsesDisplayName();
testFormatSlugFallbackKeepsVariantsDistinct();
testBuildOptionsIncludesAllEnabledFiveSixVariants();
testBuildOptionsRespectsLocalDisabledFlag();
testFamilyExpansionFromSolDefault();
testFamilyExpansionDoesNotInventWhenNoFiveSix();
testUnionKeepsStickyModelsWhenCacheShrinks();
console.log('codex-model-list.test.ts: ok');
