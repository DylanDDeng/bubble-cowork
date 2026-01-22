import { useState, useMemo, useCallback } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Dialog from '@radix-ui/react-dialog';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import { SidebarSearch } from './search/SidebarSearch';
import { StatusFilter } from './StatusFilter';
import { StatusIcon } from './StatusIcon';
import { StatusMenu } from './StatusMenu';
import { FolderMenu } from './FolderMenu';
import { ViewModeToggle } from './ViewModeToggle';
import { FolderTreeView } from './FolderTreeView';
import { NewFolderDialog } from './NewFolderDialog';
import type { SessionView, StatusConfig } from '../types';

// 时间分组类型
type TimeGroup = 'pinned' | 'today' | 'yesterday' | 'previous7Days' | 'previous30Days' | 'earlier';

// 分组显示名称
const TIME_GROUP_LABELS: Record<TimeGroup, string> = {
  pinned: 'Pinned',
  today: 'Today',
  yesterday: 'Yesterday',
  previous7Days: 'Previous 7 Days',
  previous30Days: 'Previous 30 Days',
  earlier: 'Earlier',
};

// 根据时间戳判断所属分组
function getTimeGroup(timestamp: number): TimeGroup {
  const now = new Date();

  // 获取今天的开始时间 (00:00:00)
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const days7Start = todayStart - 7 * 24 * 60 * 60 * 1000;
  const days30Start = todayStart - 30 * 24 * 60 * 60 * 1000;

  if (timestamp >= todayStart) return 'today';
  if (timestamp >= yesterdayStart) return 'yesterday';
  if (timestamp >= days7Start) return 'previous7Days';
  if (timestamp >= days30Start) return 'previous30Days';
  return 'earlier';
}

export function Sidebar() {
  const { sessions, activeSessionId, setActiveSession, setShowNewSession, sidebarSearchQuery, setShowSettings, statusFilter, statusConfigs, sidebarViewMode } = useAppStore();
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [selectedSession, setSelectedSession] = useState<SessionView | null>(null);
  const [newFolderDialogOpen, setNewFolderDialogOpen] = useState(false);
  const [newFolderSessionId, setNewFolderSessionId] = useState<string | null>(null);

  const handleNewFolderRequest = useCallback((sessionId: string) => {
    setNewFolderSessionId(sessionId);
    setNewFolderDialogOpen(true);
  }, []);

  // 按 updatedAt 降序排序、过滤并分组
  const groupedSessions = useMemo(() => {
    let sorted = Object.values(sessions).sort((a, b) => b.updatedAt - a.updatedAt);

    // 搜索过滤
    if (sidebarSearchQuery.trim()) {
      const query = sidebarSearchQuery.toLowerCase();
      sorted = sorted.filter(
        (session) =>
          session.title.toLowerCase().includes(query) ||
          session.cwd?.toLowerCase().includes(query)
      );
    }

    // 状态过滤
    if (statusFilter !== 'all') {
      if (statusFilter === 'open') {
        const openIds = new Set(statusConfigs.filter(s => s.category === 'open').map(s => s.id));
        sorted = sorted.filter(s => openIds.has(s.todoState || 'todo'));
      } else if (statusFilter === 'closed') {
        const closedIds = new Set(statusConfigs.filter(s => s.category === 'closed').map(s => s.id));
        sorted = sorted.filter(s => closedIds.has(s.todoState || 'todo'));
      } else {
        sorted = sorted.filter(s => (s.todoState || 'todo') === statusFilter);
      }
    }

    // 分离置顶和非置顶的 session
    const pinnedSessions = sorted.filter((s) => s.pinned);
    const unpinnedSessions = sorted.filter((s) => !s.pinned);

    // 按时间分组（只对非置顶的 session）
    const groups: { group: TimeGroup; sessions: SessionView[] }[] = [];

    // 先添加置顶分组
    if (pinnedSessions.length > 0) {
      groups.push({ group: 'pinned', sessions: pinnedSessions });
    }

    // 再按时间分组
    const groupOrder: TimeGroup[] = ['today', 'yesterday', 'previous7Days', 'previous30Days', 'earlier'];

    for (const group of groupOrder) {
      const sessionsInGroup = unpinnedSessions.filter((s) => getTimeGroup(s.updatedAt) === group);
      if (sessionsInGroup.length > 0) {
        groups.push({ group, sessions: sessionsInGroup });
      }
    }

    return groups;
  }, [sessions, sidebarSearchQuery, statusFilter, statusConfigs]);

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
        className="group mx-2 mt-4 mb-4 px-2 py-2 flex items-center gap-3 text-left no-drag rounded-xl hover:bg-[var(--text-primary)]/5 transition-colors duration-150"
      >
        <span className="text-[#92918E] text-[22px] font-normal leading-none">+</span>
        <span className="text-base font-medium">New Task</span>
      </button>

      {/* Sessions 标题栏 */}
      <div className="px-4 py-2 flex items-center justify-between gap-2">
        <span className="text-sm text-[var(--text-muted)]">Sessions</span>
        <div className="flex items-center gap-2">
          <ViewModeToggle />
          <StatusFilter />
        </div>
      </div>

      {/* 搜索框 */}
      <div className="px-4 pb-3">
        <SidebarSearch />
      </div>

      {/* Session List */}
      <div className="flex-1 overflow-y-auto px-2">
        {sidebarViewMode === 'time' ? (
          // 时间视图
          <>
            {groupedSessions.map(({ group, sessions: groupSessions }) => (
              <div key={group}>
                <GroupHeader label={TIME_GROUP_LABELS[group]} />
                {groupSessions.map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    isActive={activeSessionId === session.id}
                    statusConfigs={statusConfigs}
                    onClick={() => {
                      setActiveSession(session.id);
                      setShowNewSession(false);
                    }}
                    onDelete={() => handleDelete(session.id)}
                    onCopyResume={() => handleResumeCommand(session)}
                    onTogglePin={() => sendEvent({ type: 'session.togglePin', payload: { sessionId: session.id } })}
                    onNewFolderRequest={handleNewFolderRequest}
                  />
                ))}
              </div>
            ))}

            {groupedSessions.length === 0 && (
              <div className="text-center text-[var(--text-muted)] py-8 text-sm">
                {sidebarSearchQuery ? 'No matching sessions' : 'No sessions yet'}
              </div>
            )}
          </>
        ) : (
          // 文件夹视图
          <FolderTreeView
            onSessionClick={(sessionId) => {
              setActiveSession(sessionId);
              setShowNewSession(false);
            }}
            onSessionDelete={handleDelete}
            onCopyResume={handleResumeCommand}
            onNewFolderRequest={handleNewFolderRequest}
          />
        )}
      </div>

      {/* Settings Button */}
      <div className="p-4 border-t border-[var(--border)]">
        <button
          onClick={() => setShowSettings(true)}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--text-primary)]/5 transition-colors duration-150"
        >
          <SettingsIcon />
          <span>Settings</span>
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

      {/* New Folder Dialog */}
      <NewFolderDialog
        open={newFolderDialogOpen}
        sessionId={newFolderSessionId}
        onOpenChange={setNewFolderDialogOpen}
      />
    </div>
  );
}

