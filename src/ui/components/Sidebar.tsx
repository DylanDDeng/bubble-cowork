import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Bookmark,
  Boxes,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Search,
  Settings,
  SquarePen,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import { SidebarSearchPalette } from './search/SidebarSearchPalette';
import { PromptLibraryPanel } from './prompts/PromptLibraryPanel';
import { SidebarSkillLibraryPanel } from './sidebar/SidebarSkillLibraryPanel';
import type {
  SidebarSearchAction,
  SidebarSearchProject,
  SidebarSearchThread,
} from './search/SidebarSearchPalette.logic';
import { FolderTreeView } from './FolderTreeView';
import type { ChatSidebarView, SessionView } from '../types';
import { getMessageContentBlocks } from '../utils/message-content';

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;

export function Sidebar() {
  const {
    activeSessionId,
    sidebarCollapsed,
    sidebarWidth,
    chatSidebarView,
    projectCwd,
    sessions,
    activeWorkspace,
    setChatLayoutMode,
    setSidebarCollapsed,
    setSidebarWidth,
    setChatSidebarView,
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
        setChatSidebarView('threads');
        setShowSettings(false);
        break;
      case 'switch-prompts':
        setActiveWorkspace('chat');
        setChatSidebarView('prompts');
        setShowSettings(false);
        break;
      case 'switch-skills':
        setActiveWorkspace('chat');
        setChatSidebarView('skills');
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
    setChatSidebarView('threads');
  };

  const openProjectFromPalette = (projectId: string) => {
    setActiveWorkspace('chat');
    setChatSidebarView('threads');
    setProjectCwd(projectId);
    setShowSettings(false);
  };

  const activateSidebarView = (view: ChatSidebarView) => {
    setActiveWorkspace('chat');
    setChatSidebarView(view);
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

      <div className="aegis-sidebar relative flex h-full min-h-0 flex-shrink-0 self-stretch select-none">
        {sidebarCollapsed ? (
          <div className="flex h-full w-9 flex-shrink-0 flex-col items-center border-r border-[var(--border)] bg-[var(--bg-tertiary)]">
            <div className="h-8 w-full drag-region flex-shrink-0 border-b border-[var(--border)]" />
            <button
              type="button"
              onClick={toggleSidebarCollapsed}
              title="Expand sidebar"
              aria-label="Expand sidebar"
              className="mt-2 flex h-8 w-8 items-center justify-center rounded-[var(--radius-lg)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
            >
              <ChevronRight className="h-[17px] w-[17px]" />
            </button>
          </div>
        ) : (
          <div
            className="relative flex h-full min-h-0 flex-shrink-0 self-stretch transition-[width] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
            style={{ width: sidebarWidth }}
          >
            <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--bg-tertiary)]">
              <div className="h-8 drag-region flex-shrink-0 border-b border-[var(--border)]" />

              <div className="px-2 py-3">
                <div className="space-y-1">
                  <SidebarNavRow
                    icon={<SquarePen className="h-[15px] w-[15px]" />}
                    label="New Thread"
                    onClick={() => {
                      setShowSettings(false);
                      setActiveWorkspace('chat');
                      setChatSidebarView('threads');
                      createDraftSession(newThreadCwd);
                    }}
                  />
                  <SidebarNavRow
                    icon={<Search className="h-[15px] w-[15px]" />}
                    label="Search"
                    active={searchPaletteOpen}
                    onClick={() => setSearchPaletteOpen(true)}
                  />
                  <SidebarNavRow
                    icon={<Bookmark className="h-[15px] w-[15px]" />}
                    label="Prompt Library"
                    active={
                      (activeWorkspace === 'chat' && chatSidebarView === 'prompts') ||
                      activeWorkspace === 'prompts'
                    }
                    onClick={() => activateSidebarView('prompts')}
                  />
                  <SidebarNavRow
                    icon={<Boxes className="h-[15px] w-[15px]" />}
                    label="Skill Library"
                    active={
                      (activeWorkspace === 'chat' && chatSidebarView === 'skills') ||
                      activeWorkspace === 'skills'
                    }
                    onClick={() => activateSidebarView('skills')}
                  />
                </div>
              </div>

              {chatSidebarView === 'prompts' ? (
                <PromptLibraryPanel onShowProjects={() => activateSidebarView('threads')} />
              ) : chatSidebarView === 'skills' ? (
                <SidebarSkillLibraryPanel onShowProjects={() => activateSidebarView('threads')} />
              ) : (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="px-2 pb-2 pt-4">
                    <div className="flex items-center justify-between gap-2 px-1">
                      <button
                        type="button"
                        onClick={() => activateSidebarView('threads')}
                        className={`rounded-md px-1 text-[13px] transition-colors ${
                          activeWorkspace === 'chat' && chatSidebarView === 'threads'
                            ? 'text-[var(--text-primary)]'
                            : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                        }`}
                      >
                        Projects
                      </button>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            void handleProjectFolderSelect();
                          }}
                          className="flex h-7 w-7 items-center justify-center rounded-lg no-drag text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
                          aria-label={projectCwd ? `Project folder: ${projectCwd}` : 'Select project folder'}
                          title={projectCwd ? `Project folder: ${projectCwd}` : 'Select project folder'}
                        >
                          <FolderOpen className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto px-2 pt-2">
                    <FolderTreeView
                      onSessionClick={(sessionId, options) => {
                        setShowSettings(false);
                        setChatLayoutMode(options?.preserveSplit ? 'split' : 'single');
                        setActiveSession(sessionId);
                        setShowNewSession(false);
                        setActiveWorkspace('chat');
                        setChatSidebarView('threads');
                      }}
                      onSessionDelete={handleDelete}
                      onCopyResume={handleResumeCommand}
                      onNewSessionForProject={(nextCwd) => {
                        setProjectCwd(nextCwd);
                        setShowSettings(false);
                        setChatSidebarView('threads');
                        createDraftSession(nextCwd);
                      }}
                    />
                  </div>
                </div>
              )}

              <div className="border-t border-[var(--border)] px-2 py-2">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setShowSettings(true)}
                    className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
                    aria-label="Settings"
                  >
                    <Settings className="h-[15px] w-[15px] text-[var(--text-muted)]" />
                    <span className="truncate text-[13px] font-medium">Settings</span>
                  </button>
                  <button
                    type="button"
                    onClick={toggleSidebarCollapsed}
                    className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
                    aria-label="Collapse sidebar"
                    title="Collapse sidebar"
                  >
                    <ChevronLeft className="h-[15px] w-[15px]" />
                  </button>
                </div>
              </div>

              <div
                className="group absolute right-0 top-0 bottom-0 w-3 translate-x-1/2 cursor-col-resize no-drag"
                onMouseDown={handleSidebarResizeStart}
              >
                <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-transparent group-hover:bg-[var(--border)]" />
              </div>
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

function SidebarNavRow({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        onClick();
        (e.currentTarget as HTMLButtonElement).blur();
      }}
      className={`flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left no-drag transition-colors duration-150 ${
        active
          ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
      }`}
      aria-label={label}
    >
      <span className="flex h-4 w-4 items-center justify-center text-[var(--text-muted)]">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{label}</span>
    </button>
  );
}
