import { forwardRef } from 'react';
import { Search, X } from 'lucide-react';
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
          <Search className="w-3.5 h-3.5" />
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
            <X className="w-3 h-3" />
          </button>
        )}
      </div>
    );
  }
);

SidebarSearch.displayName = 'SidebarSearch';
