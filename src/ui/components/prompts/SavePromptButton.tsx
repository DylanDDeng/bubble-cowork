import { useState } from 'react';
import { BookmarkPlus } from 'lucide-react';
import { toast } from 'sonner';
import { PromptLibraryEditorDialog } from './PromptLibraryEditorDialog';

interface SavePromptButtonProps {
  content: string;
  disabled?: boolean;
}

export function SavePromptButton({ content, disabled = false }: SavePromptButtonProps) {
  const [open, setOpen] = useState(false);
  const hasContent = content.trim().length > 0;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled || !hasContent}
        className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
        title="Save current prompt"
        aria-label="Save current prompt"
      >
        <BookmarkPlus className="h-4 w-4" />
        <span>Save</span>
      </button>

      <PromptLibraryEditorDialog
        open={open}
        onOpenChange={setOpen}
        initialContent={content}
        onSaved={(_items, savedTitle) => {
          toast.success(`Saved “${savedTitle}” to Prompt Library.`);
        }}
      />
    </>
  );
}
