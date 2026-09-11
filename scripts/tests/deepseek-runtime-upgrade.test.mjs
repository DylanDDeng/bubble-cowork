import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';

// A real rc.8 session with a completed read call. Only workspace paths and
// the local skill catalog are redacted; event identities/order are preserved.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const profile = join(root, 'dev-fixtures/deepseek-harness');
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'aegis-dsh-upgrade-')));
const cwd = join(temp, 'workspace');
const sessionRoot = join(temp, 'sessions');
mkdirSync(cwd);
const fixture = readFileSync(join(root, 'scripts/fixtures/deepseek-session-rc8.jsonl'), 'utf8')
  .replaceAll('__AEGIS_FIXTURE_CWD__', JSON.stringify(cwd).slice(1, -1));
const sessionId = JSON.parse(fixture.split('\n')[0]).id;
// rc.8's on-disk project directory encoding (before format migration).
const bucket = '--' + cwd.replace(/[/\\:]+/g, '-').replace(/[^A-Za-z0-9._-]/g,
  (char) => '~' + char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'))
  .replace(/^-+/, '').slice(0, 251) + '--';
const sessionDir = join(sessionRoot, bucket, sessionId);
mkdirSync(sessionDir, { recursive: true });
const legacyPath = join(sessionDir, 'session.jsonl.zstd');
// The old writer emits concatenated frames; exercise that representation.
const legacyBytes = Buffer.concat(fixture.trimEnd().split('\n').map(
  (line) => zstdCompressSync(Buffer.from(line + '\n')),
));
writeFileSync(legacyPath, legacyBytes);

const requests = [];
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const chunk = (delta, finish_reason = null) => ({
      id: 'upgrade-probe', object: 'chat.completion.chunk', model: body.model,
      choices: [{ index: 0, delta, finish_reason }],
    });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'UPGRADE_OK' }))}\n\n`);
    res.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

function harness(workspace = cwd, expectedId = sessionId) {
  return new DeepSeekHarness({
    dshBin: join(profile, 'runtime-bin.mjs'), profile: 'sdk',
    patches: [join(profile, 'cordis.yml')], processCwd: profile,
    cwd: workspace, provider: 'deepseek-official', model: 'deepseek-flash',
    reasoningEffort: 'high', requestTimeoutMs: 15_000,
    env: {
      ...process.env, HOME: join(temp, 'home'), USERPROFILE: join(temp, 'home'),
      DSH_HOME: join(temp, 'home/.dsh'), DSH_CWD: workspace,
      DSH_SESSION_ROOT: sessionRoot, DSH_PERMISSION_MODE: 'workspace-write',
      AEGIS_DSH_PROJECT_ROOTS: '', AEGIS_DSH_AGENT_PRESET: 'standard',
      AEGIS_DSH_RESUME_SESSION_ID: expectedId,
      DEEPSEEK_API_KEY: 'local-upgrade-probe',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      ELECTRON_RUN_AS_NODE: '1',
    },
  });
}

const opened = new Set();
async function usingHarness(run, workspace, id) {
  const h = harness(workspace, id);
  opened.add(h);
  try { return await run(h); }
  finally { await h.close(); opened.delete(h); }
}

try {
  await usingHarness(async (first) => {
    const result = await first.session(sessionId).run('Recall the old marker.');
    assert.equal(result.finalResponse, 'UPGRADE_OK');
    assert.equal(result.sessionId, sessionId);
    assert(result.events.some((event) => event.type === 'turn/end'));
    assert(readdirSync(sessionDir).includes('session.v3.jsonl.zstd'));
    assert.deepEqual(readFileSync(legacyPath), legacyBytes, 'migration must preserve the source log');

    // The new native write lock must reject a second process, then release
    // on close so a subsequent process can continue the same identity.
    await usingHarness(async (second) => {
      await assert.rejects(second.session(sessionId).run('Must not write concurrently.'),
        /already owned by an active write handle/);
    });
  });
  await usingHarness(async (second) => {
    const result = await second.session(sessionId).run('Continue after another process restart.');
    assert.equal(result.finalResponse, 'UPGRADE_OK');
  });
  assert.equal(requests.length, 2, 'lock rejection must not reach the model');
  for (const request of requests) {
    assert.equal(request.model, 'deepseek-flash');
    assert.equal(request.reasoning_effort, 'high');
    assert(request.messages.some((message) => message.role === 'tool' &&
      JSON.stringify(message).includes('AEGIS_LEGACY_MEMORY')));
    assert(request.messages.some((message) => message.role === 'assistant' &&
      JSON.stringify(message).includes('legacy-read')));
  }
  assert(requests[1].messages.some((message) => message.role === 'assistant' && message.content === 'UPGRADE_OK'));

  const other = join(temp, 'other'); mkdirSync(other);
  for (const [workspace, id, error] of [
    [other, sessionId, /AEGIS_DSH_RESUME_CWD_MISMATCH/],
    [cwd, 'missing-session', /AEGIS_DSH_RESUME_NOT_FOUND/],
  ]) {
    await usingHarness(async (h) => {
      await assert.rejects(h.session(id).run('Must not start a fresh conversation.'), error);
    }, workspace, id);
  }
  assert.equal(requests.length, 2, 'unsafe resume must fail before inference');
  assert.deepEqual(readFileSync(legacyPath), legacyBytes);
  console.log('DeepSeek upgrade: rc.8 migration, V3 restart, full tool history, effort, locks and resume guards passed');
} finally {
  await Promise.allSettled([...opened].map((h) => h.close()));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(temp, { recursive: true, force: true });
}
