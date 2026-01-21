import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useAppStore } from '../store/useAppStore';
import { StatusIcon } from './StatusIcon';

export function StatusFilter() {
  const { statusConfigs, statusFilter, setStatusFilter } = useAppStore();

  const openStatuses = statusConfigs.filter(s => s.category === 'open');
  const closedStatuses = statusConfigs.filter(s => s.category === 'closed');

  // 获取当前过滤器显示文本
  const getFilterLabel = () => {
    if (statusFilter === 'all') return 'All';
    if (statusFilter === 'open') return 'Open';
    if (statusFilter === 'closed') return 'Closed';
    const status = statusConfigs.find(s => s.id === statusFilter);
    return status?.label || 'All';
  };

  // 获取当前过滤器图标
  const getCurrentIcon = () => {
    if (statusFilter === 'all' || statusFilter === 'open' || statusFilter === 'closed') {
      return null;
    }
    const status = statusConfigs.find(s => s.id === statusFilter);
    return status ? <StatusIcon status={status} className="text-xs" /> : null;
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="flex items-center gap-1.5 px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--text-primary)]/5 rounded-md transition-colors duration-150">
          {getCurrentIcon() || <FilterIcon />}
          <span>{getFilterLabel()}</span>
          <ChevronDownIcon />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg p-1 min-w-[160px] shadow-lg z-50"
          sideOffset={5}
          align="end"
        >
          {/* 快速过滤器 */}
          <DropdownMenu.Item
            onClick={() => setStatusFilter('all')}
            className={`flex items-center gap-2 px-3 py-2 text-sm rounded-md cursor-pointer outline-none transition-colors duration-150 ${
              statusFilter === 'all'
                ? 'bg-[var(--accent-light)]'
                : 'hover:bg-[var(--text-primary)]/5'
            }`}
          >
            <AllIcon />
            <span>All</span>
            {statusFilter === 'all' && <CheckIcon className="ml-auto" />}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onClick={() => setStatusFilter('open')}
            className={`flex items-center gap-2 px-3 py-2 text-sm rounded-md cursor-pointer outline-none transition-colors duration-150 ${
              statusFilter === 'open'
                ? 'bg-[var(--accent-light)]'
                : 'hover:bg-[var(--text-primary)]/5'
            }`}
          >
            <OpenIcon />
            <span>Open</span>
            {statusFilter === 'open' && <CheckIcon className="ml-auto" />}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onClick={() => setStatusFilter('closed')}
            className={`flex items-center gap-2 px-3 py-2 text-sm rounded-md cursor-pointer outline-none transition-colors duration-150 ${
              statusFilter === 'closed'
                ? 'bg-[var(--accent-light)]'
                : 'hover:bg-[var(--text-primary)]/5'
            }`}
          >
            <ClosedIcon />
            <span>Closed</span>
            {statusFilter === 'closed' && <CheckIcon className="ml-auto" />}
          </DropdownMenu.Item>

          {openStatuses.length > 0 && (
            <>
              <DropdownMenu.Separator className="h-px bg-[var(--border)] my-1" />
              <DropdownMenu.Label className="px-3 py-1.5 text-xs text-[var(--text-muted)] font-medium">
                Open
              </DropdownMenu.Label>
              {openStatuses.map(status => (
                <DropdownMenu.Item
                  key={status.id}
                  onClick={() => setStatusFilter(status.id)}
                  className={`flex items-center gap-2 px-3 py-2 text-sm rounded-md cursor-pointer outline-none transition-colors duration-150 ${
                    statusFilter === status.id
                      ? 'bg-[var(--accent-light)]'
                      : 'hover:bg-[var(--text-primary)]/5'
                  }`}
                >
                  <StatusIcon status={status} />
                  <span>{status.label}</span>
                  {statusFilter === status.id && <CheckIcon className="ml-auto" />}
                </DropdownMenu.Item>
              ))}
            </>
          )}

          {closedStatuses.length > 0 && (
            <>
              <DropdownMenu.Separator className="h-px bg-[var(--border)] my-1" />
              <DropdownMenu.Label className="px-3 py-1.5 text-xs text-[var(--text-muted)] font-medium">
                Closed
              </DropdownMenu.Label>
              {closedStatuses.map(status => (
                <DropdownMenu.Item
                  key={status.id}
                  onClick={() => setStatusFilter(status.id)}
                  className={`flex items-center gap-2 px-3 py-2 text-sm rounded-md cursor-pointer outline-none transition-colors duration-150 ${
                    statusFilter === status.id
                      ? 'bg-[var(--accent-light)]'
                      : 'hover:bg-[var(--text-primary)]/5'
                  }`}
                >
                  <StatusIcon status={status} />
                  <span>{status.label}</span>
                  {statusFilter === status.id && <CheckIcon className="ml-auto" />}
                </DropdownMenu.Item>
              ))}
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// Icons
function FilterIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function AllIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
    </svg>
  );
}

function OpenIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
    </svg>
  );
}

function ClosedIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <line x1="15" y1="9" x2="9" y2="15" />
      <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
  );
}

function CheckIcon({ className = '' }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
