#!/usr/bin/env node
// End-to-end DeepSeek Harness MCP probe: Aegis generates a per-workspace
// Cordis config, the official bridge discovers real stdio + Streamable HTTP
// MCP tools, the mock model calls both, and both results return through the
// next request.

import http from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const profileDir = join(root, 'dev-fixtures', 'deepseek-harness');
const runtimePath = join(profileDir, 'runtime-bin.mjs');
const bootMarker = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-mcp-client');
if (!existsSync(bootMarker)) {
  throw new Error('DeepSeek MCP bridge is not installed in the launch profile');
}

const { createDeepseekMcpRuntimeConfig } = require(
  join(root, 'dist-electron', 'electron', 'libs', 'deepseek-mcp-settings.js')
);

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

let requestCount = 0;
let exposedStdioTool = false;
let exposedHttpTool = false;
let receivedStdioResult = false;
let receivedHttpResult = false;
let firstRequestTools = [];
let secondRequestMessages = [];
const api = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requestCount += 1;
    if (requestCount === 1) {
      firstRequestTools = body.tools?.map((tool) => tool.function?.name).filter(Boolean) || [];
    } else {
      secondRequestMessages = body.messages || [];
    }
    exposedStdioTool ||= body.tools?.some(
      (tool) => tool.function?.name === 'mcp__aegis-probe__echo'
    );
    exposedHttpTool ||= body.tools?.some(
      (tool) => tool.function?.name === 'mcp__aegis-http-probe__echo_http'
    );
    receivedStdioResult ||= body.messages?.some(
      (message) => message.role === 'tool' && String(message.content).includes('ECHO:hello')
    );
    receivedHttpResult ||= body.messages?.some(
      (message) => message.role === 'tool' && String(message.content).includes('HTTP_ECHO:world')
    );

    const chunk = (delta, finishReason = null, usage) => ({
      id: `aegis-mcp-probe-${requestCount}`,
      object: 'chat.completion.chunk',
      created: 0,
      model: body.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(usage ? { usage } : {}),
    });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requestCount === 1) {
      response.write(
        `data: ${JSON.stringify(
          chunk({
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_aegis_mcp_probe',
                type: 'function',
                function: { name: 'mcp__aegis-probe__echo', arguments: '{"text":"hello"}' },
              },
              {
                index: 1,
                id: 'call_aegis_http_mcp_probe',
                type: 'function',
                function: {
                  name: 'mcp__aegis-http-probe__echo_http',
                  arguments: '{"text":"world"}',
                },
              },
            ],
          })
        )}\n\n`
      );
      response.write(`data: ${JSON.stringify(chunk({}, 'tool_calls'))}\n\n`);
    } else {
      response.write(
        `data: ${JSON.stringify(chunk({ role: 'assistant', content: 'MCP_OK' }))}\n\n`
      );
      response.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
    }
    response.write(
      `data: ${JSON.stringify(
        chunk({}, null, {
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
  api.once('error', reject);
  api.listen(0, '127.0.0.1', resolve);
});

const address = api.address();
if (!address || typeof address === 'string') throw new Error('mock API did not bind');
const mcpHttp = http.createServer(async (request, response) => {
  if (request.url?.split('?')[0] !== '/mcp' || request.method === 'GET') {
    response.writeHead(request.method === 'GET' ? 405 : 404).end();
    return;
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = new McpServer({ name: 'aegis-deepseek-http-probe', version: '1.0.0' });
  server.registerTool(
    'echo_http',
    {
      description: 'Echo HTTP probe text back to the caller.',
      inputSchema: { text: z.string() },
    },
    async ({ text }) => ({ content: [{ type: 'text', text: `HTTP_ECHO:${text}` }] })
  );
  await server.connect(transport);
  try {
    await transport.handleRequest(request, response);
  } finally {
    await server.close().catch(() => {});
    await transport.close().catch(() => {});
  }
});
await new Promise((resolve, reject) => {
  mcpHttp.once('error', reject);
  mcpHttp.listen(0, '127.0.0.1', resolve);
});
const mcpAddress = mcpHttp.address();
if (!mcpAddress || typeof mcpAddress === 'string') throw new Error('mock MCP HTTP server did not bind');
const cwd = mkdtempSync(join(tmpdir(), 'aegis-dsh-mcp-workspace-'));
const sessionRoot = mkdtempSync(join(tmpdir(), 'aegis-dsh-mcp-sessions-'));
const runtimeConfig = createDeepseekMcpRuntimeConfig(profileDir, cwd, {
  'aegis-probe': {
    type: 'stdio',
    command: process.execPath,
    args: [join(root, 'scripts', 'fixtures', 'deepseek-mcp-echo-server.mjs')],
  },
  'aegis-http-probe': {
    type: 'http',
    url: `http://127.0.0.1:${mcpAddress.port}/mcp`,
  },
});
const harness = new DeepSeekHarness({
  launch: {
    command: process.execPath,
    args: [runtimePath, runtimeConfig.configPath],
    cwd: profileDir,
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: 'local-mcp-probe',
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${address.port}`,
      DSH_CWD: cwd,
      DSH_SESSION_ROOT: sessionRoot,
      DSH_PERMISSION_MODE: 'workspace-write',
      DSH_REASONING_EFFORT: 'max',
      AEGIS_DSH_AGENT_PRESET: 'standard',
      ELECTRON_RUN_AS_NODE: '1',
    },
    requestTimeoutMs: 20_000,
  },
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  cwd,
});

try {
  const result = await harness.run('Call both MCP echo tools with hello and world.');
  if (result.finalResponse !== 'MCP_OK') throw new Error('mock turn did not complete');
  if (!exposedStdioTool || !exposedHttpTool) {
    throw new Error(`MCP tools were not exposed to the model; tools=${JSON.stringify(firstRequestTools)}`);
  }
  if (!receivedStdioResult || !receivedHttpResult) {
    throw new Error(
      `MCP tool results did not return to the model; messages=${JSON.stringify(secondRequestMessages)}`
    );
  }
  console.log('deepseek-mcp: real stdio/http discovery and tool execution passed');
} finally {
  await harness.close().catch(() => {});
  runtimeConfig.dispose();
  await closeServer(api).catch(() => {});
  await closeServer(mcpHttp).catch(() => {});
  rmSync(cwd, { recursive: true, force: true });
  rmSync(sessionRoot, { recursive: true, force: true });
}
