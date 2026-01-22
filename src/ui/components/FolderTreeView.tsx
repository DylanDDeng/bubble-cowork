import { useMemo } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import {
  buildFolderTreeWithSessions,
  getFolderDisplayName,
  countSessionsInNode,
  type FolderTreeNode,
} from '../utils/folder-utils';
import { StatusIcon } from './StatusIcon';
import { StatusMenu } from './StatusMenu';
import { FolderMenu } from './FolderMenu';
import type { SessionView, StatusConfig } from '../types';

interface FolderTreeViewProps {
  onSessionClick: (sessionId: string) => void;
  onSessionDelete: (sessionId: string) => void;
  onCopyResume: (session: SessionView) => void;
  onNewFolderRequest?: (sessionId: string) => void;
}

export function FolderTreeView({
  onSessionClick,
  onSessionDelete,
  onCopyResume,
  onNewFolderRequest,
}: FolderTreeViewProps) {
  const {
    sessions,
    activeSessionId,
    folderConfigs,
    expandedFolders,
    toggleFolderExpanded,
    sidebarSearchQuery,
    statusFilter,
    statusConfigs,
  } = useAppStore();

  const { tree, uncategorized } = useMemo(() => {
    let sessionList = Object.values(sessions);

    // 搜索过滤
    if (sidebarSearchQuery.trim()) {
      const query = sidebarSearchQuery.toLowerCase();
      sessionList = sessionList.filter(
        (session) =>
          session.title.toLowerCase().includes(query) ||
          session.cwd?.toLowerCase().includes(query)
      );
    }

    // 状态过滤
    if (statusFilter !== 'all') {
      if (statusFilter === 'open') {
        const openIds = new Set(statusConfigs.filter(s => s.category === 'open').map(s => s.id));
        sessionList = sessionList.filter(s => openIds.has(s.todoState || 'todo'));
      } else if (statusFilter === 'closed') {
        const closedIds = new Set(statusConfigs.filter(s => s.category === 'closed').map(s => s.id));
        sessionList = sessionList.filter(s => closedIds.has(s.todoState || 'todo'));
      } else {
        sessionList = sessionList.filter(s => (s.todoState || 'todo') === statusFilter);
      }
    }

    return buildFolderTreeWithSessions(folderConfigs, sessionList);
  }, [sessions, folderConfigs, sidebarSearchQuery, statusFilter, statusConfigs]);

  // 判断文件夹节点是否展开（默认展开）
  const isExpanded = (path: string) => {
    // 如果从未设置过，默认展开
    return expandedFolders.size === 0 || expandedFolders.has(path);
  };

  const renderFolderNode = (node: FolderTreeNode, depth: number = 0) => {
    const expanded = isExpanded(node.path);
    const sessionCount = countSessionsInNode(node);
    const hasContent = node.sessions.length > 0 || node.children.length > 0;

    return (
      <div key={node.path}>
        {/* 文件夹标题 */}
        <div
          className="flex items-center gap-2 px-2 py-2 cursor-pointer hover:bg-[var(--text-primary)]/5 rounded-lg transition-colors duration-150"
          style={{ paddingLeft: `${8 + depth * 16}px` }}
          onClick={() => toggleFolderExpanded(node.path)}
        >
          <span className={`transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}>
            <ChevronIcon />
          </span>
          <FolderIcon open={expanded && hasContent} />
          <span className="text-sm font-medium truncate flex-1">
            {getFolderDisplayName(node)}
          </span>
          {sessionCount > 0 && (
            <span className="text-xs text-[var(--text-muted)]">
              {sessionCount}
            </span>
          )}
        </div>

        {/* 展开的内容 */}
        {expanded && (
          <>
            {/* 子文件夹 */}
            {node.children.map(child => renderFolderNode(child, depth + 1))}

            {/* Sessions */}
            {node.sessions.map(session => (
              <SessionItem
                key={session.id}
                session={session}
                isActive={activeSessionId === session.id}
                statusConfigs={statusConfigs}
                depth={depth + 1}
                onClick={() => onSessionClick(session.id)}
                onDelete={() => onSessionDelete(session.id)}
                onCopyResume={() => onCopyResume(session)}
                onTogglePin={() => sendEvent({ type: 'session.togglePin', payload: { sessionId: session.id } })}
                onNewFolderRequest={onNewFolderRequest}
              />
            ))}
          </>
        )}
      </div>
    );
  };

  const hasAnyContent = tree.length > 0 || uncategorized.length > 0;

  return (
    <div>
      {/* 文件夹树 */}
      {tree.map(node => renderFolderNode(node))}

      {/* Uncategorized */}
      {uncategorized.length > 0 && (
        <div>
          <div className="px-2 pt-4 pb-2 text-xs text-[var(--text-muted)] font-medium">
            Uncategorized
          </div>
          {uncategorized.map(session => (
            <SessionItem
              key={session.id}
              session={session}
              isActive={activeSessionId === session.id}
              statusConfigs={statusConfigs}
              depth={0}
              onClick={() => onSessionClick(session.id)}
              onDelete={() => onSessionDelete(session.id)}
              onCopyResume={() => onCopyResume(session)}
              onTogglePin={() => sendEvent({ type: 'session.togglePin', payload: { sessionId: session.id } })}
              onNewFolderRequest={onNewFolderRequest}
            />
          ))}
        </div>
      )}

      {/* 空状态 */}
      {!hasAnyContent && (
        <div className="text-center text-[var(--text-muted)] py-8 text-sm">
          {sidebarSearchQuery ? 'No matching sessions' : 'No sessions yet'}
        </div>
      )}
    </div>
  );
}

// SessionItem 组件
function SessionItem({
  session,
  isActive,
  statusConfigs,
  depth,
  onClick,
  onDelete,
  onCopyResume,
  onTogglePin,
  onNewFolderRequest,
}: {
  session: SessionView;
  isActive: boolean;
  statusConfigs: StatusConfig[];
  depth: number;
  onClick: () => void;
  onDelete: () => void;
  onCopyResume: () => void;
  onTogglePin: () => void;
  onNewFolderRequest?: (sessionId: string) => void;
}) {
  const formattedTime = new Date(session.updatedAt).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const shortId = session.claudeSessionId
    ? session.claudeSessionId.slice(0, 14)
    : null;

  const currentTodoState = session.todoState || 'todo';
  const currentStatusConfig = statusConfigs.find(s => s.id === currentTodoState);

  return (
    <div
      className={`group relative rounded-xl p-3 mb-1 cursor-pointer transition-colors duration-150 ${
        isActive
          ? 'bg-[var(--text-primary)]/10'
          : 'hover:bg-[var(--text-primary)]/5'
      }`}
      style={{ marginLeft: `${depth * 16}px` }}
      onClick={onClick}
    >
      {/* 标题行 */}
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

      {/* 副标题 */}
      <div className="text-xs text-[var(--text-muted)] mt-1 truncate pl-5">
        {shortId && <span>{shortId} · </span>}
        {formattedTime}
      </div>

      {/* 更多菜单 */}
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
function ChevronIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

function FolderIcon({ open = false }: { open?: boolean }) {
  if (open) {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        <line x1="2" y1="10" x2="22" y2="10" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <circle cx="8" cy="3" r="1.5" />
      <circle cx="8" cy="8" r="1.5" />
      <circle cx="8" cy="13" r="1.5" />
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
