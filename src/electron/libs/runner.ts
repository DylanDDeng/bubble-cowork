import { query, type McpServerConfig as SDKMcpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { v4 as uuidv4 } from 'uuid';
import type { RunnerOptions, RunnerHandle, StreamMessage, PermissionResult } from '../types';
import { getClaudeEnv, getClaudeSettings, getMcpServers } from './claude-settings';
import { getClaudeCodeRuntime } from './claude-runtime';

// MCP 服务器状态
interface McpServerStatus {
  name: string;
  status: 'connected' | 'failed' | 'pending';
  error?: string;
}

// SDK 消息类型定义
interface SDKMessage {
  type: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  message?: {
    content: ContentBlock[];
  };
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  cwd?: string;
  model?: string;
  permissionMode?: string;
  tools?: string[];
  mcp_servers?: McpServerStatus[];
  result?: string;
  event?: {
    type?: string;
    index?: number;
    delta?: {
      type?: string;
      text?: string;
      thinking?: string;
    };
  };
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
}

interface SDKUserMessage {
  type: 'user';
  session_id: string;
  parent_tool_use_id: null;
  message: {
    role: 'user';
    content: Array<{ type: 'text'; text: string }>;
  };
}

type StreamEventType =
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop';

function isStreamEventType(value: string): value is StreamEventType {
  return (
    value === 'content_block_start' ||
    value === 'content_block_delta' ||
    value === 'content_block_stop'
  );
}

class AsyncMessageQueue<T> implements AsyncIterable<T> {
  private readonly queue: T[] = [];
  private readonly resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) {
      return;
    }

    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
      return;
    }

    this.queue.push(value);
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      if (resolver) {
        resolver({ value: undefined as unknown as T, done: true });
      }
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          const value = this.queue.shift() as T;
          return Promise.resolve({ value, done: false });
        }

        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }

        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

function buildUserMessage(prompt: string, sessionId: string): SDKUserMessage {
  return {
    type: 'user',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
    },
  };
}

// 运行 Claude Agent
export function runClaude(options: RunnerOptions): RunnerHandle {
  const { prompt, session, resumeSessionId, onMessage, onPermissionRequest, onError } = options;

  const abortController = new AbortController();
  const inputQueue = new AsyncMessageQueue<SDKUserMessage>();
  let currentSessionId = resumeSessionId || '';

  const enqueuePrompt = (text: string) => {
    if (!text) {
      return;
    }

    inputQueue.push(buildUserMessage(text, currentSessionId));
  };

  enqueuePrompt(prompt);

  // 异步执行
  (async () => {
    try {
      const env = {
        ...process.env,
        ...getClaudeEnv(),
      };
      const settings = getClaudeSettings();
      if (settings?.apiKey && !env.ANTHROPIC_API_KEY) {
        env.ANTHROPIC_API_KEY = settings.apiKey;
      }
      const { executable, executableArgs, env: runtimeEnv, pathToClaudeCodeExecutable } = getClaudeCodeRuntime();
      Object.assign(env, runtimeEnv);

      // 调试日志
      console.log('[Runner Debug]', {
        executable,
        executableArgs,
        pathToClaudeCodeExecutable,
        hasApiKey: !!env.ANTHROPIC_API_KEY,
        apiKeyPrefix: env.ANTHROPIC_API_KEY?.substring(0, 10),
        cwd: session.cwd || process.cwd(),
        PATH: env.PATH?.split(':').slice(0, 5),
        isPackaged: !process.defaultApp,
        resourcesPath: process.resourcesPath,
      });

      const result = query({
        prompt: inputQueue,
        options: {
          cwd: session.cwd || process.cwd(),
          resume: resumeSessionId,
          abortController,
          includePartialMessages: true,
          env,
          executable: executable as unknown as 'node',
          executableArgs,
          pathToClaudeCodeExecutable,
          // 从文件系统加载 Skills（~/.claude/skills/ 和 .claude/skills/）
          settingSources: ['user', 'project'],
          // 加载 MCP 服务器配置（合并全局和项目级）
          mcpServers: getMcpServers(session.cwd ?? undefined) as Record<string, SDKMcpServerConfig>,
          // 自定义工具权限处理
          canUseTool: async (toolName: string, input: Record<string, unknown>) => {
            // 只对 AskUserQuestion 进行用户交互
            if (toolName === 'AskUserQuestion') {
              const toolUseId = uuidv4();
              const permResult = await onPermissionRequest(toolUseId, toolName, input);

              if (permResult.behavior === 'allow') {
                return {
                  behavior: 'allow' as const,
                  updatedInput: (permResult.updatedInput || input) as Record<string, unknown>,
                };
              } else {
                return {
                  behavior: 'deny' as const,
                  message: permResult.message || 'User denied the request',
                };
              }
            }

            // 其他工具默认允许
            return {
              behavior: 'allow' as const,
              updatedInput: input,
            };
          },
        },
      });

      // 流式处理消息
      for await (const message of result) {
        if (abortController.signal.aborted) {
          break;
        }

        // 转换 SDK 消息为内部格式并发送
        const streamMessage = convertSDKMessage(message as SDKMessage);
        if (streamMessage) {
          if (streamMessage.type === 'system' && streamMessage.subtype === 'init') {
            currentSessionId = streamMessage.session_id || currentSessionId;
          }
          onMessage(streamMessage);
        }
      }
    } catch (error: unknown) {
      // 忽略 abort 错误
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      onError?.(err);
    } finally {
      inputQueue.close();
    }
  })();

  return {
    abort: () => {
      abortController.abort();
      inputQueue.close();
    },
    send: enqueuePrompt,
  };
}

// 转换 SDK 消息为内部 StreamMessage 格式
function convertSDKMessage(message: SDKMessage): StreamMessage | null {
  switch (message.type) {
    case 'system':
      if (message.subtype === 'init') {
        return {
          type: 'system',
          subtype: 'init',
          session_id: message.session_id || '',
          model: message.model || '',
          permissionMode: message.permissionMode || '',
          cwd: message.cwd || '',
          tools: message.tools || [],
          mcp_servers: message.mcp_servers,
        };
      }
      return null;

    case 'assistant':
      return {
        type: 'assistant',
        uuid: message.uuid || uuidv4(),
        message: (message.message || { content: [] }) as any,
      };

    case 'user':
      return {
        type: 'user',
        uuid: message.uuid || uuidv4(),
        message: (message.message || { content: [] }) as any,
      };

    case 'result':
      return {
        type: 'result',
        subtype: message.subtype || 'success',
        duration_ms: message.duration_ms || 0,
        total_cost_usd: message.total_cost_usd || 0,
        usage: message.usage || { input_tokens: 0, output_tokens: 0 },
      };

    case 'stream_event': {
      const rawEvent = message.event;
      if (!rawEvent || typeof rawEvent.type !== 'string') {
        return null;
      }

      if (!isStreamEventType(rawEvent.type)) {
        return null;
      }

      const eventType = rawEvent.type;
      const event = {
        type: eventType,
        index: typeof rawEvent.index === 'number' ? rawEvent.index : undefined,
        delta:
          eventType === 'content_block_delta' && rawEvent.delta
            ? {
                type: typeof rawEvent.delta.type === 'string' ? rawEvent.delta.type : '',
                text: typeof rawEvent.delta.text === 'string' ? rawEvent.delta.text : undefined,
                thinking:
                  typeof rawEvent.delta.thinking === 'string'
                    ? rawEvent.delta.thinking
                    : undefined,
              }
            : undefined,
      };

      return {
        type: 'stream_event',
        event,
      };
    }

    default:
      return null;
  }
}
