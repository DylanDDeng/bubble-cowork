const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-effort-catalog-'));
const home = path.join(temp, 'home');
const userData = path.join(temp, 'profile');
fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
fs.mkdirSync(userData);
const cachePath = path.join(home, '.codex/models_cache.json');
const levels = ['low','medium','high','xhigh','max','ultra'];
function writeCache(efforts) {
  fs.writeFileSync(cachePath, JSON.stringify({ models: [{ slug: 'gpt-6-astra', visibility: 'list',
    default_reasoning_level: 'medium', supported_reasoning_levels: efforts.map(effort => ({effort,description:effort})) }] }));
}
fs.writeFileSync(path.join(home, '.codex/config.toml'), 'model = "gpt-6-astra"\n');
writeCache(levels);
const originalLoad = Module._load;
try {
  // Isolate all config reads and catalog-memory writes from the user's profile.
  Module._load = function(request, ...args) {
    if (request === 'electron') return { app: { getPath: () => userData } };
    if (request === 'os') return { ...os, homedir: () => home };
    return originalLoad.call(this, request, ...args);
  };
  const settings = require('../../dist-electron/electron/libs/codex-settings.js');
  Module._load = originalLoad;
  const model = () => settings.getCodexModelConfig().availableModels.find(m => m.name === 'gpt-6-astra');
  assert.deepEqual(model().supportedReasoningLevels.map(l=>l.effort), levels);
  settings.setCodexRuntimeModelCatalog([{model:'gpt-6-astra', supportedReasoningEfforts:['high','low','turbo'], defaultReasoningEffort:'turbo'}]);
  assert.deepEqual(model().supportedReasoningLevels.map(l=>l.effort), ['high','low','turbo'], 'live catalog replaces stale cache without mapping or sorting');
  assert.equal(model().defaultReasoningEffort, 'turbo');
  settings.setCodexRuntimeModelCatalog([{model:'gpt-6-astra', supportedReasoningEfforts:[], defaultReasoningEffort:null}]);
  assert.deepEqual(model().supportedReasoningLevels, [], 'explicit empty live list does not resurrect cached tiers');
  assert.equal(model().defaultReasoningEffort, null);
  settings.setCodexRuntimeModelCatalog([]);
  assert.deepEqual(model().supportedReasoningLevels.map(l=>l.effort), levels, 'cache used before live catalog arrives');
  writeCache([]);
  assert.deepEqual(model().supportedReasoningLevels, [], 'explicit empty cache beats sticky catalog memory');
  console.log('codex-reasoning-catalog.test.cjs: ok');
} finally {
  Module._load = originalLoad;
  fs.rmSync(temp, {recursive:true,force:true});
}