// GroupHeader 组件
function GroupHeader({ label }: { label: string }) {
  return (
    <div className="px-2 pt-4 pb-2 text-xs text-[var(--text-muted)] font-medium">
      {label}
    </div>
  );
}

// SessionItem 组件
function SessionItem({
  session,
  isActive,
  statusConfigs,
  onClick,
  onDelete,
  onCopyResume,
  onTogglePin,
  onNewFolderRequest,
}: {
  session: SessionView;
  isActive: boolean;
  statusConfigs: StatusConfig[];
  onClick: () => void;
  onDelete: () => void;
  onCopyResume: () => void;
  onTogglePin: () => void;
  onNewFolderRequest: (sessionId: string) => void;
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

  // 获取当前状态配置
  const currentTodoState = session.todoState || 'todo';
  const currentStatusConfig = statusConfigs.find(s => s.id === currentTodoState);

  return (
    <div
      className={`group relative rounded-xl p-3 mb-1 cursor-pointer transition-colors duration-150 ${
        isActive
          ? 'bg-[var(--text-primary)]/10'
          : 'hover:bg-[var(--text-primary)]/5'
      }`}
      onClick={onClick}
    >
      {/* 标题行：状态图标 + 置顶图标 + 标题 */}
      <div className="flex items-center gap-2 pr-6">
        {currentStatusConfig && (
          <StatusIcon status={currentStatusConfig} className="flex-shrink-0" />
        )}
        {session.pinned && (
          <span className="flex-shrink-0 text-[var(--text-muted)]">
            <PinIcon />
          </span>
        )}
        <span className="text-sm font-medium truncate">{session.title}</span>
      </div>

      {/* 副标题：session-id · 时间 */}
      <div className="text-xs text-[var(--text-muted)] mt-1 truncate pl-5">
        {shortId && <span>{shortId} · </span>}
        {formattedTime}
      </div>

      {/* 更多菜单 - hover 显示 */}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            className="absolute top-3 right-2 w-7 h-7 flex items-center justify-center opacity-0 group-hover:opacity-100 rounded-md hover:bg-[var(--text-primary)]/5 transition-all duration-150"
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
            <DropdownMenu.Item
              className="flex items-center gap-2 px-3 py-2 text-sm rounded-md cursor-pointer hover:bg-[var(--text-primary)]/5 outline-none transition-colors duration-150"
              onClick={onTogglePin}
            >
              <PinIcon />
              {session.pinned ? 'Unpin' : 'Pin to Top'}
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="h-px bg-[var(--border)] my-1" />
            <StatusMenu sessionId={session.id} currentStatus={currentTodoState} />
            <FolderMenu sessionId={session.id} currentFolderPath={session.folderPath} onNewFolderRequest={onNewFolderRequest} />
            <DropdownMenu.Separator className="h-px bg-[var(--border)] my-1" />
            {session.claudeSessionId && (
              <DropdownMenu.Item
                className="flex items-center gap-2 px-3 py-2 text-sm rounded-md cursor-pointer hover:bg-[var(--text-primary)]/5 outline-none transition-colors duration-150"
                onClick={onCopyResume}
              >
                <CopyIcon />
                Copy Resume Command
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Item
              className="flex items-center gap-2 px-3 py-2 text-sm rounded-md cursor-pointer hover:bg-[var(--text-primary)]/5 outline-none transition-colors duration-150 text-red-400"
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

function PinIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
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
