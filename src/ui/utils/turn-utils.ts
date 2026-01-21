// Turn Phase 状态机工具函数

import type { TurnPhase, StreamMessage, ToolStatus } from '../types';

/**
 * 推导当前 Turn 阶段
 *
 * 状态机逻辑：
 * - pending:     刚发送消息，无任何响应
 * - tool_active: 检测到 tool_use 且状态为 pending（工具正在执行）
 * - awaiting:    工具完成，等待模型继续
 * - streaming:   有 partialMessage 正在流式输出
 * - complete:    session.status !== 'running'
 */
export function deriveTurnPhase(
  messages: StreamMessage[],
  isRunning: boolean,
  hasRunningTool: boolean,
  isStreaming: boolean
): TurnPhase {
  // 会话不在运行中，视为完成
  if (!isRunning) {
    return 'complete';
  }

  // 正在流式输出最终回复
  if (isStreaming) {
    return 'streaming';
  }

  // 有工具正在执行
  if (hasRunningTool) {
    return 'tool_active';
  }

  // 检查是否有任何 assistant 消息或工具调用
  const hasAssistantActivity = messages.some(
    (msg) => msg.type === 'assistant' || msg.type === 'stream_event'
  );

  // 有活动但没有正在运行的工具 = 等待下一步
  if (hasAssistantActivity) {
    return 'awaiting';
  }

  // 刚开始，什么都没有
  return 'pending';
}

/**
 * 判断是否应该显示 Thinking 指示器
 */
export function shouldShowThinkingIndicator(
  phase: TurnPhase,
  isBuffering: boolean
): boolean {
  switch (phase) {
    case 'pending':
      // 刚开始，显示 Thinking
      return true;
    case 'awaiting':
      // 工具完成后的空档期，显示 Thinking
      return true;
    case 'streaming':
      // 流式输出中但还在缓冲，显示 Preparing
      return isBuffering;
    case 'tool_active':
      // 工具执行中，不显示（工具有自己的状态）
      return false;
    case 'complete':
      // 完成，不显示
      return false;
    default:
      return false;
  }
}

/**
 * 获取 Thinking 指示器的文案
 */
export function getThinkingText(
  phase: TurnPhase,
  isBuffering: boolean
): string {
  if (phase === 'streaming' && isBuffering) {
    return 'Preparing response...';
  }
  return 'Thinking...';
}

/**
 * 检查是否有正在执行的工具
 */
export function hasRunningToolInMessages(
  messages: StreamMessage[],
  toolStatusMap: Map<string, ToolStatus>
): boolean {
  for (const msg of messages) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'tool_use') {
          const status = toolStatusMap.get(block.id);
          if (status === 'pending') {
            return true;
          }
        }
      }
    }
  }
  return false;
}
