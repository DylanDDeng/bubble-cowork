import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { PromptLibraryItem } from '../../types';
import { savePromptLibraryItem } from '../../utils/prompt-library-api';

function parseTagsInput(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag, index, array) => tag.length > 0 && array.indexOf(tag) === index);
}

function buildInitialTitle(item: PromptLibraryItem | null, initialContent: string): string {
  if (item?.title) {
    return item.title;
  }

  const firstLine = initialContent
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);

  return firstLine ? firstLine.slice(0, 60) : '';
}

interface PromptLibraryEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialItem?: PromptLibraryItem | null;
  initialContent?: string;
  onSaved?: (items: PromptLibraryItem[], savedTitle: string) => void;
}

export function PromptLibraryEditorDialog({
  open,
  onOpenChange,
  initialItem = null,
  initialContent = '',
  onSaved,
}: PromptLibraryEditorDialogProps) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [description, setDescription] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    setTitle(buildInitialTitle(initialItem, initialContent));
    setContent(initialItem?.content || initialContent);
    setDescription(initialItem?.description || '');
    setTagsInput(initialItem?.tags.join(', ') || '');
    setSaving(false);
    setError(null);
  }, [initialContent, initialItem, open]);

  const dialogTitle = useMemo(
    () => (initialItem ? 'Edit Prompt' : initialContent.trim() ? 'Save Prompt' : 'New Prompt'),
    [initialContent, initialItem]
  );

  const handleSubmit = async () => {
    if (!title.trim() || !content.trim()) {
      setError('Title and prompt content are required.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const items = await savePromptLibraryItem({
        id: initialItem?.id,
        title: title.trim(),
        content: content.trim(),
        description: description.trim() || undefined,
        tags: parseTagsInput(tagsInput),
      });
      onSaved?.(items, title.trim());
      onOpenChange(false);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to save prompt.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(680px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--bg-secondary)] p-5 shadow-2xl outline-none">
          <Dialog.Title className="text-lg font-semibold text-[var(--text-primary)]">
            {dialogTitle}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-[var(--text-secondary)]">
            Save reusable prompts with tags so you can insert them back into the composer later.
          </Dialog.Description>

          <div className="mt-5 space-y-4">
            <label className="block space-y-2">
              <span className="text-sm font-medium text-[var(--text-primary)]">Title</span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Summarize repo before coding"
                className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2.5 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
              />
            </label>

            <label className="block space-y-2">
              <span className="text-sm font-medium text-[var(--text-primary)]">Prompt</span>
              <textarea
                value={content}
                onChange={(event) => setContent(event.target.value)}
                rows={10}
                placeholder="Write the prompt you want to reuse..."
                className="w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-3 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
              />
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="block space-y-2">
                <span className="text-sm font-medium text-[var(--text-primary)]">Tags</span>
                <input
                  value={tagsInput}
                  onChange={(event) => setTagsInput(event.target.value)}
                  placeholder="research, repo, summary"
                  className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2.5 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
                />
              </label>

              <label className="block space-y-2">
                <span className="text-sm font-medium text-[var(--text-primary)]">Description</span>
                <input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Optional note about when to use this prompt"
                  className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2.5 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
                />
              </label>
            </div>

            {error ? <div className="text-sm text-[#dc2626]">{error}</div> : null}
          </div>

          <div className="mt-6 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={saving}
              className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? 'Saving…' : initialItem ? 'Save Changes' : 'Save Prompt'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
