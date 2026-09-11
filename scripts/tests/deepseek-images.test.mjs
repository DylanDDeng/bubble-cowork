import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const root = resolve('.');
const profile = join(root, 'dev-fixtures/deepseek-harness');
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'aegis-dsh-images-')));
const cwd = join(temp, 'workspace'); mkdirSync(cwd);
const home = join(temp, 'dsh-images');
process.env.AEGIS_DSH_PROFILE_DIR = profile;
process.env.AEGIS_DSH_ATTACHMENT_HOME = home;
const { DeepseekSdkAdapter } = require('../../dist-electron/electron/libs/provider/deepseek-sdk-adapter.js');
const { buildDeepseekPromptBlocks, deepseekToolImages } = require('../../dist-electron/electron/libs/provider/deepseek-images.js');
const { getDeepseekModelConfig, parseDeepseekModelConfig } = require('../../dist-electron/electron/libs/deepseek-cli.js');
const { deepseekImageInputError } = require('../../dist-electron/shared/deepseek-images.js');
const { normalizeToolResultBlock } = await import('../../src/ui/utils/message-content.ts');
const requests = [];
const uploaded = new Map();
let nextCall;
let holdResponse;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    if (req.url.startsWith('/files')) {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST') {
        const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': req.headers['content-type'] } }).formData();
        const file = form.get('file');
        const bytes = Buffer.from(await file.arrayBuffer());
        assert((await sharp(bytes).metadata()).width > 0, 'Files API receives real raster bytes');
        const now = Math.floor(Date.now() / 1000);
        const record = { id: `file-${uploaded.size}`, object: 'file', bytes: bytes.length, filename: file.name, purpose: 'user_data', created_at: now, expires_at: now + 86400 };
        uploaded.set(record.id, record); res.end(JSON.stringify(record));
      } else res.end(JSON.stringify(uploaded.get(req.url.split('/').pop()) || { object: 'list', data: [...uploaded.values()], has_more: false }));
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    const call = nextCall; nextCall = undefined;
    if (holdResponse) await holdResponse;
    const chunk = (delta, finish_reason = null) => ({ id: 'image-test', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta, finish_reason }] });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify(chunk(call ? { role: 'assistant', tool_calls: [{ index: 0, id: `image-call-${requests.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } : { role: 'assistant', content: 'IMAGE_OK' }))}\n\n`);
    res.write(`data: ${JSON.stringify(chunk({}, call ? 'tool_calls' : 'stop'))}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const adapters = new Set();
function makeAdapter() {
  const adapter = new DeepseekSdkAdapter(); adapters.add(adapter);
  // Only replace environment assembly (credentials/MCP/user database). The
  // adapter, SDK transport, plugins, sandbox, persistence and HTTP are real.
  adapter.spawnHarness = async (_thread, workspace, model, permission, preset, effort, resume) => {
    const harness = new DeepSeekHarness({
      dshBin: join(profile, 'runtime-bin.mjs'), profile: 'sdk', patches: [join(profile, 'cordis.yml')], processCwd: profile,
      cwd: workspace, provider: 'deepseek-official', model, reasoningEffort: effort,
      requestTimeoutMs: 20000,
      env: { ...process.env, HOME: join(temp, 'isolated-home'), USERPROFILE: join(temp, 'isolated-home'),
        DSH_HOME: join(temp, 'isolated-home/.dsh'), DSH_CWD: workspace, DSH_PERMISSION_MODE: permission,
        DSH_SESSION_ROOT: join(temp, 'sessions'), AEGIS_DSH_PROJECT_ROOTS: '', AEGIS_DSH_AGENT_PRESET: preset,
        AEGIS_DSH_RESUME_SESSION_ID: resume || '', AEGIS_DSH_ATTACHMENT_HOME: home,
        DEEPSEEK_API_KEY: 'local-image-test', DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}`, ELECTRON_RUN_AS_NODE: '1' },
    });
    await harness.start(); return { harness, disposeRuntimeConfig() {} };
  };
  adapter.observed = [];
  adapter.events.on('event', event => adapter.observed.push(event));
  return adapter;
}
function options(threadId, attachments = [], extra = {}) {
  return { threadId, cwd, prompt: 'Inspect these images.', model: 'deepseek-flash', attachments, ...extra };
}
const imageParts = body => body.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url' || (part.type === 'file' && uploaded.has(part.file_id))) : []);
const results = adapter => adapter.observed.filter(e => e.type === 'message' && e.message?.type === 'assistant').flatMap(e => e.message.message.content).filter(b => b.type === 'tool_result');
async function stop(adapter, id) { await adapter.stopSession(id); adapters.delete(adapter); }
try {
  const config = getDeepseekModelConfig();
  assert.deepEqual(config.imageModels, ['deepseek-flash', 'deepseek-v4-flash']);
  const inert = parseDeepseekModelConfig(`- name: '@deepseek-ai/dsh-llm-deepseek'\n  config:\n    expression: !!js "throw new Error('must not execute')"\n    models:\n      - id: 'custom-vision'\n        inputModalities:\n          - text\n          - image\n`);
  assert.deepEqual(inert.imageModels, ['custom-vision']);
  const attachments = [];
  for (const format of ['png', 'jpeg', 'webp', 'gif']) {
    const file = join(cwd, `color.${format}`);
    await sharp({ create: { width: 20, height: 14, channels: 3, background: '#f02070' } }).toFormat(format).toFile(file);
    attachments.push({ id: format, path: file, name: `color.${format}`, mimeType: `image/${format}`, size: readFileSync(file).length, kind: 'image' });
  }
  assert.match(deepseekImageInputError(attachments, 'deepseek-v4-pro', config), /Switch to .*deepseek-flash/);
  const first = makeAdapter();
  const start = await first.startSession(options('upload', attachments));
  assert.equal(imageParts(requests.at(-1)).length, 4);
  assert(requests.at(-1).messages.some(m => Array.isArray(m.content) && m.content.some(b => b.text === 'Inspect these images.')));
  assert(!JSON.stringify(requests.at(-1).messages).includes('cannot view images'));
  await first.sendTurn({ threadId: 'upload', prompt: '', attachments: [attachments[0]] });
  assert.equal(imageParts(requests.at(-1)).length, 5, 'image-only followup is admitted');
  // Image encoding/admission must also work through the busy-turn inbox.
  let releaseResponse;
  holdResponse = new Promise(resolve => { releaseResponse = resolve; });
  const beforeSteer = requests.length;
  const primary = first.sendTurn({ threadId: 'upload', prompt: 'Wait for another image.' });
  try {
    for (let i = 0; i < 200 && requests.length === beforeSteer; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert(requests.length > beforeSteer, 'primary turn reached the model');
    await first.sendTurn({ threadId: 'upload', prompt: 'Also inspect this image.', attachments: [attachments[1]] });
  } finally { holdResponse = undefined; releaseResponse(); }
  await primary;
  assert.equal(imageParts(requests.at(-1)).length, 6, 'steered images stay in the same native session');
  const beforeUnsupported = requests.length;
  await assert.rejects(makeAdapter().startSession(options('unsupported', attachments, { model: 'deepseek-v4-pro' })), /does not support image input/);
  assert.equal(requests.length, beforeUnsupported);

  for (const preset of ['standard', 'code']) {
    const adapter = makeAdapter();
    nextCall = preset === 'standard' ? { name: 'read_image', args: { file_path: attachments[0].path } }
      : { name: 'run_code', args: { description: 'Read the image', code: `return await tools.read_image({file_path:${JSON.stringify(attachments[0].path)}});` } };
    const requestIndex = requests.length;
    await adapter.startSession(options(preset, [], { deepseekAgentPreset: preset, prompt: 'Read the local image.' }));
    assert.equal(imageParts(requests.at(-1)).length, 1, `${preset}: tool image reaches next model request: ${JSON.stringify(requests.at(-1).messages.slice(-3))}; ${JSON.stringify(adapter.observed)}`);
    const result = results(adapter).find(b => b.images?.length);
    assert(result, `${preset}: adapter preserves result image. Events: ${JSON.stringify(adapter.observed)}`);
    assert.equal(result.images[0].kind, 'image');
    assert.equal(normalizeToolResultBlock(JSON.parse(JSON.stringify(result))).images.length, 1);
    assert(readFileSync(result.images[0].path).length > 0);
    assert(requests.length >= requestIndex + 2);
    if (process.env.QA_RESULT) writeFileSync(process.env.QA_RESULT, JSON.stringify({ messages: adapter.observed.filter(e => e.type === 'message').map(e => e.message), image: result.images[0] }));
    if (preset === 'code') {
      nextCall = { name: 'run_code', args: { description: 'Read again', code: `return await tools.read_image({file_path:${JSON.stringify(attachments[0].path)}});` } };
      await adapter.sendTurn({ threadId: preset, prompt: 'Read that image in another turn.' });
      const calls = adapter.observed.filter(e => e.message?.type === 'assistant' &&
        e.message.message.content.some(b => b.type === 'tool_use' && b.name === 'read_image'));
      assert.equal(new Set(calls.map(e => e.message.uuid)).size, 2, 'PTC image calls stay attached to their own turn');
      assert(calls.every(e => e.message.message.content.filter(b => b.name === 'read_image').length === 1));
    }
    await stop(adapter, preset);
  }

  // SDK admission rejects malformed image data before invoking a model.
  const badPath = join(cwd, 'bad.png'); writeFileSync(badPath, 'not an image');
  const beforeBad = requests.length;
  const invalid = makeAdapter();
  await invalid.startSession(options('invalid', [{ ...attachments[0], path: badPath }]));
  assert(invalid.observed.some(e => e.type === 'error'), 'malformed image emits an actionable error');
  assert.equal(requests.length, beforeBad);
  await stop(invalid, 'invalid');
  const mismatch = makeAdapter();
  await mismatch.startSession(options('mismatch', [{ ...attachments[0], mimeType: 'image/jpeg' }]));
  assert(mismatch.observed.some(e => e.type === 'error'), 'declared MIME must match raster bytes');
  assert.equal(requests.length, beforeBad);
  await stop(mismatch, 'mismatch');
  const tooLarge = join(cwd, 'too-large.png');
  writeFileSync(tooLarge, Buffer.alloc(10 * 1024 * 1024 + 1));
  await assert.rejects(buildDeepseekPromptBlocks('', [{ ...attachments[0], path: tooLarge }]), /at most 10 MB/);
  await assert.rejects(buildDeepseekPromptBlocks('', [{ ...attachments[0], mimeType: 'image/svg+xml' }]), /PNG, JPEG, WebP and GIF/);
  await assert.rejects(buildDeepseekPromptBlocks('', Array(21).fill(attachments[0])), /up to 20/);
  await assert.rejects(deepseekToolImages([{ type: 'image', attachment: { attachmentId: 'sha256:../../secret', mediaType: 'image/png', bytes: 20 } }], home), /Invalid/);

  await stop(first, 'upload');
  for (const attachment of attachments) rmSync(attachment.path);
  const resumed = makeAdapter();
  await resumed.startSession(options('resumed', [], { resumeSessionId: start.providerSessionId, prompt: 'Recall the images after a restart.' }));
  assert.equal(imageParts(requests.at(-1)).length, 6, 'native stored images survive source deletion and process restart');
  await stop(resumed, 'resumed');
  console.log('DeepSeek images: real adapter/runtime, 4 formats, image-only + steer, read_image/native + PTC, validation and restart passed');
} finally {
  for (const adapter of adapters) for (const id of adapter.sessions.keys()) await adapter.stopSession(id);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (!process.env.QA_RESULT) rmSync(temp, { recursive: true, force: true });
}
