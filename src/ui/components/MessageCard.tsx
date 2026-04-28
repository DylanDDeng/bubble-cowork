import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Copy, Check, Pencil, RotateCcw } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { AttachmentChips } from './AttachmentChips';
import { AttachmentPreviewGrid } from './AttachmentPreviewGrid';
import { StructuredResponse } from './StructuredResponse';
import { SelectedClaudeCommandChip } from './SelectedClaudeCommandChip';
import { SelectedClaudeSkillChip } from './SelectedClaudeSkillChip';
import { ToolExecutionBatch } from './ToolExecutionBatch';
import { getContentBlocks, isAnyToolUseBlockType } from '../utils/message-content';
import type { ClaudeSlashCommand } from '../utils/claude-slash';
import { buildProviderSlashCommands, getSessionSlashCommands, parseSelectedSlashCommandPrompt } from '../utils/claude-slash';
import type { ClaudeSkillSummary } from '../types';
import { getSessionSkillNames, mergeClaudeSkills, parseSelectedSkillPrompt } from '../utils/claude-skills';
import type {
  StreamMessage,
  Attachment,
  ContentBlock,
  ToolStatus,
} from '../types';

type UserPromptPrefixDisplay =
  | { kind: 'command'; command: ClaudeSlashCommand; remainder: string }
  | { kind: 'skill'; skill: ClaudeSkillSummary; remainder: string }
  | { kind: 'generic'; name: string; remainder: string };

// 工具结果块类型
type ToolResultBlock = ContentBlock & { type: 'tool_result' };

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

interface MessageCardProps {
  message: StreamMessage;
  sessionId?: string | null;
  toolStatusMap: Map<string, ToolStatus>;
  toolResultsMap: Map<string, ToolResultBlock>;
  userPromptActions?: {
    canEditAndRetry: boolean;
    isSessionRunning: boolean;
    onResend: (prompt: string, attachments?: Attachment[]) => void;
  };
}

