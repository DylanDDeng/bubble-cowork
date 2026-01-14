import { useMemo } from 'react';
import { MDContent } from '../render/markdown';
import {
  ToolUseCard,
  ToolResultCard,
  SystemInfoCard,
  SessionResultCard,
} from './EventCard';
import { DecisionPanel, getAskUserQuestionSignature } from './DecisionPanel';
import type {
  StreamMessage,
  ContentBlock,
  ToolStatus,
  PermissionRequestPayload,
  AskUserQuestionInput,
  PermissionResult,
} from '../types';

interface MessageCardProps {
  message: StreamMessage;
  toolStatusMap: Map<string, ToolStatus>;
  permissionRequests: PermissionRequestPayload[];
  onPermissionResult: (toolUseId: string, result: PermissionResult) => void;
}

export function MessageCard({
  message,
  toolStatusMap,
  permissionRequests,
  onPermissionResult,
}: MessageCardProps) {
  switch (message.type) {
    case 'user_prompt':
      return <UserPromptCard prompt={message.prompt} />;

    case 'system':
      if (message.subtype === 'init') {
        return <SystemInfoCard message={message} />;
      }
      return null;

    case 'assistant':
      return (
        <AssistantCard
          content={message.message.content}
          toolStatusMap={toolStatusMap}
          permissionRequests={permissionRequests}
          onPermissionResult={onPermissionResult}
        />
      );

    case 'user':
      return <UserMessageCard content={message.message.content} />;

    case 'result':
      return <SessionResultCard message={message} />;

    case 'stream_event':
      // stream_event 消息在 App.tsx 中单独处理 partial streaming
      return null;

    default:
      return null;
  }
}

// 用户 prompt 卡片
function UserPromptCard({ prompt }: { prompt: string }) {
  return (
    <div className="flex justify-end my-3">
      <div className="max-w-[80%] bg-[var(--accent)] rounded-lg rounded-br-sm px-4 py-2">
        <div className="text-sm whitespace-pre-wrap">{prompt}</div>
      </div>
    </div>
  );
}

// Assistant 消息卡片
function AssistantCard({
  content,
  toolStatusMap,
  permissionRequests,
  onPermissionResult,
}: {
  content: ContentBlock[];
  toolStatusMap: Map<string, ToolStatus>;
  permissionRequests: PermissionRequestPayload[];
  onPermissionResult: (toolUseId: string, result: PermissionResult) => void;
}) {
  return (
    <div className="my-3 min-w-0">
      {content.map((block, idx) => (
        <ContentBlockCard
          key={idx}
          block={block}
          toolStatusMap={toolStatusMap}
          permissionRequests={permissionRequests}
          onPermissionResult={onPermissionResult}
        />
      ))}
    </div>
  );
}

// 用户消息卡片（包含 tool_result）
function UserMessageCard({ content }: { content: ContentBlock[] }) {
  return (
    <div className="my-3">
      {content.map((block, idx) => {
        if (block.type === 'tool_result') {
          return <ToolResultCard key={idx} block={block} />;
        }
        return null;
      })}
    </div>
  );
}

// 内容块卡片
function ContentBlockCard({
  block,
  toolStatusMap,
  permissionRequests,
  onPermissionResult,
}: {
  block: ContentBlock;
  toolStatusMap: Map<string, ToolStatus>;
  permissionRequests: PermissionRequestPayload[];
  onPermissionResult: (toolUseId: string, result: PermissionResult) => void;
}) {
  switch (block.type) {
    case 'text':
      return (
        <div className="bg-[var(--bg-secondary)] rounded-lg p-4 min-w-0 overflow-x-auto">
          <MDContent content={block.text} />
        </div>
      );

    case 'thinking':
      return (
        <div className="bg-[var(--bg-tertiary)] rounded-lg p-4 border-l-2 border-purple-500/50">
          <div className="text-xs text-[var(--text-muted)] mb-2">Thinking...</div>
          <div className="text-sm text-[var(--text-secondary)] whitespace-pre-wrap">
            {block.thinking}
          </div>
        </div>
      );

    case 'tool_use':
      const status = toolStatusMap.get(block.id) || 'pending';

      // 检查是否为 AskUserQuestion 且有对应的 permission.request
      if (block.name === 'AskUserQuestion') {
        const input = block.input as unknown as AskUserQuestionInput;
        const signature = getAskUserQuestionSignature(input);

        // 查找匹配的 permission request
        const matchingRequest = permissionRequests.find((req) => {
          const reqSignature = getAskUserQuestionSignature(req.input);
          return reqSignature === signature;
        });

        if (matchingRequest) {
          return (
            <>
              <ToolUseCard block={block} status={status} />
              <DecisionPanel
                input={matchingRequest.input}
                onSubmit={(result) => onPermissionResult(matchingRequest.toolUseId, result)}
              />
            </>
          );
        }
      }

      return <ToolUseCard block={block} status={status} />;

    default:
      return null;
  }
}
