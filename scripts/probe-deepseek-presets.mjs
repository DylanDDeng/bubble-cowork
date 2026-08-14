#!/usr/bin/env node
// Boot every Aegis DeepSeek agent preset against a local mock DeepSeek API and
// inspect the real request assembled by Harness. This proves the model-facing
// tool surface without using credentials or incurring API cost.

import http from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const profileDir = join(root, 'dev-fixtures', 'deepseek-harness');
const runtimePath = join(profileDir, 'runtime-bin.mjs');
const configPath = join(profileDir, 'cordis.yml');
const bootMarker = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-app-boot');

if (!existsSync(bootMarker)) {
  console.error('FAIL DeepSeek profile is not installed; run `npm install` in dev-fixtures/deepseek-harness');
  process.exit(1);
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function capturePreset(preset) {
  let requestBody;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString());
      const chunk = (delta, finishReason = null, usage) => ({
        id: 'aegis-preset-probe',
        object: 'chat.completion.chunk',
        created: 0,
        model: requestBody.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
      });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify(chunk({ role: 'assistant', content: 'ok' }))}\n\n`);
      response.write(
        `data: ${JSON.stringify(
          chunk({}, 'stop', {
            prompt_tokens: 10,
            completion_tokens: 1,
            total_tokens: 11,
            prompt_cache_hit_tokens: 0,
            prompt_cache_miss_tokens: 10,
          })
        )}\n\n`
      );
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('mock DeepSeek server did not bind a TCP port');
  }

  const cwd = mkdtempSync(join(tmpdir(), `aegis-dsh-${preset}-probe-`));
  const sessionRoot = mkdtempSync(join(tmpdir(), `aegis-dsh-${preset}-sessions-`));
  const harness = new DeepSeekHarness({
    launch: {
      command: process.execPath,
      args: [runtimePath, configPath],
      cwd: profileDir,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: 'local-preset-probe',
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
        DSH_CWD: cwd,
        DSH_SESSION_ROOT: sessionRoot,
        DSH_PERMISSION_MODE: 'workspace-write',
        DSH_REASONING_EFFORT: 'max',
        AEGIS_DSH_AGENT_PRESET: preset,
        ELECTRON_RUN_AS_NODE: '1',
      },
      requestTimeoutMs: 20_000,
    },
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
    cwd,
  });

  try {
    const result = await harness.run('Reply with ok.');
    if (result.finalResponse !== 'ok' || !requestBody) {
      throw new Error(`${preset}: mock turn did not complete`);
    }
    const systemPrompt = requestBody.messages?.find((message) => message.role === 'system')?.content || '';
    return {
      preset,
      tools: requestBody.tools?.map((tool) => tool.function?.name).filter(Boolean) || [],
      systemPrompt,
    };
  } finally {
    await harness.close().catch(() => {});
    await closeServer(server).catch(() => {});
    rmSync(cwd, { recursive: true, force: true });
    rmSync(sessionRoot, { recursive: true, force: true });
  }
}

const results = [];
for (const preset of ['standard', 'code', 'minimal', 'cordis']) {
  results.push(await capturePreset(preset));
}
const byPreset = Object.fromEntries(results.map((result) => [result.preset, result]));

const requiredStandardTools = ['bash', 'read', 'edit', 'skill', 'subagent', 'todo_write', 'web_search'];
for (const tool of requiredStandardTools) {
  if (!byPreset.standard.tools.includes(tool)) {
    throw new Error(`Standard is missing ${tool}`);
  }
}
if (byPreset.standard.tools.includes('run_code') || byPreset.standard.tools.some((name) => name.startsWith('cordis_'))) {
  throw new Error('Standard contains a tool reserved for another preset');
}
if (byPreset.code.tools.join(',') !== 'run_code' || !byPreset.code.systemPrompt.includes('declare const tools')) {
  throw new Error('PTC must expose only run_code backed by the generated TypeScript SDK');
}
if (byPreset.minimal.tools.join(',') !== 'bash,str_replace_editor') {
  throw new Error('Minimal must expose exactly bash and str_replace_editor');
}
if (!byPreset.cordis.tools.some((name) => name.startsWith('cordis_'))) {
  throw new Error('Creator must expose the Cordis runtime toolset');
}

console.log(
  JSON.stringify(
    results.map(({ preset, tools, systemPrompt }) => ({
      preset,
      tools,
      generatedTypeScriptSdk: systemPrompt.includes('declare const tools'),
    })),
    null,
    2
  )
);
console.log('deepseek-presets: runtime capability probe passed');
