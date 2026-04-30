import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  Bookmark,
  Boxes,
  FolderOpen,
  MessageCircle,
  Search,
  Settings,
  SquarePen,
} from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { SidebarSearchPalette } from './search/SidebarSearchPalette';
import { PromptLibraryPanel } from './prompts/PromptLibraryPanel';
import { SidebarSkillLibraryPanel } from './sidebar/SidebarSkillLibraryPanel';
import { AgentAvatar } from './AgentAvatar';
import type {
  SidebarSearchAction,
  SidebarSearchProject,
  SidebarSearchThread,
} from './search/SidebarSearchPalette.logic';
import { FolderTreeView } from './FolderTreeView';
import { DEFAULT_WORKSPACE_CHANNEL_ID } from '../../shared/types';
import type {
  AgentProfile,
  ChatSidebarView,
} from '../types';
import { getMessageContentBlocks } from '../utils/message-content';

const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 420;
const SIDEBAR_TRIGGER_CLASS =
  'no-drag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] transition-[background-color,color,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] active:scale-95';

type ThreadSidebarScope = 'projects' | 'dms';

function SidebarToggleIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

function SidebarToggleButton({
  collapsed,
  className = '',
  onClick,
}: {
  collapsed: boolean;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${SIDEBAR_TRIGGER_CLASS} ${className}`}
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
    >
      <SidebarToggleIcon className="h-4 w-4" />
      <span className="sr-only">Toggle sidebar</span>
    </button>
  );
}

export function SidebarHeaderTrigger({ className = '' }: { className?: string }) {
  const { sidebarCollapsed, setSidebarCollapsed } = useAppStore();

  return (
    <SidebarToggleButton
      collapsed={sidebarCollapsed}
      className={className}
      onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
    />
  );
}

export function Sidebar() {
  const {
    activeSessionId,
    sidebarCollapsed,
    sidebarWidth,
    chatSidebarView,
    projectCwd,
    activeChannelByProject,
    agentProfiles,
    sessions,
    activeWorkspace,
    setChatLayoutMode,
    setSidebarCollapsed,
    setSidebarWidth,
    setChatSidebarView,
    setProjectCwd,
    setActiveChannelForProject,
    setActiveSession,
    setActiveWorkspace,
    setShowNewSession,
    setShowSettings,
    createDraftSession,
    openAgentDirectMessage,
    searchPaletteOpen,
    setSearchPaletteOpen,
  } = useAppStore();
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const [threadSidebarScope, setThreadSidebarScope] = useState<ThreadSidebarScope>('projects');
  const sidebarResizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(sidebarWidth);
  const activeSession = activeSessionId ? sessions[activeSessionId] : null;
  const activeDirectAgentId = activeSession?.scope === 'dm' ? activeSession.agentId || '' : '';
  const newThreadCwd = activeSession?.cwd || projectCwd;
  const agentProfileList = useMemo(
    () => Object.values(agentProfiles).sort((left, right) => left.createdAt - right.createdAt),
    [agentProfiles]
  );
  const directMessageAgents = useMemo(
    () => agentProfileList.filter((profile) => profile.enabled),
    [agentProfileList]
  );

  const getActiveChannelIdForProject = (cwd?: string | null) => {
    const key = cwd?.trim() || '__no_project__';
    return activeChannelByProject[key] || DEFAULT_WORKSPACE_CHANNEL_ID;
  };

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

  const handleProjectFolderSelect = async () => {
    const selected = await window.electron.selectDirectory();
    if (!selected) return;
    setProjectCwd(selected);
    setActiveChannelForProject(selected, DEFAULT_WORKSPACE_CHANNEL_ID);
    setShowSettings(false);
    createDraftSession(selected, DEFAULT_WORKSPACE_CHANNEL_ID);
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
        (session) =>
          !session.hiddenFromThreads &&
          session.scope !== 'dm' &&
          session.source !== 'claude_code'
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
        setThreadSidebarScope('projects');
        setShowSettings(false);
        createDraftSession(newThreadCwd, getActiveChannelIdForProject(newThreadCwd));
        break;
      case 'open-project':
        setThreadSidebarScope('projects');
        void handleProjectFolderSelect();
        break;
      case 'switch-chat':
        setThreadSidebarScope('projects');
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
    setThreadSidebarScope('projects');
    setShowSettings(false);
    setChatLayoutMode('single');
    setActiveSession(sessionId);
    setShowNewSession(false);
    setActiveWorkspace('chat');
    setChatSidebarView('threads');
  };

  const openProjectFromPalette = (projectId: string) => {
    setThreadSidebarScope('projects');
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
        <div
          className="relative flex h-full min-h-0 flex-shrink-0 self-stretch overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
          style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
        >
          <div
            className={`relative flex h-full min-h-0 flex-col overflow-hidden border-r border-[var(--border)] bg-[var(--bg-tertiary)] transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                sidebarCollapsed
                  ? 'pointer-events-none -translate-x-2 opacity-0'
                  : 'translate-x-0 opacity-100'
              }`}
            style={{ width: sidebarWidth, minWidth: sidebarWidth }}
            aria-hidden={sidebarCollapsed}
          >
            <div className="drag-region flex h-12 flex-shrink-0 items-center gap-0.5 pl-[84px] pr-2">
              <SidebarToggleButton
                collapsed={sidebarCollapsed}
                onClick={toggleSidebarCollapsed}
              />
            </div>

            <div className="flex min-h-0 flex-1 flex-col">
              <div className="px-2 py-3">
                <div className="space-y-1">
                  <SidebarNavRow
                    icon={<SquarePen className="h-[15px] w-[15px]" />}
                    label="New Thread"
                    onClick={() => {
                      setShowSettings(false);
                      setActiveWorkspace('chat');
                      setChatSidebarView('threads');
                      setThreadSidebarScope('projects');
                      createDraftSession(newThreadCwd, getActiveChannelIdForProject(newThreadCwd));
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
                  <ThreadScopeTabs
                    activeScope={threadSidebarScope}
                    onScopeChange={setThreadSidebarScope}
                  />
                  {threadSidebarScope === 'projects' ? (
                    <div className="flex-1 overflow-y-auto overflow-x-hidden px-2 pt-3">
                      <FolderTreeView
                        onSessionClick={(sessionId, options) => {
                          setShowSettings(false);
                          setChatLayoutMode(options?.preserveSplit ? 'split' : 'single');
                          setActiveSession(sessionId);
                          setShowNewSession(false);
                          setActiveWorkspace('chat');
                          setChatSidebarView('threads');
                        }}
                        onSelectProjectFolder={handleProjectFolderSelect}
                        projectCwd={projectCwd}
                        onNewSessionForProject={(nextCwd, channelId) => {
                          const nextChannelId = channelId || getActiveChannelIdForProject(nextCwd);
                          setProjectCwd(nextCwd);
                          setActiveChannelForProject(nextCwd, nextChannelId);
                          setShowSettings(false);
                          setChatSidebarView('threads');
                          createDraftSession(nextCwd, nextChannelId);
                        }}
                      />
                    </div>
                  ) : (
                    <DirectMessagesPanel
                      agents={directMessageAgents}
                      selectedAgentId={activeDirectAgentId}
                      onSelectAgent={(agentId) => {
                        setShowSettings(false);
                        setChatLayoutMode('single');
                        openAgentDirectMessage(agentId);
                      }}
                    />
                  )}
                </div>
              )}

              <div className="px-2 py-2">
                <button
                  type="button"
                  onClick={() => setShowSettings(true)}
                  className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]"
                  aria-label="Settings"
                >
                  <Settings className="h-[15px] w-[15px] text-[var(--text-muted)]" />
                  <span className="truncate text-[13px] font-medium">Settings</span>
                </button>
              </div>
            </div>
          </div>

          {!sidebarCollapsed ? (
            <div
              className="group absolute right-0 top-0 bottom-0 w-3 translate-x-1/2 cursor-col-resize no-drag"
              onMouseDown={handleSidebarResizeStart}
            >
              <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-transparent group-hover:bg-[var(--border)]" />
            </div>
          ) : null}
        </div>
      </div>

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

function ThreadScopeTabs({
  activeScope,
  onScopeChange,
}: {
  activeScope: ThreadSidebarScope;
  onScopeChange: (scope: ThreadSidebarScope) => void;
}) {
  return (
    <div className="px-3 pb-2">
      <div className="relative grid h-6 w-full grid-cols-2 overflow-hidden rounded-full bg-[var(--sidebar-segment-bg)]">
        <span
          aria-hidden="true"
          className={`absolute inset-y-0 left-0 w-1/2 rounded-full bg-[var(--sidebar-segment-active)] shadow-[var(--sidebar-segment-shadow-active)] transition-transform duration-180 ease-[cubic-bezier(0.22,1,0.36,1)] ${
            activeScope === 'dms' ? 'translate-x-full' : 'translate-x-0'
          }`}
        />
        <ThreadScopeTab
          icon={<FolderOpen className="h-3.5 w-3.5" />}
          label="Projects"
          active={activeScope === 'projects'}
          onClick={() => onScopeChange('projects')}
        />
        <ThreadScopeTab
          icon={<MessageCircle className="h-3.5 w-3.5" />}
          label="DMs"
          active={activeScope === 'dms'}
          onClick={() => onScopeChange('dms')}
        />
      </div>
    </div>
  );
}

function ThreadScopeTab({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative z-10 flex min-w-0 items-center justify-center gap-1 px-2 text-[11px] font-medium outline-none transition-colors duration-150 ease-[cubic-bezier(0.2,0.8,0.2,1)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]/35 ${
        active
          ? 'text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
      }`}
      aria-pressed={active}
    >
      <span className="flex h-3 w-3 items-center justify-center opacity-85 [&>svg]:h-3 [&>svg]:w-3">{icon}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

