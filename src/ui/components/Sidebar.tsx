import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Bookmark,
  Boxes,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  KanbanSquare,
  MessageSquare,
  Search,
  Settings,
  SquarePen,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import { SidebarSearchPalette } from './search/SidebarSearchPalette';
import type {
  SidebarSearchAction,
  SidebarSearchProject,
  SidebarSearchThread,
} from './search/SidebarSearchPalette.logic';
import { StatusFilter } from './StatusFilter';
import { FolderTreeView } from './FolderTreeView';
import type { SessionView } from '../types';
import { getMessageContentBlocks } from '../utils/message-content';

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;

export function Sidebar() {
  const {
    activeSessionId,
    sidebarCollapsed,
    sidebarWidth,
    projectCwd,
    sessions,
    activeWorkspace,
    setChatLayoutMode,
    setSidebarCollapsed,
    setSidebarWidth,
    setProjectCwd,
    setActiveSession,
    setActiveWorkspace,
    setShowNewSession,
    setShowSettings,
    createDraftSession,
    removeDraftSession,
    searchPaletteOpen,
    setSearchPaletteOpen,
  } = useAppStore();
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [selectedSession, setSelectedSession] = useState<SessionView | null>(null);
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const sidebarResizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(sidebarWidth);
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const newThreadCwd = activeSession?.cwd || projectCwd;

  const finishSidebarResize = () => {
    if (!sidebarResizingRef.current) return;
    sidebarResizingRef.current = false;
    setIsSidebarResizing(false);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };

  const handleSidebarResizeMove = (clientX: number) => {
    if (!sidebarResizingRef.current) return;
    const delta = clientX - startXRef.current;
    const nextWidth = Math.min(
      MAX_SIDEBAR_WIDTH,
      Math.max(MIN_SIDEBAR_WIDTH, startWidthRef.current + delta)
    );
    setSidebarWidth(nextWidth);
  };

  const handleSidebarResizeStart = (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    sidebarResizingRef.current = true;
    setIsSidebarResizing(true);
    startXRef.current = event.clientX;
    startWidthRef.current = sidebarWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  useEffect(() => {
    if (!isSidebarResizing) return;

    const handleWindowBlur = () => finishSidebarResize();
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [isSidebarResizing]);

  useEffect(() => {
    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, []);

  const handleDelete = (sessionId: string) => {
    if (sessions[sessionId]?.isDraft) {
      removeDraftSession(sessionId);
      return;
    }
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

  const handleProjectFolderSelect = async () => {
    const selected = await window.electron.selectDirectory();
    if (!selected) return;
    setProjectCwd(selected);
    setShowSettings(false);
    createDraftSession(selected);
  };

  const toggleSidebarCollapsed = () => {
    finishSidebarResize();
    setSidebarCollapsed(!sidebarCollapsed);
  };

  const paletteActions = useMemo<SidebarSearchAction[]>(
    () => [
      {
        id: 'new-thread',
        label: 'New Thread',
        description: 'Start a new conversation',
        keywords: ['create', 'conversation', 'chat', 'session'],
        shortcutLabel: '⌘N',
      },
      {
        id: 'open-project',
        label: 'Open Project Folder',
        description: 'Pick a working directory for a new thread',
        keywords: ['folder', 'cwd', 'directory'],
      },
      {
        id: 'switch-chat',
        label: 'Go to Threads',
        description: 'Show the threads workspace',
        keywords: ['chat', 'sessions'],
      },
      {
        id: 'switch-board',
        label: 'Go to Board',
        description: 'Open the board workspace',
        keywords: ['kanban', 'tasks'],
      },
      {
        id: 'switch-prompts',
        label: 'Go to Prompt Library',
        description: 'Browse saved prompts',
        keywords: ['prompts', 'snippets'],
      },
      {
        id: 'switch-skills',
        label: 'Go to Skills',
        description: 'Browse skills',
        keywords: ['skills', 'agents'],
      },
      {
        id: 'settings',
        label: 'Settings',
        description: 'Open application settings',
        keywords: ['preferences', 'config'],
      },
    ],
    []
  );

  const visibleSessions = useMemo(
    () =>
      Object.values(sessions).filter(
        (session) => !session.hiddenFromThreads && session.source !== 'claude_code'
      ),
    [sessions]
  );

  const paletteProjects = useMemo<SidebarSearchProject[]>(() => {
    const map = new Map<string, SidebarSearchProject>();
    for (const session of visibleSessions) {
      const cwd = session.cwd?.trim();
      if (!cwd) continue;
      const existing = map.get(cwd);
      if (existing) {
        existing.sessionCount += 1;
        if (session.updatedAt > existing.lastUpdatedAt) {
          existing.lastUpdatedAt = session.updatedAt;
        }
      } else {
        const parts = cwd.split('/').filter(Boolean);
        map.set(cwd, {
          id: cwd,
          name: parts[parts.length - 1] || cwd,
          cwd,
          sessionCount: 1,
          lastUpdatedAt: session.updatedAt,
        });
      }
    }
    return Array.from(map.values());
  }, [visibleSessions]);

  const paletteThreads = useMemo<SidebarSearchThread[]>(() => {
    return visibleSessions.map((session) => {
      const cwd = session.cwd?.trim() || null;
      const projectName = cwd
        ? cwd.split('/').filter(Boolean).pop() || cwd
        : 'No Project';

      // Only hydrated sessions have message content available in memory.
      // For others we still match title / project — consistent with the
      // lightweight, in-memory-only philosophy of the palette.
      const messages: { text: string }[] = [];
      if (session.hydrated) {
        for (const message of session.messages) {
          if (message.type === 'user_prompt') {
            messages.push({ text: message.prompt });
          } else if (message.type === 'assistant' || message.type === 'user') {
            const text = getMessageContentBlocks(message)
              .map((block) => {
                if (block.type === 'text') return block.text;
                if (block.type === 'thinking') return block.thinking;
                return '';
              })
              .filter(Boolean)
              .join(' ');
            if (text) messages.push({ text });
          }
        }
      }

      return {
        id: session.id,
        title: session.title,
        projectName,
        projectCwd: cwd,
        provider: session.provider,
        updatedAt: session.updatedAt,
        messages,
      };
    });
  }, [visibleSessions]);

  const runPaletteAction = (actionId: string) => {
    switch (actionId) {
      case 'new-thread':
        setShowSettings(false);
        createDraftSession(newThreadCwd);
        break;
      case 'open-project':
        void handleProjectFolderSelect();
        break;
      case 'switch-chat':
        setActiveWorkspace('chat');
        setShowSettings(false);
        break;
      case 'switch-board':
        setActiveWorkspace('board');
        setShowSettings(false);
        break;
      case 'switch-prompts':
        setActiveWorkspace('prompts');
        setShowSettings(false);
        break;
      case 'switch-skills':
        setActiveWorkspace('skills');
        setShowSettings(false);
        break;
      case 'settings':
        setShowSettings(true);
        break;
    }
  };

  const openThreadFromPalette = (sessionId: string) => {
    setShowSettings(false);
    setChatLayoutMode('single');
    setActiveSession(sessionId);
    setShowNewSession(false);
    setActiveWorkspace('chat');
  };

  const openProjectFromPalette = (projectId: string) => {
    setActiveWorkspace('chat');
    setProjectCwd(projectId);
    setShowSettings(false);
  };

  return (
    <>
      {isSidebarResizing && (
        <div
          className="fixed inset-0 z-[70] cursor-col-resize no-drag bg-transparent"
          onMouseMove={(event) => handleSidebarResizeMove(event.clientX)}
          onMouseUp={finishSidebarResize}
        />
      )}

      <div className="relative flex h-full min-h-0 flex-shrink-0 self-stretch select-none">
        {/* ===== 图标栏 ===== */}
        <div className="flex h-full w-11 flex-shrink-0 flex-col items-center bg-[var(--bg-tertiary)] pt-0 pb-3">
          {/* macOS 红绿灯区域 */}
          <div className="h-8 w-full drag-region flex-shrink-0 border-b border-[var(--border)]" />

          <div className="flex w-full flex-1 flex-col items-center border-r border-[var(--border)]">
            {/* 导航图标 */}
            <div className="flex flex-col items-center gap-2 pt-3">
              <RailIcon
                icon={<MessageSquare className="h-[17px] w-[17px]" />}
                title="Threads"
                active={activeWorkspace === 'chat'}
                onClick={() => {
                  setActiveWorkspace('chat');
                  setShowSettings(false);
                }}
              />
              <RailIcon
                icon={<Search className="h-[17px] w-[17px]" />}
                title="Search  (⌘K)"
                active={searchPaletteOpen}
                onClick={() => setSearchPaletteOpen(true)}
              />
              <RailIcon
                icon={<KanbanSquare className="h-[17px] w-[17px]" />}
                title="Board"
                active={activeWorkspace === 'board'}
                onClick={() => {
                  setActiveWorkspace('board');
                  setShowSettings(false);
                }}
              />
              <RailIcon
                icon={<Bookmark className="h-[17px] w-[17px]" />}
                title="Prompt Library"
                active={activeWorkspace === 'prompts'}
                onClick={() => {
                  setActiveWorkspace('prompts');
                  setShowSettings(false);
                }}
              />
              <RailIcon
                icon={<Boxes className="h-[17px] w-[17px]" />}
                title="Skills"
                active={activeWorkspace === 'skills'}
                onClick={() => {
                  setActiveWorkspace('skills');
                  setShowSettings(false);
                }}
              />
            </div>

            {/* 底部图标 */}
            <div className="mt-auto flex flex-col items-center gap-1.5 pb-1">
              <RailIcon
                icon={
                  sidebarCollapsed ? (
                    <ChevronRight className="h-[17px] w-[17px]" />
                  ) : (
                    <ChevronLeft className="h-[17px] w-[17px]" />
                  )
                }
                title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                active={sidebarCollapsed}
                onClick={toggleSidebarCollapsed}
              />
              <RailIcon
                icon={<Settings className="h-[17px] w-[17px]" />}
                title="Settings"
                onClick={() => setShowSettings(true)}
              />
            </div>
          </div>
        </div>

        {/* ===== 内容面板 ===== */}
        {activeWorkspace === 'chat' && (
          <div
            className="relative flex h-full min-h-0 flex-shrink-0 self-stretch transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
            style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
          >
            <div
              aria-hidden={sidebarCollapsed}
              className={`relative flex h-full min-h-0 w-full flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--bg-tertiary)] transition-opacity duration-150 ${
                sidebarCollapsed ? 'pointer-events-none opacity-0' : 'opacity-100'
              }`}
            >
              {/* 拖拽区域 */}
              <div className="h-8 drag-region flex-shrink-0 border-b border-[var(--border)]" />

              <div className="mt-4 mb-4 flex items-center gap-2 px-2">
                <button
                  onClick={() => {
                    setShowSettings(false);
                    createDraftSession(newThreadCwd);
                  }}
                  className="group flex flex-1 items-center gap-2 rounded-[var(--radius-xl)] px-2 py-2 text-left no-drag transition-colors duration-150 hover:bg-[var(--sidebar-item-hover)]"
                >
                  <SquarePen className="h-3.5 w-3.5 text-[var(--text-muted)]" strokeWidth={1.9} />
                  <span className="text-[13px] font-medium">New Thread</span>
                </button>

                <button
                  onClick={() => {
                    void handleProjectFolderSelect();
                  }}
                  className="flex h-10 w-10 items-center justify-center rounded-[var(--radius-xl)] no-drag text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
                  aria-label={projectCwd ? `Project folder: ${projectCwd}` : 'Select project folder'}
                >
                  <FolderOpen className="h-4.5 w-4.5" />
                </button>
              </div>

              <div className="px-4 py-2 flex items-center justify-between gap-2">
                <span className="text-[13px] text-[var(--text-muted)]">Sessions</span>
                <StatusFilter />
              </div>

              <div className="flex-1 overflow-y-auto px-2 pt-2">
                <FolderTreeView
                  onSessionClick={(sessionId, options) => {
                    setShowSettings(false);
                    setChatLayoutMode(options?.preserveSplit ? 'split' : 'single');
                    setActiveSession(sessionId);
                    setShowNewSession(false);
                  }}
                  onSessionDelete={handleDelete}
                  onCopyResume={handleResumeCommand}
                  onNewSessionForProject={(nextCwd) => {
                    setProjectCwd(nextCwd);
                    setShowSettings(false);
                    createDraftSession(nextCwd);
                  }}
                />
              </div>

              {!sidebarCollapsed && (
                <div
                  className="group absolute right-0 top-0 bottom-0 w-3 translate-x-1/2 cursor-col-resize no-drag"
                  onMouseDown={handleSidebarResizeStart}
                >
                  <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-transparent group-hover:bg-[var(--border)]" />
                </div>
              )}
            </div>

          </div>
        )}
      </div>

      {/* Resume Command Dialog */}
      <Dialog.Root open={resumeDialogOpen} onOpenChange={setResumeDialogOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50" />
          <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-[var(--radius-2xl)] p-6 w-[480px] shadow-xl">
            <Dialog.Title className="text-lg font-semibold mb-4">
              Resume in Claude Code
            </Dialog.Title>
            <Dialog.Description className="text-[var(--text-secondary)] text-sm mb-4">
              Run this command in your terminal to continue this session in Claude Code:
            </Dialog.Description>

            <div className="bg-[var(--bg-tertiary)] rounded-[var(--radius-xl)] p-3 font-mono text-sm mb-4 break-all">
              claude --teleport {selectedSession?.claudeSessionId}
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={() => setResumeDialogOpen(false)}
                className="px-4 py-2 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-secondary)] text-sm transition-colors hover:bg-[var(--bg-tertiary)]"
              >
                Cancel
              </button>
              <button
                onClick={copyResumeCommand}
                className="px-4 py-2 rounded-[var(--radius-lg)] text-sm bg-[var(--accent)] text-[var(--accent-foreground)] hover:bg-[var(--accent-hover)] transition-colors"
              >
                Copy Command
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <SidebarSearchPalette
        open={searchPaletteOpen}
        onOpenChange={setSearchPaletteOpen}
        actions={paletteActions}
        projects={paletteProjects}
        threads={paletteThreads}
        onRunAction={runPaletteAction}
        onOpenProject={openProjectFromPalette}
        onOpenThread={openThreadFromPalette}
      />
    </>
  );
}

function RailIcon({
  icon,
  title,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <div className="group relative flex items-center">
      <button
        onClick={(e) => {
          onClick();
          (e.currentTarget as HTMLButtonElement).blur();
        }}
        className={`flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] no-drag transition-colors duration-150 ${
          active
            ? 'text-[var(--accent)] bg-[var(--sidebar-item-active)]'
            : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--sidebar-item-hover)]'
        }`}
        aria-label={title}
      >
        {icon}
      </button>
      <div className="pointer-events-none absolute left-full top-1/2 z-40 ml-2 -translate-y-1/2 translate-x-1 whitespace-nowrap rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--text-primary)] opacity-0 shadow-[0_8px_24px_rgba(15,23,42,0.12)] transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-100">
        {title}
      </div>
    </div>
  );
}
