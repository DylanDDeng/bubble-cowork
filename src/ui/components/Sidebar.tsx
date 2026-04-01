import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Bookmark,
  Boxes,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  MessageSquare,
  Search,
  Settings,
  SquarePen,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import { SidebarMessageSearchDialog } from './search/SidebarMessageSearchDialog';
import { StatusFilter } from './StatusFilter';
import { FolderTreeView } from './FolderTreeView';
import { PromptLibraryPanel } from './prompts/PromptLibraryPanel';
import type { SessionView } from '../types';

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;

export function Sidebar() {
  const {
    sidebarCollapsed,
    sidebarWidth,
    projectCwd,
    activeWorkspace,
    chatSidebarView,
    setSidebarCollapsed,
    setSidebarWidth,
    setProjectCwd,
    setActiveSession,
    setActiveWorkspace,
    setChatSidebarView,
    setShowNewSession,
    setShowSettings,
  } = useAppStore();
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [messageSearchOpen, setMessageSearchOpen] = useState(false);
  const [selectedSession, setSelectedSession] = useState<SessionView | null>(null);
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const sidebarResizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(sidebarWidth);

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
    setActiveSession(null);
    setShowNewSession(true);
  };

  const toggleSidebarCollapsed = () => {
    finishSidebarResize();
    setSidebarCollapsed(!sidebarCollapsed);
  };

  const openChatSidebarView = (view: 'threads' | 'prompts') => {
    setActiveWorkspace('chat');
    setChatSidebarView(view);
    setShowSettings(false);
    if (sidebarCollapsed) {
      setSidebarCollapsed(false);
    }
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

      <div className="relative flex h-full flex-shrink-0 select-none">
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
                active={activeWorkspace === 'chat' && chatSidebarView === 'threads'}
                onClick={() => openChatSidebarView('threads')}
              />
              <RailIcon
                icon={<Search className="h-[17px] w-[17px]" />}
                title="Search history"
                active={messageSearchOpen}
                onClick={() => setMessageSearchOpen(true)}
              />
              <RailIcon
                icon={<Bookmark className="h-[17px] w-[17px]" />}
                title="Prompt Library"
                active={activeWorkspace === 'chat' && chatSidebarView === 'prompts'}
                onClick={() => openChatSidebarView('prompts')}
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
            className="relative flex h-full flex-shrink-0 transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
            style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
          >
            <div
              aria-hidden={sidebarCollapsed}
              className={`relative flex h-full w-full flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--bg-tertiary)] transition-opacity duration-150 ${
                sidebarCollapsed ? 'pointer-events-none opacity-0' : 'opacity-100'
              }`}
            >
              {/* 拖拽区域 */}
              <div className="h-8 drag-region flex-shrink-0 border-b border-[var(--border)]" />

              {chatSidebarView === 'threads' ? (
                <>
                  <div className="mt-4 mb-4 flex items-center gap-2 px-2">
                    <button
                      onClick={() => {
                        setShowSettings(false);
                        setActiveSession(null);
                        setShowNewSession(true);
                      }}
                      className="group flex flex-1 items-center gap-3 rounded-xl px-2 py-2 text-left no-drag transition-colors duration-150 hover:bg-[var(--sidebar-item-hover)]"
                    >
                      <SquarePen className="h-4 w-4 text-[var(--text-muted)]" strokeWidth={1.9} />
                      <span className="text-base font-medium">New Thread</span>
                    </button>

                    <button
                      onClick={() => {
                        void handleProjectFolderSelect();
                      }}
                      className="flex h-10 w-10 items-center justify-center rounded-xl no-drag text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
                      title={projectCwd ? `Project folder: ${projectCwd}` : 'Select project folder'}
                      aria-label="Select project folder"
                    >
                      <FolderOpen className="h-4.5 w-4.5" />
                    </button>
                  </div>

                  <div className="px-4 py-2 flex items-center justify-between gap-2">
                    <span className="text-sm text-[var(--text-muted)]">Sessions</span>
                    <StatusFilter />
                  </div>

                  <div className="flex-1 overflow-y-auto px-2 pt-2">
                    <FolderTreeView
                      onSessionClick={(sessionId) => {
                        setShowSettings(false);
                        setActiveSession(sessionId);
                        setShowNewSession(false);
                      }}
                      onSessionDelete={handleDelete}
                      onCopyResume={handleResumeCommand}
                      onNewSessionForProject={(nextCwd) => {
                        setProjectCwd(nextCwd);
                        setShowSettings(false);
                        setActiveSession(null);
                        setShowNewSession(true);
                      }}
                    />
                  </div>
                </>
              ) : (
                <PromptLibraryPanel />
              )}

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
                className="px-4 py-2 rounded-lg text-sm bg-[var(--accent)] text-[var(--accent-foreground)] hover:bg-[var(--accent-hover)] transition-colors"
              >
                Copy Command
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <SidebarMessageSearchDialog
        open={messageSearchOpen}
        onOpenChange={setMessageSearchOpen}
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
        onClick={onClick}
        className={`flex h-8 w-8 items-center justify-center rounded-lg no-drag transition-colors duration-150 ${
          active
            ? 'text-[var(--text-primary)] bg-[var(--sidebar-item-hover)]'
            : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--sidebar-item-hover)]'
        }`}
        title={title}
        aria-label={title}
      >
        {icon}
      </button>
      <div className="pointer-events-none absolute left-full top-1/2 z-40 ml-2 -translate-y-1/2 translate-x-1 whitespace-nowrap rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-2.5 py-1.5 text-[12px] font-medium text-[var(--text-primary)] opacity-0 shadow-[0_8px_24px_rgba(15,23,42,0.12)] transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:translate-x-0 group-focus-within:opacity-100">
        {title}
      </div>
    </div>
  );
}
