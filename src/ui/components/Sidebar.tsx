import { useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Dialog from '@radix-ui/react-dialog';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import type { SessionView } from '../types';

export function Sidebar() {
  const { sessions, activeSessionId, setActiveSession, setShowNewSession } = useAppStore();
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [selectedSession, setSelectedSession] = useState<SessionView | null>(null);

  const sessionList = Object.values(sessions).sort(
    (a, b) => (sessions[b.id]?.claudeSessionId ? 1 : 0) - (sessions[a.id]?.claudeSessionId ? 1 : 0)
  );

  const handleDelete = (sessionId: string) => {
    sendEvent({ type: 'session.delete', payload: { sessionId } });
  };

  const handleResumeCommand = (session: SessionView) => {
    setSelectedSession(session);
    setResumeDialogOpen(true);
  };

  const copyResumeCommand = () => {
    if (selectedSession?.claudeSessionId) {
      navigator.clipboard.writeText(`claude --resume ${selectedSession.claudeSessionId}`);
    }
    setResumeDialogOpen(false);
  };

  return (
    <div className="w-64 bg-[var(--bg-secondary)] border-r border-[var(--border)] flex flex-col h-full">
      {/* Header */}
      <div className="px-4 pt-8 pb-4 border-b border-[var(--border)] flex items-center justify-between drag-region">
        <h1 className="font-semibold text-lg">Sessions</h1>
        <button
          onClick={() => {
            setActiveSession(null);
            setShowNewSession(true);
          }}
          className="w-8 h-8 rounded-lg bg-[var(--accent)] hover:bg-[var(--accent-hover)] flex items-center justify-center transition-colors no-drag"
        >
          <span className="text-xl leading-none">+</span>
        </button>
      </div>

      {/* Session List */}
      <div className="flex-1 overflow-y-auto p-2">
        {sessionList.map((session) => (
          <div
            key={session.id}
            className={`group relative rounded-lg p-3 mb-1 cursor-pointer transition-colors ${
              activeSessionId === session.id
                ? 'bg-[var(--bg-tertiary)]'
                : 'hover:bg-[var(--bg-tertiary)]'
            }`}
            onClick={() => {
              setActiveSession(session.id);
              setShowNewSession(false);
            }}
          >
            <div className="flex items-center gap-2">
              <div className={`status-dot ${session.status}`} />
              <span className="flex-1 truncate text-sm">{session.title}</span>

              {/* Dropdown Menu */}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[var(--border)] transition-opacity"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreIcon />
                  </button>
                </DropdownMenu.Trigger>

                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    className="bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg p-1 min-w-[160px] shadow-lg"
                    sideOffset={5}
                  >
                    {session.claudeSessionId && (
                      <DropdownMenu.Item
                        className="flex items-center gap-2 px-3 py-2 text-sm rounded cursor-pointer hover:bg-[var(--border)] outline-none"
                        onClick={() => handleResumeCommand(session)}
                      >
                        <CopyIcon />
                        Copy Resume Command
                      </DropdownMenu.Item>
                    )}
                    <DropdownMenu.Item
                      className="flex items-center gap-2 px-3 py-2 text-sm rounded cursor-pointer hover:bg-[var(--border)] outline-none text-red-400"
                      onClick={() => handleDelete(session.id)}
                    >
                      <TrashIcon />
                      Delete
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>

            {session.cwd && (
              <div className="text-xs text-[var(--text-muted)] mt-1 truncate">
                {session.cwd}
              </div>
            )}
          </div>
        ))}

        {sessionList.length === 0 && (
          <div className="text-center text-[var(--text-muted)] py-8 text-sm">
            No sessions yet
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
              claude --resume {selectedSession?.claudeSessionId}
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
