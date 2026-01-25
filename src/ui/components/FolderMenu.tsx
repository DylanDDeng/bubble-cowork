import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Folder, ChevronRight, Check, Plus, XSquare } from 'lucide-react';
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
          <Folder className="w-3.5 h-3.5" />
          <span className="truncate">{getFolderDisplayName(node)}</span>
          {isSelected && <Check className="w-3.5 h-3.5 ml-auto flex-shrink-0" />}
        </DropdownMenu.Item>
        {hasChildren && node.children.map(child => renderFolderItem(child, depth + 1))}
      </div>
    );
  };

  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className="flex items-center gap-2 px-3 py-2 text-sm rounded-md cursor-pointer hover:bg-[var(--text-primary)]/5 outline-none transition-colors duration-150 data-[state=open]:bg-[var(--text-primary)]/5">
        <Folder className="w-3.5 h-3.5" />
        Move to Folder
        <ChevronRight className="w-3.5 h-3.5 ml-auto" />
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
            <XSquare className="w-3.5 h-3.5" />
            <span>Uncategorized</span>
            {!currentFolderPath && <Check className="w-3.5 h-3.5 ml-auto" />}
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
            <Plus className="w-3.5 h-3.5" />
            <span>New Folder...</span>
          </DropdownMenu.Item>
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

