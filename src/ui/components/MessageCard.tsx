import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Copy, Check, Pencil, RotateCcw } from 'lucide-react';
import { MDContent } from '../render/markdown';
import { useAppStore } from '../store/useAppStore';
import { DecisionPanel, getAskUserQuestionSignature } from './DecisionPanel';
import { ToolGroup } from './ToolGroup';
import { AttachmentChips } from './AttachmentChips';
import { AttachmentPreviewGrid } from './AttachmentPreviewGrid';
import { ThinkingBlock } from './ThinkingBlock';
import { SelectedClaudeCommandChip } from './SelectedClaudeCommandChip';
import { SelectedClaudeSkillChip } from './SelectedClaudeSkillChip';
import { getContentBlocks } from '../utils/message-content';
import type { ClaudeSlashCommand } from '../utils/claude-slash';
import { buildClaudeSlashCommands, getSessionSlashCommands, parseSelectedSlashCommandPrompt } from '../utils/claude-slash';
import type { ClaudeSkillSummary } from '../types';
import { getSessionSkillNames, mergeClaudeSkills, parseSelectedSkillPrompt } from '../utils/claude-skills';
import type {
  StreamMessage,
  Attachment,
  ContentBlock,
  ToolStatus,
  PermissionRequestPayload,
  AskUserQuestionInput,
  PermissionResult,
} from '../types';

type UserPromptPrefixDisplay =
  | { kind: 'command'; command: ClaudeSlashCommand; remainder: string }
  | { kind: 'skill'; skill: ClaudeSkillSummary; remainder: string }
  | { kind: 'generic'; name: string; remainder: string };

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

function extractGenericSlashPrompt(prompt: string): { name: string; remainder: string } | null {
  const trimmed = prompt.trimStart();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const firstWhitespaceIndex = trimmed.search(/\s/);
  const name =
    firstWhitespaceIndex === -1
      ? trimmed.slice(1)
      : trimmed.slice(1, firstWhitespaceIndex);

  if (!name) {
    return null;
  }

  const remainder =
    firstWhitespaceIndex === -1 ? '' : trimmed.slice(firstWhitespaceIndex).replace(/^\s+/, '');

  return { name, remainder };
}

function isAskUserQuestionInput(input: unknown): input is AskUserQuestionInput {
  return (
    typeof input === 'object' &&
    input !== null &&
    'questions' in input &&
    Array.isArray((input as { questions?: unknown }).questions)
  );
}

interface MessageCardProps {
  message: StreamMessage;
  toolStatusMap: Map<string, ToolStatus>;
  toolResultsMap: Map<string, ToolResultBlock>;
  permissionRequests: PermissionRequestPayload[];
  onPermissionResult: (toolUseId: string, result: PermissionResult) => void;
  userPromptActions?: {
    canEditAndRetry: boolean;
    isSessionRunning: boolean;
    onResend: (prompt: string, attachments?: Attachment[]) => void;
  };
}

