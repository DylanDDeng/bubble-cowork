import { useMemo } from 'react';
import { MDContent } from '../render/markdown';
import {
  SystemInfoCard,
  SessionResultCard,
} from './EventCard';
import { DecisionPanel, getAskUserQuestionSignature } from './DecisionPanel';
import { ToolGroup } from './ToolGroup';
import type {
  StreamMessage,
  ContentBlock,
  ToolStatus,
  PermissionRequestPayload,
  AskUserQuestionInput,
  PermissionResult,
} from '../types';

// 工具使用块类型
type ToolUseBlock = ContentBlock & { type: 'tool_use' };
// 工具结果块类型
type ToolResultBlock = ContentBlock & { type: 'tool_result' };

// 内容分组类型
type ContentGroup =
  | { type: 'tool_group'; blocks: ToolUseBlock[] }
  | { type: 'single'; block: ContentBlock };

// 将内容块分组：连续的 tool_use 合并为一组
function groupContentBlocks(content: ContentBlock[]): ContentGroup[] {
  const groups: ContentGroup[] = [];
  let currentToolGroup: ToolUseBlock[] = [];

  for (const block of content) {
    if (block.type === 'tool_use') {
      currentToolGroup.push(block as ToolUseBlock);
    } else {
      // 遇到非 tool_use，先保存当前工具组
      if (currentToolGroup.length > 0) {
        groups.push({ type: 'tool_group', blocks: currentToolGroup });
        currentToolGroup = [];
      }
      groups.push({ type: 'single', block });
    }
  }

  // 处理末尾的工具组
  if (currentToolGroup.length > 0) {
    groups.push({ type: 'tool_group', blocks: currentToolGroup });
  }

  return groups;
}

interface MessageCardProps {
  message: StreamMessage;
  toolStatusMap: Map<string, ToolStatus>;
  toolResultsMap: Map<string, ToolResultBlock>;
  permissionRequests: PermissionRequestPayload[];
  onPermissionResult: (toolUseId: string, result: PermissionResult) => void;
}

export function MessageCard({
  message,
  toolStatusMap,
  toolResultsMap,
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
          toolResultsMap={toolResultsMap}
          permissionRequests={permissionRequests}
          onPermissionResult={onPermissionResult}
        />
      );

    case 'user':
      // user 消息中的 tool_result 已经在 ToolGroup 中显示，这里不再单独渲染
      return null;

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
      <div className="max-w-[80%] bg-white border border-[var(--border)] rounded-lg rounded-br-sm px-4 py-2">
        <div className="text-sm whitespace-pre-wrap">{prompt}</div>
      </div>
    </div>
  );
}

// Assistant 消息卡片
function AssistantCard({
  content,
  toolStatusMap,
  toolResultsMap,
  permissionRequests,
  onPermissionResult,
}: {
  content: ContentBlock[];
  toolStatusMap: Map<string, ToolStatus>;
  toolResultsMap: Map<string, ToolResultBlock>;
  permissionRequests: PermissionRequestPayload[];
  onPermissionResult: (toolUseId: string, result: PermissionResult) => void;
}) {
  // 将内容分组：连续的 tool_use 合并为一组
  const groups = useMemo(() => groupContentBlocks(content), [content]);

  return (
    <div className="my-3 min-w-0">
      {groups.map((group, idx) => {
        if (group.type === 'tool_group') {
          // 检查是否有 AskUserQuestion 需要特殊处理
          const askUserBlock = group.blocks.find(
            (b) => b.name === 'AskUserQuestion'
          );
          const matchingRequest = askUserBlock
            ? permissionRequests.find((req) => {
                const input = askUserBlock.input as unknown as AskUserQuestionInput;
                const reqSignature = getAskUserQuestionSignature(req.input);
                const blockSignature = getAskUserQuestionSignature(input);
                return reqSignature === blockSignature;
              })
            : null;

          return (
            <div key={idx}>
              <ToolGroup
                toolUseBlocks={group.blocks}
                toolResults={toolResultsMap}
                toolStatusMap={toolStatusMap}
              />
              {matchingRequest && (
                <DecisionPanel
                  input={matchingRequest.input}
                  onSubmit={(result) =>
                    onPermissionResult(matchingRequest.toolUseId, result)
                  }
                />
              )}
            </div>
          );
        }
        // text, thinking 块单独渲染
        return (
          <ContentBlockCard
            key={idx}
            block={group.block}
            toolStatusMap={toolStatusMap}
            permissionRequests={permissionRequests}
            onPermissionResult={onPermissionResult}
          />
        );
      })}
    </div>
  );
}


// 内容块卡片（仅处理 text 和 thinking，tool_use 由 ToolGroup 处理）
function ContentBlockCard({
  block,
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

    default:
      return null;
  }
}
