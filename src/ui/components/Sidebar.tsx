import { useState, forwardRef, useMemo } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Dialog from '@radix-ui/react-dialog';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import { SidebarSearch } from './search/SidebarSearch';
import type { SessionView } from '../types';

export function Sidebar() {
  const { sessions, activeSessionId, setActiveSession, setShowNewSession, sidebarSearchQuery, setShowMcpSettings } = useAppStore();
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [selectedSession, setSelectedSession] = useState<SessionView | null>(null);

  // 按 updatedAt 降序排序并过滤
  const sessionList = useMemo(() => {
    const sorted = Object.values(sessions).sort((a, b) => b.updatedAt - a.updatedAt);
    if (!sidebarSearchQuery.trim()) return sorted;

    const query = sidebarSearchQuery.toLowerCase();
    return sorted.filter(
      (session) =>
        session.title.toLowerCase().includes(query) ||
        session.cwd?.toLowerCase().includes(query)
    );
  }, [sessions, sidebarSearchQuery]);

  const handleDelete = (sessionId: string) => {
    sendEvent({ type: 'session.delete', payload: { sessionId } });
  };

  const handleResumeCommand = (session: SessionView) => {
    setSelectedSession(session);
    setResumeDialogOpen(true);
  };

  const copyResumeCommand = () => {
    if (selectedSession?.claudeSessionId) {
      navigator.clipboard.writeText(`claude --teleport ${selectedSession.claudeSessionId}`);
    }
    setResumeDialogOpen(false);
  };

  return (
    <div className="w-64 bg-[var(--bg-secondary)] border-r border-[var(--border)] flex flex-col h-full">
      {/* 拖拽区域 */}
      <div className="h-8 drag-region" />

      {/* New Session 按钮 */}
      <button
        onClick={() => {
          setActiveSession(null);
          setShowNewSession(true);
        }}
        className="group mx-2 mt-4 mb-4 px-2 py-2 flex items-center gap-3 text-left no-drag rounded-xl hover:bg-[var(--bg-tertiary)] transition-colors"
      >
        <span className="text-[#92918E] text-[22px] font-normal leading-none">+</span>
        <span className="text-base font-medium">New Task</span>
      </button>

      {/* Sessions 标题栏 */}
      <div className="px-4 py-2 flex items-center justify-between">
        <span className="text-sm text-[var(--text-muted)]">Sessions</span>
      </div>

      {/* 搜索框 */}
      <div className="px-4 pb-3">
        <SidebarSearch />
      </div>

      {/* Session List */}
      <div className="flex-1 overflow-y-auto px-2">
        {sessionList.map((session) => (
          <SessionItem
            key={session.id}
            session={session}
            isActive={activeSessionId === session.id}
            onClick={() => {
              setActiveSession(session.id);
              setShowNewSession(false);
            }}
            onDelete={() => handleDelete(session.id)}
            onCopyResume={() => handleResumeCommand(session)}
          />
        ))}

        {sessionList.length === 0 && (
          <div className="text-center text-[var(--text-muted)] py-8 text-sm">
            {sidebarSearchQuery ? 'No matching sessions' : 'No sessions yet'}
          </div>
        )}
      </div>

      {/* Settings Button */}
      <div className="p-4 border-t border-[var(--border)]">
        <button
          onClick={() => setShowMcpSettings(true)}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition-colors"
        >
          <SettingsIcon />
          <span>MCP Settings</span>
        </button>
      </div>

      {/* Resume Command Dialog */}
      <Dialog.Root open={resumeDialogOpen} onOpenChange={setResumeDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50" />
          <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-6 w-[480px] shadow-xl">
            <Dialog.Title className="text-lg font-semibold mb-4">
              Resume in Claude Code
            </Dialog.Title>
            <Dialog.Description className="text-[var(--text-secondary)] text-sm mb-4">
              Run this command in your terminal to continue this session in Claude Code:
            </Dialog.Description>

            <div className="bg-[var(--bg-tertiary)] rounded-lg p-3 font-mono text-sm mb-4 break-all">
              claude --teleport {selectedSession?.claudeSessionId}
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setResumeDialogOpen(false)}
                className="px-4 py-2 rounded-lg text-sm hover:bg-[var(--bg-tertiary)] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={copyResumeCommand}
                className="px-4 py-2 rounded-lg text-sm bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors"
              >
                Copy Command
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

// SessionItem 组件
function SessionItem({
  session,
  isActive,
  onClick,
  onDelete,
  onCopyResume,
}: {
  session: SessionView;
  isActive: boolean;
  onClick: () => void;
  onDelete: () => void;
  onCopyResume: () => void;
}) {
  // 格式化时间：4:36 pm
  const formattedTime = new Date(session.updatedAt).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  // 生成短 ID（如果有 claudeSessionId）
  const shortId = session.claudeSessionId
    ? session.claudeSessionId.slice(0, 14)
    : null;

  return (
    <div
      className={`group relative rounded-xl p-3 mb-1 cursor-pointer transition-colors ${
        isActive
          ? 'bg-[var(--accent-light)]'
          : 'hover:bg-[var(--bg-tertiary)]'
      }`}
      onClick={onClick}
    >
      {/* 标题 */}
      <div className="text-sm font-medium truncate pr-6">
        {session.title}
      </div>

      {/* 副标题：session-id · 时间 */}
      <div className="text-xs text-[var(--text-muted)] mt-1 truncate">
        {shortId && <span>{shortId} · </span>}
        {formattedTime}
      </div>

      {/* 更多菜单 - hover 显示 */}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            className="absolute top-3 right-2 opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[var(--border)] transition-opacity"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreIcon />
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg p-1 min-w-[160px] shadow-lg z-50"
            sideOffset={5}
          >
            {session.claudeSessionId && (
              <DropdownMenu.Item
                className="flex items-center gap-2 px-3 py-2 text-sm rounded cursor-pointer hover:bg-[var(--border)] outline-none"
                onClick={onCopyResume}
              >
                <CopyIcon />
                Copy Resume Command
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Item
              className="flex items-center gap-2 px-3 py-2 text-sm rounded cursor-pointer hover:bg-[var(--border)] outline-none text-red-400"
              onClick={onDelete}
            >
              <TrashIcon />
              Delete
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}

// Icons
function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <circle cx="8" cy="3" r="1.5" />
      <circle cx="8" cy="8" r="1.5" />
      <circle cx="8" cy="13" r="1.5" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