export function MessageCard({
  message,
  toolStatusMap,
  toolResultsMap,
  permissionRequests,
  onPermissionResult,
  userPromptActions,
}: MessageCardProps) {
  switch (message.type) {
    case 'user_prompt':
      return (
        <UserPromptCard
          prompt={message.prompt}
          attachments={message.attachments}
          createdAt={message.createdAt}
          actions={userPromptActions}
        />
      );

    case 'system':
      // 不再显示 Session Started 卡片，CWD 已移至右上角
      return null;

    case 'assistant':
      return (
        <AssistantCard
          content={message.message.content as unknown}
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
      // Hide session summary (duration/cost/tokens) to avoid confusing pricing across providers.
      return null;

    case 'stream_event':
      // stream_event 消息在 App.tsx 中单独处理 partial streaming
      return null;

    default:
      return null;
  }
}

// 用户 prompt 卡片
function UserPromptCard({
  prompt,
  attachments,
  createdAt,
  actions,
}: {
  prompt: string;
  attachments?: Attachment[];
  createdAt?: number;
  actions?: {
    canEditAndRetry: boolean;
    isSessionRunning: boolean;
    onResend: (prompt: string, attachments?: Attachment[]) => void;
  };
}) {
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(prompt);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const {
    activeSessionId,
    sessions,
    claudeUserSkills,
    claudeProjectSkills,
  } = useAppStore();

  const activeSessionMessages = activeSessionId ? sessions[activeSessionId]?.messages || [] : [];
  const availableSkills = useMemo(
    () => mergeClaudeSkills(
      claudeUserSkills,
      claudeProjectSkills,
      getSessionSkillNames(activeSessionMessages)
    ),
    [activeSessionMessages, claudeProjectSkills, claudeUserSkills]
  );
  const availableCommands = useMemo(
    () => buildClaudeSlashCommands(getSessionSlashCommands(activeSessionMessages)),
    [activeSessionMessages]
  );
  const promptPrefixDisplay = useMemo<UserPromptPrefixDisplay | null>(() => {
    const commandState = parseSelectedSlashCommandPrompt(prompt, availableCommands);
    if (commandState) {
      return {
        kind: 'command',
        command: commandState.command,
        remainder: commandState.remainder,
      };
    }

    const skillState = parseSelectedSkillPrompt(prompt, availableSkills);
    if (skillState) {
      return {
        kind: 'skill',
        skill: skillState.skill,
        remainder: skillState.remainder,
      };
    }

    const genericState = extractGenericSlashPrompt(prompt);
    if (genericState) {
      return {
        kind: 'generic',
        name: genericState.name,
        remainder: genericState.remainder,
      };
    }

    return null;
  }, [availableCommands, availableSkills, prompt]);

  useEffect(() => {
    if (!isEditing) {
      return;
    }

    const raf = requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    });

    return () => {
      cancelAnimationFrame(raf);
    };
  }, [isEditing]);

  const canEditAndRetry = !!actions?.canEditAndRetry && !actions?.isSessionRunning;

  const copyTitle = copied ? 'Copied' : 'Copy';
  const editTitle = actions?.isSessionRunning
    ? 'Stop the session to edit'
    : actions?.canEditAndRetry
      ? 'Edit'
      : 'Only the latest message can be edited';
  const retryTitle = actions?.isSessionRunning
    ? 'Stop the session to retry'
    : actions?.canEditAndRetry
      ? 'Retry'
      : 'Only the latest message can be retried';

  const timestampLabel =
    typeof createdAt === 'number'
      ? new Date(createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : '';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  const handleRetry = () => {
    if (!canEditAndRetry) return;
    actions?.onResend(prompt, attachments);
  };

  const handleEdit = () => {
    if (!canEditAndRetry) return;
    setDraft(prompt);
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setDraft(prompt);
  };

  const handleSaveAndRetry = () => {
    const nextPrompt = draft.trim();
    if (!nextPrompt) return;
    actions?.onResend(nextPrompt, attachments);
    setIsEditing(false);
  };

  const imageAttachments = (attachments || []).filter((a) => a.kind === 'image');
  const fileAttachments = (attachments || []).filter((a) => a.kind !== 'image');

  return (
    <div className="flex justify-end my-3">
      <div className="max-w-[78%] flex flex-col items-end group">
        {attachments && attachments.length > 0 && (
          <div className="w-full flex flex-col items-end gap-2 mb-1">
            <AttachmentPreviewGrid attachments={imageAttachments} />
            {fileAttachments.length > 0 && (
              <div className="flex justify-end">
                <AttachmentChips attachments={fileAttachments} variant="message" />
              </div>
            )}
          </div>
        )}
        <div
          className={`${isEditing ? 'w-full px-4 py-3 rounded-[22px]' : 'max-w-full px-5 py-2.5 rounded-[18px]'}`}
          style={{
            background: 'var(--user-bubble-bg)',
            border: '1px solid var(--user-bubble-border)',
            boxShadow: 'var(--user-bubble-shadow)',
          }}
        >
          {isEditing ? (
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(8, Math.max(2, draft.split('\n').length))}
              className="w-full min-w-[320px] bg-transparent text-[13px] text-[var(--text-primary)] leading-6 outline-none resize-none whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  handleCancelEdit();
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSaveAndRetry();
                }
              }}
            />
          ) : (
            <div
              className={
                promptPrefixDisplay
                  ? 'flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] leading-[1.45] text-[var(--text-primary)]'
                  : ''
              }
            >
              {promptPrefixDisplay &&
                (promptPrefixDisplay.kind === 'skill' ? (
                  <SelectedClaudeSkillChip skill={promptPrefixDisplay.skill} compact />
                ) : promptPrefixDisplay.kind === 'command' ? (
                  <SelectedClaudeCommandChip command={promptPrefixDisplay.command} compact />
                ) : (
                  <GenericSlashChip name={promptPrefixDisplay.name} compact />
                ))}

              {(!promptPrefixDisplay || promptPrefixDisplay.remainder) && (
                <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
                  {promptPrefixDisplay ? promptPrefixDisplay.remainder : prompt}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Action bar (appears below bubble) */}
        <div
          className={`mt-1 h-6 flex items-center justify-end gap-3 text-xs text-[var(--text-muted)] transition-opacity ${
            isEditing
              ? 'opacity-100 pointer-events-auto'
              : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto'
          }`}
        >
          {timestampLabel && <span className="tabular-nums">{timestampLabel}</span>}

          {isEditing ? (
            <div className="flex items-center gap-2">
              <button
                onClick={handleCancelEdit}
                className="inline-flex items-center rounded-full px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                title="Cancel"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveAndRetry}
                disabled={!draft.trim()}
                className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--accent-light)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] shadow-sm transition-colors hover:border-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 disabled:cursor-not-allowed"
                title="Send"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Send
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <IconButton
                onClick={handleRetry}
                title={retryTitle}
                ariaLabel="Retry"
                disabled={!actions || !canEditAndRetry}
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </IconButton>
              <IconButton
                onClick={handleEdit}
                title={editTitle}
                ariaLabel="Edit"
                disabled={!actions || !canEditAndRetry}
              >
                <Pencil className="w-3.5 h-3.5" />
              </IconButton>
              <IconButton onClick={handleCopy} title={copyTitle} ariaLabel="Copy">
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              </IconButton>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function IconButton({
  children,
  onClick,
  title,
  ariaLabel,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  title: string;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      disabled={disabled}
      className="p-1 rounded transition-colors hover:text-[var(--text-secondary)] disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

function GenericSlashChip({ name, compact = false }: { name: string; compact?: boolean }) {
  const label = compact ? name.replace(/^\//, '') : `/${name}`;

  return (
    <div
      className={`inline-flex max-w-full items-center border border-[var(--border)] bg-[var(--bg-tertiary)] shadow-sm ${
        compact ? 'rounded-lg px-2 py-0.5' : 'rounded-2xl px-2.5 py-2'
      }`}
    >
      <div
        className={`truncate font-medium text-[var(--text-primary)] ${
          compact ? 'max-w-[180px] text-[11px]' : 'max-w-[260px] text-sm'
        }`}
      >
        {label}
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
  content: unknown;
  toolStatusMap: Map<string, ToolStatus>;
  toolResultsMap: Map<string, ToolResultBlock>;
  permissionRequests: PermissionRequestPayload[];
  onPermissionResult: (toolUseId: string, result: PermissionResult) => void;
}) {
  // 将内容分组：连续的 tool_use 合并为一组
  const groups = useMemo(() => groupContentBlocks(getContentBlocks(content)), [content]);

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
                if (!isAskUserQuestionInput(req.input)) {
                  return false;
                }
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
        <div className="min-w-0 overflow-x-auto">
          <MDContent content={block.text} />
        </div>
      );

    case 'thinking':
      return <ThinkingBlock content={block.thinking} />;

    default:
      return null;
  }
}
