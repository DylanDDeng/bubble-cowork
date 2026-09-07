import { useState } from 'react';
import { create } from 'zustand';
import { toast } from 'sonner';
import { confirmDialog } from '../components/ui/confirm-dialog';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from './useIPC';
import type { SessionView } from '../types';
import type { SessionMenuAction, SessionMenuItem } from '../../shared/session-menu';

type WorktreeAction = 'move' | 'apply' | 'discard';
// Both entry points observe the same pending state, including split panes.
const useMenuPending = create<{ actions: Record<string, WorktreeAction | undefined> }>(() => ({ actions: {} }));

export function useSessionActionsMenu(session: SessionView) {
  const [menuOpen, setMenuOpen] = useState(false);
  const worktreeAction = useMenuPending(s => s.actions[session.id] ?? null);
  const setWorktreeAction = (action: WorktreeAction | null) => useMenuPending.setState(s => {
    const actions = { ...s.actions };
    if (action) actions[session.id] = action;
    else delete actions[session.id];
    return { actions };
  });
  const forkSessionToPane = useAppStore(s => s.forkSessionToPane);
  const createDraftSession = useAppStore(s => s.createDraftSession);
  const inWorktree = session.envMode === 'worktree' && Boolean(session.worktreePath);
  const providerSupportsFork = ['claude', 'codex', 'opencode', 'kimi'].includes(session.provider ?? 'claude');
  const canFork = !session.isDraft && !(session.provider === 'kimi' && session.status === 'running');
  const canChangeWorktree = !session.isDraft && session.status !== 'running' && !worktreeAction;
  const handleFork = () => {
    void forkSessionToPane(session.id);
  };

  const handleNewInWorktree = () => {
    if (!session.worktreePath) return;
    createDraftSession(session.worktreePath, session.channelId || null, {
      title: `New Chat - ${session.associatedWorktreeBranch || 'Worktree'}`,
      projectCwd: session.projectCwd ?? null,
      envMode: 'worktree',
      worktreePath: session.worktreePath,
      associatedWorktreePath: session.worktreePath,
      associatedWorktreeBranch: session.associatedWorktreeBranch ?? null,
      associatedWorktreeRef: session.associatedWorktreeRef ?? null,
    });
  };

  const handleMoveToWorktree = () => {
    void (async () => {
      setWorktreeAction('move');
      const toastId = toast.loading('Moving thread into a new worktree…');
      try {
        const result = await window.electron.moveSessionToWorktree(session.id);
        if (result.ok) {
          toast.success('Thread moved into a new worktree — changes stay on its own branch.', {
            id: toastId,
          });
        } else {
          toast.error(result.message || 'Could not move the thread into a worktree.', {
            id: toastId,
          });
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error), { id: toastId });
      } finally {
        setWorktreeAction(null);
      }
    })();
  };

  const handleApplyWorktree = () => {
    void (async () => {
      setWorktreeAction('apply');
      const toastId = toast.loading('Squash-merging worktree changes into the project…');
      try {
        const applied = await window.electron.applyWorktreeChanges(session.id);
        if (applied.ok) {
          toast.success('Squash-merged — changes are staged in your project for review.', {
            id: toastId,
          });
        } else {
          toast.error(applied.message || 'Squash-merge failed.', { id: toastId });
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error), { id: toastId });
      } finally {
        setWorktreeAction(null);
      }
    })();
  };

  const handleDiscardWorktree = () => {
    // confirm 推迟到菜单关闭之后，避免弹窗和菜单抢焦点
    window.setTimeout(() => {
      const branchName = session.associatedWorktreeBranch;
      void (async () => {
        const confirmed = await confirmDialog({
          title: branchName ? `Remove this worktree and branch ${branchName}?` : 'Remove this worktree?',
          description: 'All uncommitted changes in it are lost. The conversation stays.',
          confirmLabel: 'Remove worktree',
        });
        if (!confirmed) {
          return;
        }
        setWorktreeAction('discard');
        try {
          const discarded = await window.electron.discardWorktreeChanges(session.id);
          if (discarded.ok) {
            toast.success('Worktree removed — thread is back on the project.');
          } else {
            toast.error(discarded.message || 'Could not remove the worktree.');
          }
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        } finally {
          setWorktreeAction(null);
        }
      })();
    }, 0);
  };

  const handleDelete = () => {
    window.setTimeout(() => {
      void (async () => {
        const detail = session.status === 'running' ? ' The running task will be stopped.' : '';
        const confirmed = await confirmDialog({
          title: `Delete ${session.title}?`,
          description: `This permanently removes the conversation.${detail}`,
          confirmLabel: 'Delete conversation',
        });
        if (confirmed) {
          sendEvent({ type: 'session.delete', payload: { sessionId: session.id } });
        }
      })();
    }, 0);
  };

  const items: SessionMenuItem[] = [
    { id: 'pin', label: session.pinned ? 'Unpin' : 'Pin', icon: 'pin' },
    { type: 'separator' },
    { label: 'Copy', icon: 'copy', submenu: [
      { id: 'copy-link', label: 'Conversation link', icon: 'link', enabled: !session.isDraft },
      { id: 'copy-cwd', label: 'Working directory', icon: 'folder', enabled: Boolean(session.cwd) },
    ] },
    ...(providerSupportsFork ? [{ id: 'fork' as const, label: 'Fork into a new pane', icon: 'fork' as const, enabled: canFork && !worktreeAction }] : []),
    { label: 'Worktree', icon: 'worktree', submenu: inWorktree ? [
      { id: 'new-worktree-thread', label: 'New thread in this worktree', icon: 'worktree', enabled: !worktreeAction },
      { id: 'apply-worktree', label: 'Squash-merge back into project', icon: 'apply', enabled: canChangeWorktree },
      { id: 'discard-worktree', label: 'Discard worktree…', icon: 'trash', enabled: canChangeWorktree },
    ] : [
      { id: 'move-worktree', label: worktreeAction === 'move' ? 'Moving into a new worktree…' : 'Move into a new worktree', icon: 'worktree', enabled: canChangeWorktree },
    ] },
    { type: 'separator' },
    { id: 'delete', label: 'Delete…', icon: 'trash', enabled: !worktreeAction },
  ];

  const execute = async (action: SessionMenuAction) => {
    if (action === 'copy-link' || action === 'copy-cwd') {
      const target = action === 'copy-link' ? 'link' : 'cwd';
      if (session.isDraft && target === 'cwd' && session.cwd) await navigator.clipboard.writeText(session.cwd);
      else await window.electron.copySessionValue(session.id, target);
      toast.success(target === 'link' ? 'Conversation link copied' : 'Working directory copied');
      return;
    }
    switch (action) {
      case 'pin': sendEvent({ type: 'session.togglePin', payload: { sessionId: session.id } }); break;
      case 'fork': handleFork(); break;
      case 'new-worktree-thread': handleNewInWorktree(); break;
      case 'move-worktree': handleMoveToWorktree(); break;
      case 'apply-worktree': handleApplyWorktree(); break;
      case 'discard-worktree': handleDiscardWorktree(); break;
      case 'delete': handleDelete(); break;
    }
  };

  const openMenu = async (position?: { x: number; y: number }) => {
    if (menuOpen) return;
    setMenuOpen(true);
    try {
      const action = await window.electron.showSessionMenu({ items, position });
      if (action) await execute(action);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not open conversation menu');
    } finally {
      setMenuOpen(false);
    }
  };
  return { openMenu, menuOpen, worktreeAction };
}