export function MessageCard({
  message,
  sessionId,
  toolStatusMap,
  toolResultsMap,
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
          sessionId={sessionId}
        />
      );

    case 'system':
      if (message.subtype === 'init') {
        return null;
      }
      if (message.subtype === 'compact_boundary') {
        return <CompactBoundaryCard message={message} />;
      }
      return null;

    case 'assistant':
      return (
        <AssistantCard
          message={message}
          toolStatusMap={toolStatusMap}
          toolResultsMap={toolResultsMap}
        />
      );

    case 'user':
      // user 消息里的 tool_result 已经被工作流批次吸收，单独渲染没意义
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

function formatCompactTokens(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return `${Math.round(value)}`;
}

function CompactBoundaryCard({
  message,
}: {
  message: Extract<StreamMessage, { type: 'system'; subtype: 'compact_boundary' }>;
}) {
  const isAuto = message.compactMetadata.trigger === 'auto';
  const label = isAuto ? 'auto compact' : 'compact';

  return (
    <div className="my-6 flex justify-center">
      <div className="w-full max-w-[720px]">
        <div className="relative flex items-center justify-center">
          <div className="absolute inset-x-0 top-1/2 border-t border-[var(--border)]" />
          <span className="relative z-10 bg-[var(--bg-primary)] px-3 text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
            {label}
            {message.compactMetadata.preTokens > 0 ? ` · ${formatCompactTokens(message.compactMetadata.preTokens)}` : ''}
          </span>
        </div>
      </div>
    </div>
  );
}

// 用户 prompt 卡片
function UserPromptCard({
  prompt,
  attachments,
  createdAt,
  actions,
  sessionId,
}: {
  prompt: string;
  attachments?: Attachment[];
  createdAt?: number;
  actions?: {
    canEditAndRetry: boolean;
    isSessionRunning: boolean;
    onResend: (prompt: string, attachments?: Attachment[]) => void;
  };
  sessionId?: string | null;
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

  const currentSessionId = sessionId ?? activeSessionId;
  const activeSession = currentSessionId ? sessions[currentSessionId] : null;
  const activeSessionMessages = activeSession?.messages || [];
  const availableSkills = useMemo(
    () => mergeClaudeSkills(
      claudeUserSkills,
      claudeProjectSkills,
      getSessionSkillNames(activeSessionMessages)
    ),
    [activeSessionMessages, claudeProjectSkills, claudeUserSkills]
  );
  const availableCommands = useMemo(
    () => buildProviderSlashCommands(activeSession?.provider || 'claude', getSessionSlashCommands(activeSessionMessages)),
    [activeSession?.provider, activeSessionMessages]
  );
  const promptPrefixDisplay = useMemo<UserPromptPrefixDisplay | null>(() => {
    const skillState = parseSelectedSkillPrompt(prompt, availableSkills);
    if (skillState) {
      return {
        kind: 'skill',
        skill: skillState.skill,
        remainder: skillState.remainder,
      };
    }

    const commandState = parseSelectedSlashCommandPrompt(prompt, availableCommands);
    if (commandState) {
      return {
        kind: 'command',
        command: commandState.command,
        remainder: commandState.remainder,
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
  const hasVisiblePrompt = !!prompt.trim();

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
        {(isEditing || hasVisiblePrompt || promptPrefixDisplay) && (
          <div
            className={`${isEditing ? 'w-full px-4 py-3 rounded-[var(--radius-2xl)]' : 'max-w-full px-5 py-2.5 rounded-[var(--radius-xl)]'}`}
            style={{
              background: 'var(--user-bubble-bg)',
              color: 'var(--user-bubble-text)',
              boxShadow: 'var(--user-bubble-shadow)',
            }}
          >
            {isEditing ? (
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={Math.min(8, Math.max(2, draft.split('\n').length))}
                className="w-full min-w-[320px] bg-transparent text-[13px] text-inherit leading-7 outline-none resize-none whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
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
              <div className="text-[13px] leading-[1.5] text-inherit">
                {promptPrefixDisplay && (
                  <div className="mr-2 inline-flex align-middle">
                    {promptPrefixDisplay.kind === 'skill' ? (
                      <SelectedClaudeSkillChip skill={promptPrefixDisplay.skill} compact />
                    ) : promptPrefixDisplay.kind === 'command' ? (
                      <SelectedClaudeCommandChip command={promptPrefixDisplay.command} compact />
                    ) : (
                      <GenericSlashChip name={promptPrefixDisplay.name} compact />
                    )}
                  </div>
                )}

                {(!promptPrefixDisplay || promptPrefixDisplay.remainder) && (
                  <span className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] align-middle">
                    {promptPrefixDisplay ? promptPrefixDisplay.remainder : prompt}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

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
                className="inline-flex items-center rounded-[var(--radius-xl)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                title="Cancel"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveAndRetry}
                disabled={!draft.trim()}
                className="inline-flex items-center gap-1.5 rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--accent-light)] px-3 py-1.5 text-xs font-medium text-[var(--text-primary)] shadow-sm transition-colors hover:border-[var(--text-muted)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 disabled:cursor-not-allowed"
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
      className={`inline-flex max-w-full items-center shadow-sm ${
        compact
          ? 'rounded-[var(--radius-lg)] px-2 py-0.5 border'
          : 'rounded-[var(--radius-xl)] px-2.5 py-2 border border-[var(--border)] bg-[var(--bg-tertiary)]'
      }`}
      style={
        compact
          ? {
              borderColor: 'var(--composer-chip-border)',
              backgroundColor: 'var(--composer-chip-bg)',
              color: 'var(--composer-chip-text)',
            }
          : undefined
      }
    >
      <div
        className={`truncate font-medium ${
          compact ? 'max-w-[180px] text-[11px] text-inherit' : 'max-w-[260px] text-sm text-[var(--text-primary)]'
        }`}
      >
        {label}
      </div>
    </div>
  );
}


type AssistantMessage = StreamMessage & { type: 'assistant' };

// Assistant 消息卡片：trace 内容（thinking + tool_use）走 workstream，
// text 块走 markdown 渲染。
function AssistantCard({
  message,
  toolStatusMap,
  toolResultsMap,
}: {
  message: AssistantMessage;
  toolStatusMap: Map<string, ToolStatus>;
  toolResultsMap: Map<string, ToolResultBlock>;
}) {
  const isStreaming = message.streaming === true;
  const blocks = useMemo(
    () => getContentBlocks(message.message.content as unknown),
    [message.message.content]
  );
  const hasTrace = useMemo(
    () => blocks.some((block) => block.type === 'thinking' || isAnyToolUseBlockType(block.type)),
    [blocks]
  );
  const traceOnlyMessage = useMemo(
    () => ({
      ...message,
      message: {
        ...message.message,
        content: blocks.filter(
          (block) => block.type === 'thinking' || isAnyToolUseBlockType(block.type)
        ),
      },
    }),
    [blocks, message]
  );
  const textBlocks = useMemo(
    () =>
      blocks.filter(
        (block): block is ContentBlock & { type: 'text' } =>
          block.type === 'text' && Boolean(block.text?.trim())
      ),
    [blocks]
  );

  return (
    <div className="my-3 min-w-0">
      {hasTrace ? (
        <ToolExecutionBatch
          messages={[traceOnlyMessage]}
          toolStatusMap={toolStatusMap}
          toolResultsMap={toolResultsMap}
          isSessionRunning={isStreaming}
        />
      ) : null}
      {textBlocks.map((block, idx) => (
        <div key={`text-${idx}`} className="min-w-0 overflow-x-auto">
          <StructuredResponse content={block.text} streaming={isStreaming} />
        </div>
      ))}
    </div>
  );
}