function DirectMessagesPanel({
  agents,
  selectedAgentId,
  onSelectAgent,
}: {
  agents: AgentProfile[];
  selectedAgentId: string;
  onSelectAgent: (agentId: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-2 pt-3">
        <div className="mb-2 px-1 text-[13px] text-[var(--text-primary)]">
          Direct Messages
        </div>
        <div className="space-y-1">
          {agents.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--border)] px-3 py-4 text-[13px] text-[var(--text-muted)]">
              No active agents
            </div>
          ) : (
            agents.map((agent) => (
              <DirectAgentRow
                key={agent.id}
                agent={agent}
                active={selectedAgentId === agent.id}
                onClick={() => onSelectAgent(agent.id)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function DirectAgentRow({
  agent,
  active,
  onClick,
}: {
  agent: AgentProfile;
  active: boolean;
  onClick: () => void;
}) {
  const displayName = agent.name.trim() || 'Untitled agent';
  const displayRole = agent.role.trim() || 'Agent';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex h-10 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left no-drag transition-colors duration-150 ${
        active
          ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
          : agent.enabled
            ? 'text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
            : 'text-[var(--text-muted)] opacity-70 hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)]'
      }`}
      aria-pressed={active}
      aria-label={`Open direct message with ${displayName}`}
      title={`${displayName} · ${displayRole}`}
    >
      <AgentAvatar profile={agent} size="sm" decorative />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium leading-[1.2]">{displayName}</span>
        <span className="block truncate text-[11px] leading-[1.2] text-[var(--text-muted)]">
          {displayRole}
        </span>
      </span>
      <span
        className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
          agent.enabled ? 'bg-emerald-500' : 'bg-[var(--text-muted)]'
        }`}
        title={agent.enabled ? 'Enabled' : 'Disabled'}
        aria-label={agent.enabled ? 'Enabled' : 'Disabled'}
      />
    </button>
  );
}
