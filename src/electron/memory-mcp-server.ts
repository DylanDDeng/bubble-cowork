import { stdin as input, stdout as output } from 'process';
import { resolve } from 'path';
import {
  getMemoryWorkspace,
  saveMemoryDocument,
} from './libs/memory-store';

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
};

function writeMessage(message: unknown): void {
  const payload = JSON.stringify(message);
  output.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`);
}

function writeResult(id: number | string | null | undefined, result: unknown): void {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function writeError(id: number | string | null | undefined, code: number, message: string): void {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function buildSnippet(content: string, query: string): string {
  const lower = content.toLowerCase();
  const target = query.toLowerCase();
  const index = lower.indexOf(target);
  if (index === -1) {
    return content.slice(0, 180).trim();
  }
  const start = Math.max(0, index - 80);
  const end = Math.min(content.length, index + target.length + 80);
  return content.slice(start, end).trim();
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
  const projectCwd = asString(process.env.AEGIS_MEMORY_PROJECT_CWD) || null;
  const workspace = await getMemoryWorkspace(projectCwd);

  if (name === 'aegis_memory_search' || name === 'remember_search') {
    const query = asString(args.query);
    if (!query) {
      throw new Error('Missing query');
    }
    const scope = asString(args.scope) || 'all';
    const docs = [
      ...(scope === 'all' || scope === 'assistant' ? [workspace.assistantDocument] : []),
      ...(scope === 'all' || scope === 'user' ? [workspace.userDocument] : []),
      ...(scope === 'all' || scope === 'project' ? (workspace.projectDocument ? [workspace.projectDocument] : []) : []),
    ];
    const matches = docs
      .filter((doc) => doc.content.toLowerCase().includes(query.toLowerCase()))
      .map((doc) => ({
        title: doc.title,
        kind: doc.kind,
        path: doc.path,
        snippet: buildSnippet(doc.content, query),
      }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              query,
              count: matches.length,
              matches,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  if (name === 'aegis_memory_get' || name === 'remember_get') {
    const kind = asString(args.kind);
    const doc =
      kind === 'assistant'
        ? workspace.assistantDocument
        : kind === 'user'
          ? workspace.userDocument
          : kind === 'project'
            ? workspace.projectDocument
            : null;
    if (!doc) {
      throw new Error(`Unknown or unavailable memory kind: ${String(kind)}`);
    }
    return {
      content: [
        {
          type: 'text',
          text: doc.content,
        },
      ],
    };
  }

  if (name === 'aegis_memory_put' || name === 'remember_write') {
    const kind = asString(args.kind);
    const content = typeof args.content === 'string' ? args.content : null;
    const mode = asString(args.mode) || 'replace';
    if (!content) {
      throw new Error('Missing content');
    }
    const doc =
      kind === 'assistant'
        ? workspace.assistantDocument
        : kind === 'user'
          ? workspace.userDocument
          : kind === 'project'
            ? workspace.projectDocument
            : null;
    if (!doc) {
      throw new Error(`Unknown or unavailable memory kind: ${String(kind)}`);
    }

    const nextContent = mode === 'append' ? `${doc.content.trimEnd()}\n\n${content}` : content;
    const saved = await saveMemoryDocument(resolve(doc.path), nextContent);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              kind: saved.kind,
              path: saved.path,
              updatedAt: saved.updatedAt,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

async function handleRequest(request: JsonRpcRequest): Promise<void> {
  if (request.method === 'initialize') {
    writeResult(request.id, {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: 'aegis-memory',
        version: '0.1.0',
      },
    });
    return;
  }

  if (request.method === 'notifications/initialized') {
    return;
  }

  if (request.method === 'tools/list') {
    writeResult(request.id, {
      tools: [
        {
          name: 'remember_search',
          description: 'Primary memory tool. Search long-term Aegis memory before answering questions about user preferences, project context, identity, or prior decisions.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              scope: { type: 'string', enum: ['assistant', 'user', 'project', 'all'] },
            },
            required: ['query'],
          },
        },
        {
          name: 'remember_get',
          description: 'Primary memory tool. Read one of the authoritative Aegis memory files: assistant, user, or project.',
          inputSchema: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['assistant', 'user', 'project'] },
            },
            required: ['kind'],
          },
        },
        {
          name: 'remember_write',
          description: 'Primary memory tool. Update one of the authoritative Aegis memory files instead of editing arbitrary files.',
          inputSchema: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['assistant', 'user', 'project'] },
              content: { type: 'string' },
              mode: { type: 'string', enum: ['replace', 'append'] },
            },
            required: ['kind', 'content'],
          },
        },
        {
          name: 'aegis_memory_search',
          description: 'Alias for remember_search.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' },
              scope: { type: 'string', enum: ['assistant', 'user', 'project', 'all'] },
            },
            required: ['query'],
          },
        },
        {
          name: 'aegis_memory_get',
          description: 'Alias for remember_get.',
          inputSchema: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['assistant', 'user', 'project'] },
            },
            required: ['kind'],
          },
        },
        {
          name: 'aegis_memory_put',
          description: 'Alias for remember_write.',
          inputSchema: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['assistant', 'user', 'project'] },
              content: { type: 'string' },
              mode: { type: 'string', enum: ['replace', 'append'] },
            },
            required: ['kind', 'content'],
          },
        },
      ],
    });
    return;
  }

  if (request.method === 'tools/call') {
    const name = asString(request.params?.name);
    const args = (request.params?.arguments as Record<string, unknown> | undefined) || {};
    if (!name) {
      writeError(request.id, -32602, 'Missing tool name');
      return;
    }

    try {
      const result = await handleToolCall(name, args);
      writeResult(request.id, result);
    } catch (error) {
      writeResult(request.id, {
        content: [
          {
            type: 'text',
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      });
    }
    return;
  }

  writeError(request.id, -32601, `Method not found: ${request.method}`);
}

let buffer = '';
input.setEncoding('utf8');
input.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      return;
    }

    const header = buffer.slice(0, headerEnd);
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }

    const contentLength = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const totalLength = bodyStart + contentLength;
    if (buffer.length < totalLength) {
      return;
    }

    const body = buffer.slice(bodyStart, totalLength);
    buffer = buffer.slice(totalLength);

    try {
      const request = JSON.parse(body) as JsonRpcRequest;
      void handleRequest(request);
    } catch (error) {
      writeError(null, -32700, error instanceof Error ? error.message : 'Parse error');
    }
  }
});
