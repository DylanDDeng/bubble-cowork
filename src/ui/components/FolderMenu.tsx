import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useAppStore } from '../store/useAppStore';
import { sendEvent } from '../hooks/useIPC';
import { buildFolderTree, getFolderDisplayName, type FolderTreeNode } from '../utils/folder-utils';

interface FolderMenuProps {
  sessionId: string;
  currentFolderPath?: string | null;
  onNewFolderRequest?: (sessionId: string) => void;
}

export function FolderMenu({ sessionId, currentFolderPath, onNewFolderRequest }: FolderMenuProps) {
  const { folderConfigs } = useAppStore();

  const folderTree = buildFolderTree(folderConfigs);

  const handleSetFolder = (folderPath: string | null) => {
    sendEvent({ type: 'session.setFolder', payload: { sessionId, folderPath } });
  };

  const renderFolderItem = (node: FolderTreeNode, depth: number = 0) => {
    const isSelected = currentFolderPath === node.path;
    const hasChildren = node.children.length > 0;

    return (
      <div key={node.path}>
        <DropdownMenu.Item
          onClick={() => handleSetFolder(node.path)}
          className={`flex items-center gap-2 px-3 py-2 text-sm rounded-md cursor-pointer outline-none transition-colors duration-150 ${
            isSelected
              ? 'bg-[var(--accent-light)]'
              : 'hover:bg-[var(--text-primary)]/5'
          }`}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
        >
          <FolderIcon />
          <span className="truncate">{getFolderDisplayName(node)}</span>
          {isSelected && <CheckIcon className="ml-auto flex-shrink-0" />}
        </DropdownMenu.Item>
        {hasChildren && node.children.map(child => renderFolderItem(child, depth + 1))}
      </div>
    );
  };

  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className="flex items-center gap-2 px-3 py-2 text-sm rounded-md cursor-pointer hover:bg-[var(--text-primary)]/5 outline-none transition-colors duration-150 data-[state=open]:bg-[var(--text-primary)]/5">
        <FolderIcon />
        Move to Folder
        <ChevronRightIcon className="ml-auto" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent
          className="bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg p-1 min-w-[180px] max-h-[300px] overflow-y-auto shadow-lg z-50"
          sideOffset={8}
          alignOffset={-5}
        >
          {/* Uncategorized 选项 */}
          <DropdownMenu.Item
            onClick={() => handleSetFolder(null)}
            className={`flex items-center gap-2 px-3 py-2 text-sm rounded-md cursor-pointer outline-none transition-colors duration-150 ${
              !currentFolderPath
                ? 'bg-[var(--accent-light)]'
                : 'hover:bg-[var(--text-primary)]/5'
            }`}
          >
            <UncategorizedIcon />
            <span>Uncategorized</span>
            {!currentFolderPath && <CheckIcon className="ml-auto" />}
          </DropdownMenu.Item>

          {folderTree.length > 0 && (
            <DropdownMenu.Separator className="h-px bg-[var(--border)] my-1" />
          )}

          {/* 文件夹列表 */}
          {folderTree.map(node => renderFolderItem(node))}

          <DropdownMenu.Separator className="h-px bg-[var(--border)] my-1" />

          {/* 新建文件夹 */}
          <DropdownMenu.Item
            onSelect={() => onNewFolderRequest?.(sessionId)}
            className="flex items-center gap-2 px-3 py-2 text-sm rounded-md cursor-pointer hover:bg-[var(--text-primary)]/5 outline-none transition-colors duration-150 text-[var(--accent)]"
          >
            <PlusIcon />
            <span>New Folder...</span>
          </DropdownMenu.Item>
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

// Icons
function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function UncategorizedIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="9" y1="9" x2="15" y2="15" />
      <line x1="15" y1="9" x2="9" y2="15" />
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

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
