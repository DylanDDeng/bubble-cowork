import { MoreHorizontal } from './icons';
import { useSessionActionsMenu } from '../hooks/useSessionActionsMenu';
import type { SessionView } from '../types';

export function SessionActionsMenu({ session }: { session: SessionView }) {
  const { openMenu, menuOpen } = useSessionActionsMenu(session);
  return (
    <button type="button" aria-label="Conversation actions" title="Conversation actions"
      aria-haspopup="menu" aria-expanded={menuOpen}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        void openMenu({ x: rect.left, y: rect.bottom + 4 });
      }}
      className="no-drag inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] aria-expanded:bg-[var(--sidebar-item-hover)]">
      <MoreHorizontal className="h-4 w-4" />
    </button>
  );
}
