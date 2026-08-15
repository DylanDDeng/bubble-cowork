import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * DeepSeek key-source resolution tests. Runs against the real module with a
 * throwaway HOME so precedence is exercised end to end:
 *   Aegis store > DEEPSEEK_API_KEY env > dsh credentials.
 * The legacy ~/.deepseek/config.toml (an unrelated third-party TUI) must be
 * ignored entirely. The Aegis store is written in its plaintext fallback
 * shape ({p, e:false}); the encrypted shape needs a running Electron keychain,
 * which unit tests don't have (safeStorage is a stub outside Electron).
 */

type TestCase = {
  name: string;
  setup: (home: string) => void;
  env?: Record<string, string>;
  expected: { source: string | null; hasApiKey: boolean };
};

const CASES: TestCase[] = [
  {
    name: 'no credentials anywhere → null source',
    setup: () => {},
    expected: { source: null, hasApiKey: false },
  },
  {
    name: 'legacy TUI ~/.deepseek/config.toml is ignored entirely',
    setup: (home) => {
      mkdirSync(path.join(home, '.deepseek'), { recursive: true });
      writeFileSync(
        path.join(home, '.deepseek', 'config.toml'),
        '# DeepSeek TUI Configuration\napi_key = "sk-legacy-tui-key-0001"\ndefault_text_model = "deepseek-v4-pro"\n'
      );
    },
    expected: { source: null, hasApiKey: false },
  },
  {
    name: 'dsh ~/.dsh/.credentials.yaml provides the key',
    setup: (home) => {
      mkdirSync(path.join(home, '.dsh'), { recursive: true });
      writeFileSync(
        path.join(home, '.dsh', '.credentials.yaml'),
        'DEEPSEEK_API_KEY: sk-dsh-key-000000000002\n'
      );
    },
    expected: { source: 'dsh', hasApiKey: true },
  },
  {
    name: 'DEEPSEEK_API_KEY env beats dsh credentials',
    setup: (home) => {
      mkdirSync(path.join(home, '.dsh'), { recursive: true });
      writeFileSync(
        path.join(home, '.dsh', '.credentials.yaml'),
        'DEEPSEEK_API_KEY: sk-dsh-key-000000000002\n'
      );
    },
    env: { DEEPSEEK_API_KEY: 'sk-env-key-0000000000003' },
    expected: { source: 'env', hasApiKey: true },
  },
  {
    name: 'Aegis store beats env and dsh',
    setup: (home) => {
      mkdirSync(path.join(home, '.aegis'), { recursive: true });
      writeFileSync(
        path.join(home, '.aegis', 'deepseek-api-key'),
        JSON.stringify({ p: 'sk-aegis-key-0000000004', e: false })
      );
      mkdirSync(path.join(home, '.dsh'), { recursive: true });
      writeFileSync(
        path.join(home, '.dsh', '.credentials.yaml'),
        'DEEPSEEK_API_KEY: sk-dsh-key-000000000002\n'
      );
    },
    env: { DEEPSEEK_API_KEY: 'sk-env-key-0000000000003' },
    expected: { source: 'aegis', hasApiKey: true },
  },
  {
    name: 'quoted and padded dsh YAML values parse',
    setup: (home) => {
      mkdirSync(path.join(home, '.dsh'), { recursive: true });
      writeFileSync(
        path.join(home, '.dsh', '.credentials.yaml'),
        '# dsh credentials\nDEEPSEEK_API_KEY:   "sk-quoted-dsh-key-0005"\n'
      );
    },
    expected: { source: 'dsh', hasApiKey: true },
  },
];

// os.homedir() follows $HOME on macOS/Linux, so redirect it per case. The
// module caches nothing at import time, but resolving it fresh per case keeps
// future memoization from silently breaking these tests.
const realHome = process.env.HOME;
assert.ok(realHome, 'tests need a real HOME to restore');

let failed = 0;
for (const testCase of CASES) {
  const home = mkdtempSync(path.join(tmpdir(), 'deepseek-key-test-'));
  const prevEnvKey = process.env.DEEPSEEK_API_KEY;
  try {
    process.env.HOME = home;
    delete process.env.DEEPSEEK_API_KEY;
    if (testCase.env?.DEEPSEEK_API_KEY) {
      process.env.DEEPSEEK_API_KEY = testCase.env.DEEPSEEK_API_KEY;
    }
    testCase.setup(home);

    // Dynamic require re-evaluates against the redirected HOME.
    delete require.cache[require.resolve('../../src/electron/libs/deepseek-cli.ts')];
    const cli = require('../../src/electron/libs/deepseek-cli.ts') as {
      resolveDeepseekApiKeyWithSource: () => { key: string; source: string } | null;
      hasDshCredentialsKey: () => boolean;
      getDeepseekKeyStatus: () => {
        hasApiKey: boolean;
        keySource: string | null;
        dshKeyAvailable: boolean;
      };
    };

    const effective = cli.resolveDeepseekApiKeyWithSource();
    assert.equal(
      effective?.source ?? null,
      testCase.expected.source,
      `${testCase.name}: source`
    );
    assert.equal(effective !== null, testCase.expected.hasApiKey, `${testCase.name}: hasApiKey`);

    const status = cli.getDeepseekKeyStatus();
    assert.equal(status.keySource, testCase.expected.source, `${testCase.name}: status.keySource`);
    assert.equal(status.hasApiKey, testCase.expected.hasApiKey, `${testCase.name}: status.hasApiKey`);
    if (testCase.expected.source === 'dsh') {
      assert.equal(status.dshKeyAvailable, true, `${testCase.name}: dshKeyAvailable`);
    }
    console.log(`ok - ${testCase.name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL - ${testCase.name}`);
    console.error(error);
  } finally {
    process.env.HOME = realHome;
    if (prevEnvKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prevEnvKey;
    rmSync(home, { recursive: true, force: true });
  }
}

if (failed > 0) {
  console.error(`${failed} deepseek key-source test(s) failed`);
  process.exit(1);
}
console.log('deepseek key-source tests passed');
