import { forwardRef } from 'react';
import { useAppStore } from '../../store/useAppStore';

interface SidebarSearchProps {
  className?: string;
}

export const SidebarSearch = forwardRef<HTMLInputElement, SidebarSearchProps>(
  ({ className = '' }, ref) => {
    const { sidebarSearchQuery, setSidebarSearchQuery } = useAppStore();

    return (
      <div className={`relative ${className}`}>
        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">
          <SearchIcon />
        </div>
        <input
          ref={ref}
          type="text"
          value={sidebarSearchQuery}
          onChange={(e) => setSidebarSearchQuery(e.target.value)}
          placeholder="Search sessions..."
          className="w-full pl-9 pr-8 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg text-sm placeholder:text-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] transition-colors"
        />
        {sidebarSearchQuery && (
          <button
            onClick={() => setSidebarSearchQuery('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
          >
            <ClearIcon />
          </button>
        )}
      </div>
    );
  }
);

SidebarSearch.displayName = 'SidebarSearch';

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
