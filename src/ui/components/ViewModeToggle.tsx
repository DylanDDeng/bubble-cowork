import { useAppStore } from '../store/useAppStore';
import type { SidebarViewMode } from '../types';

export function ViewModeToggle() {
  const { sidebarViewMode, setSidebarViewMode } = useAppStore();

  return (
    <div className="flex items-center bg-[var(--bg-tertiary)] rounded-md p-0.5">
      <button
        onClick={() => setSidebarViewMode('time')}
        className={`p-1.5 rounded transition-colors duration-150 ${
          sidebarViewMode === 'time'
            ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)]'
            : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
        }`}
        title="Time View"
      >
        <ClockIcon />
      </button>
      <button
        onClick={() => setSidebarViewMode('folder')}
        className={`p-1.5 rounded transition-colors duration-150 ${
          sidebarViewMode === 'folder'
            ? 'bg-[var(--bg-secondary)] text-[var(--text-primary)]'
            : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
        }`}
        title="Folder View"
      >
        <FolderIcon />
      </button>
    </div>
  );
}

function ClockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}
