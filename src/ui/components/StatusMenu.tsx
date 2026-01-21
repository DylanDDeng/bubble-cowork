import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import { StatusIcon } from './StatusIcon';

interface StatusMenuProps {
  sessionId: string;
  currentStatus: string;
}

export function StatusMenu({ sessionId, currentStatus }: StatusMenuProps) {
  const { statusConfigs } = useAppStore();

  const openStatuses = statusConfigs.filter(s => s.category === 'open');
  const closedStatuses = statusConfigs.filter(s => s.category === 'closed');

  const handleSetStatus = (todoState: string) => {
    sendEvent({ type: 'session.setTodoState', payload: { sessionId, todoState } });
  };

  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className="flex items-center gap-2 px-3 py-2 text-sm rounded-md cursor-pointer hover:bg-[var(--text-primary)]/5 outline-none transition-colors duration-150 data-[state=open]:bg-[var(--text-primary)]/5">
        <StatusArrowIcon />
        Set Status
        <ChevronRightIcon className="ml-auto" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent
          className="bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg p-1 min-w-[160px] shadow-lg z-50"
          sideOffset={8}
          alignOffset={-5}
        >
          {/* Open 分类 */}
          <DropdownMenu.Label className="px-3 py-1.5 text-xs text-[var(--text-muted)] font-medium">
            Open
          </DropdownMenu.Label>
          {openStatuses.map(status => (
            <DropdownMenu.Item
              key={status.id}
              onClick={() => handleSetStatus(status.id)}
              className={`flex items-center gap-2 px-3 py-2 text-sm rounded-md cursor-pointer outline-none transition-colors duration-150 ${
                currentStatus === status.id
                  ? 'bg-[var(--accent-light)]'
                  : 'hover:bg-[var(--text-primary)]/5'
              }`}
            >
              <StatusIcon status={status} />
              <span>{status.label}</span>
              {currentStatus === status.id && <CheckIcon className="ml-auto" />}
            </DropdownMenu.Item>
          ))}

          <DropdownMenu.Separator className="h-px bg-[var(--border)] my-1" />

          {/* Closed 分类 */}
          <DropdownMenu.Label className="px-3 py-1.5 text-xs text-[var(--text-muted)] font-medium">
            Closed
          </DropdownMenu.Label>
          {closedStatuses.map(status => (
            <DropdownMenu.Item
              key={status.id}
              onClick={() => handleSetStatus(status.id)}
              className={`flex items-center gap-2 px-3 py-2 text-sm rounded-md cursor-pointer outline-none transition-colors duration-150 ${
                currentStatus === status.id
                  ? 'bg-[var(--accent-light)]'
                  : 'hover:bg-[var(--text-primary)]/5'
              }`}
            >
              <StatusIcon status={status} />
              <span>{status.label}</span>
              {currentStatus === status.id && <CheckIcon className="ml-auto" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

// Icons
function StatusArrowIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 8 16 12 12 16" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}

function ChevronRightIcon({ className = '' }: { className?: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={className}>
      <polyline points="9 18 15 12 9 6" />
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
