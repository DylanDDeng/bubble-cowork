import { Clock, Folder } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';

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
        <Clock className="w-3.5 h-3.5" />
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
        <Folder className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
