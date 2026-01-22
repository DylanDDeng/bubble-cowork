import { useState, useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { sendEvent } from '../hooks/useIPC';

interface NewFolderDialogProps {
  open: boolean;
  sessionId: string | null;
  onOpenChange: (open: boolean) => void;
}

export function NewFolderDialog({ open, sessionId, onOpenChange }: NewFolderDialogProps) {
  const [folderPath, setFolderPath] = useState('');

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setFolderPath('');
    }
  }, [open]);

  const handleCreate = () => {
    if (folderPath.trim() && sessionId) {
      sendEvent({ type: 'session.setFolder', payload: { sessionId, folderPath: folderPath.trim() } });
      onOpenChange(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-6 w-[400px] shadow-xl z-50">
          <Dialog.Title className="text-lg font-semibold mb-4">
            New Folder
          </Dialog.Title>
          <Dialog.Description className="text-[var(--text-secondary)] text-sm mb-4">
            Enter a folder path. Use "/" for nested folders (e.g., "Work/ProjectA").
          </Dialog.Description>

          <input
            type="text"
            value={folderPath}
            onChange={(e) => setFolderPath(e.target.value)}
            placeholder="e.g., Work/ProjectA"
            className="w-full px-3 py-2 bg-[var(--bg-tertiary)] border border-[var(--border)] rounded-lg text-sm mb-4 focus:outline-none focus:border-[var(--accent)]"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleCreate();
              }
            }}
          />

          <div className="flex justify-end gap-2">
            <button
              onClick={() => onOpenChange(false)}
              className="px-4 py-2 rounded-lg text-sm hover:bg-[var(--bg-tertiary)] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!folderPath.trim()}
              className="px-4 py-2 rounded-lg text-sm bg-[var(--accent)] hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Create & Move
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
