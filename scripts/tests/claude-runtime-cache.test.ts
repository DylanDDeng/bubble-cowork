import assert from 'node:assert/strict';
import {
  createClaudeRuntimeStatusCache,
  deriveClaudeRuntimeStatus,
  type ClaudeRuntimeProbe,
} from '../../src/electron/libs/claude-runtime-verdict';

const OFFICIAL_MODEL = 'claude-sonnet-4-5';
const COMPATIBLE_MODEL = 'deepseek-chat';

function makeProbe(overrides: Partial<ClaudeRuntimeProbe> = {}): ClaudeRuntimeProbe {
  return {
    runtimePath: '/usr/local/bin/claude',
    runtimeSource: 'global',
    cliVersion: '2.1.0',
    loggedIn: true,
    payloadAuthMethod: 'oauth',
    apiProvider: null,
    hasApiKeySanitized: false,
    hasApiKeyUnsanitized: true,
    hasClaudeCodeAccount: true,
    authProbeResponsive: true,
    authProbeErrorMessage: null,
    checkedAt: 0,
    ...overrides,
  };
}

// ── deriveClaudeRuntimeStatus: per-model verdicts over one probe ─────────────

{
  const probe = makeProbe();
  const official = deriveClaudeRuntimeStatus(probe, OFFICIAL_MODEL);
  assert.equal(official.kind, 'ready');
  assert.equal(official.requiresAnthropicAuth, true);
  assert.equal(official.ready, true);

  const compatible = deriveClaudeRuntimeStatus(probe, COMPATIBLE_MODEL);
  assert.equal(compatible.kind, 'ready');
  assert.equal(compatible.requiresAnthropicAuth, false);
  assert.equal(
    compatible.hasApiKey,
    true,
    'compatible models report the unsanitized env API key'
  );
}

{
  // Not logged in, no usable key under the sanitized env → official models
  // need login; compatible models stay ready off the same probe.
  const probe = makeProbe({
    loggedIn: false,
    hasClaudeCodeAccount: false,
    hasApiKeySanitized: false,
    payloadAuthMethod: null,
  });
  const official = deriveClaudeRuntimeStatus(probe, OFFICIAL_MODEL);
  assert.equal(official.kind, 'login_required');
  assert.equal(official.ready, false);

  const compatible = deriveClaudeRuntimeStatus(probe, COMPATIBLE_MODEL);
  assert.equal(compatible.kind, 'ready');
  assert.equal(compatible.authSatisfied, true);
}

{
  // API key satisfies official-model auth and is reported as the auth method.
  const probe = makeProbe({
    loggedIn: false,
    hasClaudeCodeAccount: false,
    hasApiKeySanitized: true,
  });
  const status = deriveClaudeRuntimeStatus(probe, OFFICIAL_MODEL);
  assert.equal(status.kind, 'ready');
  assert.equal(status.authMethod, 'api_key');
}

{
  // No CLI found → install_required regardless of model.
  const probe = makeProbe({ runtimePath: null, runtimeSource: 'unknown' });
  assert.equal(deriveClaudeRuntimeStatus(probe, OFFICIAL_MODEL).kind, 'install_required');
  assert.equal(deriveClaudeRuntimeStatus(probe, COMPATIBLE_MODEL).kind, 'install_required');
}

{
  // Unresponsive auth probe with unsatisfied auth → error kind.
  const probe = makeProbe({
    loggedIn: false,
    hasClaudeCodeAccount: false,
    hasApiKeySanitized: false,
    authProbeResponsive: false,
    authProbeErrorMessage: 'spawn ETIMEDOUT',
  });
  const status = deriveClaudeRuntimeStatus(probe, OFFICIAL_MODEL);
  assert.equal(status.kind, 'error');
  assert.match(status.detail, /ETIMEDOUT/);
}

// ── Cache policy ─────────────────────────────────────────────────────────────

interface Harness {
  cache: ReturnType<typeof createClaudeRuntimeStatusCache>;
  probeCalls: () => number;
  advance: (ms: number) => void;
  setProbeResult: (overrides: Partial<ClaudeRuntimeProbe>) => void;
}

