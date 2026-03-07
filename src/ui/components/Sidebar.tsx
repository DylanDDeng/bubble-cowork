import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Settings } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import { SidebarSearch } from './search/SidebarSearch';
import { StatusFilter } from './StatusFilter';
import { FolderTreeView } from './FolderTreeView';
import type { SessionView } from '../types';

export function Sidebar() {
  const { setActiveSession, setShowNewSession, setShowSettings } = useAppStore();
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [selectedSession, setSelectedSession] = useState<SessionView | null>(null);

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
    <div className="w-64 bg-[var(--bg-tertiary)] border-r border-[var(--border)] flex flex-col h-full">
      {/* 拖拽区域 */}
      <div className="h-8 drag-region" />

      {/* New Session 按钮 */}
      <button
        onClick={() => {
          setShowSettings(false);
          setActiveSession(null);
          setShowNewSession(true);
        }}
        className="group mx-2 mt-4 mb-4 px-2 py-2 flex items-center gap-3 text-left no-drag rounded-xl transition-colors duration-150"
        onMouseEnter={(event) => {
          event.currentTarget.style.backgroundColor = '#EEEEEE';
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.backgroundColor = '';
        }}
      >
        <span className="text-[#92918E] text-[22px] font-normal leading-none">+</span>
        <span className="text-base font-medium">New Task</span>
      </button>

      {/* Sessions 标题栏 */}
      <div className="px-4 py-2 flex items-center justify-between gap-2">
        <span className="text-sm text-[var(--text-muted)]">Sessions</span>
        <StatusFilter />
      </div>

      {/* 搜索框 */}
      <div className="px-4 pb-3">
        <SidebarSearch />
      </div>

      {/* Session List */}
      <div className="flex-1 overflow-y-auto px-2">
        <FolderTreeView
          onSessionClick={(sessionId) => {
            setShowSettings(false);
            setActiveSession(sessionId);
            setShowNewSession(false);
          }}
          onSessionDelete={handleDelete}
          onCopyResume={handleResumeCommand}
        />
      </div>

      {/* Settings Button */}
      <div className="p-4 border-t border-[var(--border)]/80">
        <button
          onClick={() => setShowSettings(true)}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors duration-150"
          onMouseEnter={(event) => {
            event.currentTarget.style.backgroundColor = '#EEEEEE';
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.backgroundColor = '';
          }}
        >
          <Settings className="w-4 h-4" />
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
                className="px-4 py-2 rounded-lg text-sm bg-[var(--accent)] text-[var(--accent-foreground)] hover:bg-[var(--accent-hover)] transition-colors"
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
