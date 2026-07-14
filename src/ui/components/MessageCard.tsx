import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Copy, Check, History, Pencil, Plug, RotateCcw, Terminal } from './icons';
import { cn } from '@/ui/lib/utils';
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
  | { kind: 'generic'; name: string; prefix: '/' | '$'; remainder: string };

// 工具结果块类型
type ToolResultBlock = ContentBlock & { type: 'tool_result' };

function extractGenericSlashPrompt(
  prompt: string
): { name: string; prefix: '/' | '$'; remainder: string } | null {
  const trimmed = prompt.trimStart();
  const prefix = trimmed[0];
  if (prefix !== '/' && prefix !== '$') {
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

  return { name, prefix, remainder };
}

interface MessageCardProps {
  message: StreamMessage;
  sessionId?: string | null;
  toolStatusMap: Map<string, ToolStatus>;
  toolResultsMap: Map<string, ToolResultBlock>;
  /** Subagent messages keyed by Task tool_use id — nests them under Task rows. */
  subagentMessagesByParent?: Map<string, StreamMessage[]>;
  assistantPresentation?: 'answer' | 'progress';
  hideAssistantCopyBar?: boolean;
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
  subagentMessagesByParent,
  assistantPresentation = 'answer',
  hideAssistantCopyBar = false,
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
          subagentMessagesByParent={subagentMessagesByParent}
          presentation={assistantPresentation}
          hideCopyBar={hideAssistantCopyBar}
        />
      );

    case 'proposed_plan':
      return <ProposedPlanCard planMarkdown={message.planMarkdown} />;

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
  const [open, setOpen] = useState(false);
  const isAuto = message.compactMetadata.trigger === 'auto';
  const label = isAuto ? '对话已自动压缩' : '对话已压缩';
  const tokensLabel =
    message.compactMetadata.preTokens > 0
      ? formatCompactTokens(message.compactMetadata.preTokens)
      : null;
  const explanation = isAuto
    ? '上下文接近模型上限，较早的对话已被自动总结为摘要以腾出空间。AI 仍保留这些内容的要点，但逐字细节可能已省略。'
    : '你手动压缩了对话，较早的内容已被总结为摘要以腾出上下文空间。';

  return (
    <div className="my-6 flex justify-center">
      <div className="w-full max-w-[720px]">
        <div className="relative flex items-center justify-center">
          <div className="absolute inset-x-0 top-1/2 border-t border-[var(--border)]" />
          <div
            className="relative z-10"
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
          >
            <button
              type="button"
              className="flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1 text-[11px] font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
              aria-label={`${label}${tokensLabel ? ` · 压缩前 ${tokensLabel} tokens` : ''}`}
            >
              <ArchiveIcon />
              <span>{label}</span>
              {tokensLabel ? (
                <span className="text-[var(--text-muted)]">· {tokensLabel} tokens</span>
              ) : null}
            </button>

            {open ? (
              <div className="absolute bottom-full left-1/2 z-40 mb-2 w-[280px] max-w-[calc(100vw-1.5rem)] -translate-x-1/2 rounded-[8px] border border-[color-mix(in_srgb,var(--border)_72%,transparent)] bg-[var(--bg-primary)] px-3 py-2.5 text-left text-[12px] leading-5 text-[var(--text-secondary)] shadow-[0_18px_44px_rgba(15,23,42,0.08)]">
                {explanation}
                {tokensLabel ? (
                  <div className="mt-1.5 border-t border-[var(--border)] pt-1.5 text-[11px] text-[var(--text-muted)]">
                    压缩前上下文约 {tokensLabel} tokens
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function ArchiveIcon() {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="4" width="20" height="5" rx="1" />
      <path d="M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9" />
      <path d="M10 13h4" />
    </svg>
  );
}

function ProposedPlanCard({ planMarkdown }: { planMarkdown: string }) {
  return (
    <div className="my-3 flex justify-start">
      <div className="w-full max-w-[760px] rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--bg-secondary)] p-4 shadow-sm">
        <div className="mb-3 flex min-w-0 items-center gap-2">
          <span className="rounded-md bg-[var(--accent-light)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--accent)]">
            Plan
          </span>
          <span className="min-w-0 truncate text-sm font-medium text-[var(--text-primary)]">
            Proposed plan
          </span>
        </div>
        <StructuredResponse content={planMarkdown} />
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
    /** Claude only: rewind conversation/files back to before this message. */
    onRewind?: () => void;
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
    const skillState = parseSelectedSkillPrompt(prompt, availableSkills, ['/', '$']);
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
        prefix: genericState.prefix,
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
                      <GenericSlashChip
                        name={promptPrefixDisplay.name}
                        prefix={promptPrefixDisplay.prefix}
                        compact
                      />
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
              {actions?.onRewind ? (
                <IconButton
                  onClick={() => actions.onRewind?.()}
                  title={actions.isSessionRunning ? 'Stop the session to rewind' : 'Rewind to before this message'}
                  ariaLabel="Rewind to before this message"
                  disabled={actions.isSessionRunning}
                >
                  <History className="w-3.5 h-3.5" />
                </IconButton>
              ) : null}
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
  className,
}: {
  children: ReactNode;
  onClick: () => void;
  title: string;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      disabled={disabled}
      className={cn(
        'p-1 rounded transition-colors text-[var(--text-muted)]/60 hover:text-[var(--text-secondary)] disabled:opacity-50 disabled:cursor-not-allowed',
        className
      )}
    >
      {children}
    </button>
  );
}

function GenericSlashChip({
  name,
  prefix = '/',
  compact = false,
}: {
  name: string;
  prefix?: '/' | '$';
  compact?: boolean;
}) {
  const cleanedName = name.replace(/^plugin:/i, '').replace(/^\//, '');
  const label = prefix === '$' || compact ? cleanedName : `/${cleanedName}`;
  const Icon = prefix === '$' ? Plug : Terminal;

  return (
    <div
      className={`composer-inline-chip composer-inline-chip--message ${
        prefix === '$' ? 'composer-inline-chip--plugin' : 'composer-inline-chip--command'
      } ${compact ? '' : 'composer-inline-chip--large'}`}
      title={`${prefix}${name}`}
    >
      <span className="composer-inline-chip__icon" aria-hidden="true">
        <Icon />
      </span>
      <span className="composer-inline-chip__label max-w-[180px]">
        {label}
      </span>
    </div>
  );
}


type AssistantMessage = StreamMessage & { type: 'assistant' };

export function getAssistantMarkdownToCopy(message: StreamMessage): string {
  if (message.type !== 'assistant') {
    return '';
  }

  return getContentBlocks(message.message.content as unknown)
    .filter(
      (block): block is ContentBlock & { type: 'text' } =>
        block.type === 'text' && Boolean(block.text?.trim())
    )
    .map((block) => block.text)
    .join('\n\n');
}

export function AssistantCopyAction({
  text,
  className,
  inline = false,
}: {
  text: string;
  className?: string;
  inline?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  if (!text.trim()) {
    return null;
  }

  return (
    <div
      className={cn(
        inline ? 'flex items-center justify-start' : 'mt-1 flex items-center justify-start',
        'opacity-0 pointer-events-none transition-opacity group-hover:opacity-100 group-hover:pointer-events-auto',
        className
      )}
    >
      <IconButton
        onClick={handleCopy}
        title={copied ? 'Copied' : 'Copy as markdown'}
        ariaLabel="Copy as markdown"
      >
        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
      </IconButton>
    </div>
  );
}

// Assistant 消息卡片：trace 内容（thinking + tool_use）走 workstream，
// text 块走 markdown 渲染。
function AssistantCard({
  message,
  toolStatusMap,
  toolResultsMap,
  subagentMessagesByParent,
  presentation,
  hideCopyBar,
}: {
  message: AssistantMessage;
  toolStatusMap: Map<string, ToolStatus>;
  toolResultsMap: Map<string, ToolResultBlock>;
  subagentMessagesByParent?: Map<string, StreamMessage[]>;
  presentation: 'answer' | 'progress';
  hideCopyBar?: boolean;
}) {
  const isStreaming = message.streaming === true;
  const isProgress = presentation === 'progress';
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
  const memoryCitationBlocks = useMemo(
    () =>
      blocks.filter(
        (block): block is ContentBlock & { type: 'memory_citations' } =>
          block.type === 'memory_citations' && block.citations.length > 0
      ),
    [blocks]
  );

  const markdownToCopy = useMemo(
    () => textBlocks.map((block) => block.text).join('\n\n'),
    [textBlocks]
  );

  const showCopyBar = !hideCopyBar && !isProgress && !isStreaming && markdownToCopy.length > 0;

  return (
    <div
      className={
        isProgress
          ? 'my-2 min-w-0 border-l-2 border-[var(--border)] py-0.5 pl-3 text-[13px] text-[var(--text-secondary)]'
          : 'my-3 min-w-0 group'
      }
    >
      {hasTrace ? (
        <ToolExecutionBatch
          messages={[traceOnlyMessage]}
          toolStatusMap={toolStatusMap}
          toolResultsMap={toolResultsMap}
          isSessionRunning={isStreaming}
          subagentMessagesByParent={subagentMessagesByParent}
        />
      ) : null}
      {textBlocks.map((block, idx) => (
        <div key={`text-${idx}`} className="min-w-0 overflow-x-auto">
          <StructuredResponse
            content={block.text}
            streaming={isStreaming}
            className={isProgress ? 'assistant-progress-markdown' : ''}
          />
        </div>
      ))}
      {!isProgress && memoryCitationBlocks.map((block, idx) => (
        <MemoryCitationsBlock key={`memory-citations-${idx}`} block={block} />
      ))}
      {showCopyBar ? <AssistantCopyAction text={markdownToCopy} /> : null}
    </div>
  );
}

function MemoryCitationsBlock({
  block,
}: {
  block: ContentBlock & { type: 'memory_citations' };
}) {
  const [expanded, setExpanded] = useState(false);
  const { openRightUtilityTab } = useAppStore();
  const count = block.citations.length;

  const openCitation = (citation: (ContentBlock & { type: 'memory_citations' })['citations'][number]) => {
    if (!citation.source.trim()) return;
    openRightUtilityTab('files', { instantReveal: true });
    window.setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('aegis:open-project-file', {
          detail: {
            path: citation.source,
            external: true,
            lineStart: citation.lineStart,
            lineEnd: citation.lineEnd,
          },
        })
      );
    }, 0);
  };

  return (
    <div className="mt-3 max-w-[760px] text-[12px] text-[var(--text-muted)]">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="inline-flex items-center gap-1.5 py-1 text-[12px] leading-5 text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
        aria-expanded={expanded}
      >
        <ChevronRight
          className={`h-3.5 w-3.5 transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <span>
          {count} memory citation{count === 1 ? '' : 's'}
        </span>
      </button>
      {expanded ? (
        <div className="mt-3 space-y-3 pl-3">
          {block.citations.map((citation, index) => {
            const lineLabel =
              typeof citation.lineStart === 'number'
                ? `line${citation.lineEnd && citation.lineEnd !== citation.lineStart ? 's' : ''} ${
                    citation.lineEnd && citation.lineEnd !== citation.lineStart
                      ? `${citation.lineStart}-${citation.lineEnd}`
                      : citation.lineStart
                  }`
                : '';
            const sourceName = citation.source.split('/').filter(Boolean).pop() || citation.source;
            return (
              <div key={`${citation.source}-${citation.lineStart ?? 'all'}-${index}`}>
                <div className="flex min-w-0 flex-wrap items-baseline gap-1.5">
                  <button
                    type="button"
                    onClick={() => openCitation(citation)}
                    className="font-medium text-[var(--accent)] hover:underline"
                    title={citation.source}
                  >
                    {sourceName}
                  </button>
                  {lineLabel ? (
                    <button
                      type="button"
                      onClick={() => openCitation(citation)}
                      className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:underline"
                    >
                      {lineLabel}
                    </button>
                  ) : null}
                </div>
                {citation.note ? (
                  <div className="mt-0.5 text-[var(--text-muted)]/85">{citation.note}</div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