function makeHarness(initialOverrides: Partial<ClaudeRuntimeProbe> = {}): Harness {
  let now = 1_000_000;
  let calls = 0;
  let overrides = initialOverrides;
  const cache = createClaudeRuntimeStatusCache({
    probe: async () => {
      calls += 1;
      return makeProbe({ ...overrides, checkedAt: now });
    },
    now: () => now,
    readyTtlMs: 10_000,
    notReadyTtlMs: 1_000,
  });
  return {
    cache,
    probeCalls: () => calls,
    advance: (ms) => {
      now += ms;
    },
    setProbeResult: (next) => {
      overrides = next;
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function main(): Promise<void> {
  {
    // Miss → one probe; fresh hits (any model) → no further probes.
    const h = makeHarness();
    const first = await h.cache.get(OFFICIAL_MODEL);
    assert.equal(first.ready, true);
    assert.equal(h.probeCalls(), 1);

    await h.cache.get(OFFICIAL_MODEL);
    await h.cache.get(COMPATIBLE_MODEL);
    await h.cache.get(null);
    assert.equal(h.probeCalls(), 1, 'the probe is model-independent: one entry serves all models');

    // Stale-but-ready → served instantly, refreshed in the background.
    h.advance(11_000);
    const stale = await h.cache.get(OFFICIAL_MODEL);
    assert.equal(stale.ready, true, 'stale ready verdict is served without blocking');
    await flushMicrotasks();
    assert.equal(h.probeCalls(), 2, 'a background refresh ran after the stale hit');
  }

  {
    // Compatible-provider-only user, never logged into Anthropic: the derived
    // verdict is ready, so a stale cache must never block the send — this is
    // the regression the review caught in the first draft.
    const h = makeHarness({ loggedIn: false, hasClaudeCodeAccount: false, hasApiKeySanitized: false });
    const first = await h.cache.get(COMPATIBLE_MODEL);
    assert.equal(first.ready, true);
    assert.equal(h.probeCalls(), 1);

    h.advance(60_000);
    const stale = await h.cache.get(COMPATIBLE_MODEL);
    assert.equal(stale.ready, true, 'stale compatible-model verdict served instantly');
    await flushMicrotasks();
    assert.equal(h.probeCalls(), 2, 'refresh happened off the send path');
  }

  {
    // Not-ready verdicts expire fast and DO block until re-probed.
    const h = makeHarness({ loggedIn: false, hasClaudeCodeAccount: false, hasApiKeySanitized: false });
    const first = await h.cache.get(OFFICIAL_MODEL);
    assert.equal(first.kind, 'login_required');
    assert.equal(h.probeCalls(), 1);

    // Within the not-ready TTL: cached verdict, no probe.
    h.advance(500);
    await h.cache.get(OFFICIAL_MODEL);
    assert.equal(h.probeCalls(), 1);

    // Past the TTL: user logged in meanwhile; the blocking re-probe sees it.
    h.advance(1_000);
    h.setProbeResult({ loggedIn: true });
    const second = await h.cache.get(OFFICIAL_MODEL);
    assert.equal(h.probeCalls(), 2);
    assert.equal(second.kind, 'ready', 'fresh probe picked up the new login');
  }

  {
    // Concurrent callers share one in-flight probe.
    const h = makeHarness();
    const [a, b, c] = await Promise.all([
      h.cache.get(OFFICIAL_MODEL),
      h.cache.get(COMPATIBLE_MODEL),
      h.cache.get(null),
    ]);
    assert.equal(h.probeCalls(), 1, 'no double subprocess spawn on concurrent sends');
    assert.equal(a.ready && b.ready && c.ready, true);
  }

  {
    // invalidate() forces the next get to re-probe.
    const h = makeHarness();
    await h.cache.get(OFFICIAL_MODEL);
    h.cache.invalidate();
    await h.cache.get(OFFICIAL_MODEL);
    assert.equal(h.probeCalls(), 2);
  }

  {
    // prefetch warms the cache so the first send is free.
    const h = makeHarness();
    await h.cache.prefetch();
    assert.equal(h.probeCalls(), 1);
    await h.cache.get(OFFICIAL_MODEL);
    assert.equal(h.probeCalls(), 1, 'first send after prefetch does not probe');
  }
}

main()
  .then(() => {
    console.log('claude-runtime-cache.test.ts passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
