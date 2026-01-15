import { query, type McpServerConfig as SDKMcpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { v4 as uuidv4 } from 'uuid';
import type { RunnerOptions, RunnerHandle, StreamMessage, PermissionResult } from '../types';
import { getMcpServers } from './claude-settings';

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
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  thinking?: string;
}

// 运行 Claude Agent
export function runClaude(options: RunnerOptions): RunnerHandle {
  const { prompt, session, resumeSessionId, model, onMessage, onPermissionRequest } = options;

  const abortController = new AbortController();

  // 异步执行
  (async () => {
    try {
      const result = query({
        prompt,
        options: {
          cwd: session.cwd || process.cwd(),
          resume: resumeSessionId,
          model,
          abortController,
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
          onMessage(streamMessage);
        }
      }
    } catch (error: unknown) {
      // 忽略 abort 错误
      if (error instanceof Error && error.name === 'AbortError') {
        return;
      }
      throw error;
    }
  })();

  return {
    abort: () => abortController.abort(),
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

    default:
      return null;
  }
}
