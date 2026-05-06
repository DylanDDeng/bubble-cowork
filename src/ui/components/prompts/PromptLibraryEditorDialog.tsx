import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
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
  const [category, setCategory] = useState('');
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
    setCategory(initialItem?.tags[0] || '');
    setTagsInput(initialItem?.tags.slice(1).join(', ') || '');
    setSaving(false);
    setError(null);
  }, [initialContent, initialItem, open]);

  const dialogTitle = useMemo(
    () => (initialItem ? 'Edit Prompt' : initialContent.trim() ? 'Save Prompt' : 'New Prompt'),
    [initialContent, initialItem]
  );

  const isDirty = useMemo(() => {
    if (!open) return false;
    const initialTitle = buildInitialTitle(initialItem, initialContent);
    const initialContentValue = initialItem?.content || initialContent;
    const initialDescription = initialItem?.description || '';
    const initialCategory = initialItem?.tags[0] || '';
    const initialTags = initialItem?.tags.slice(1).join(', ') || '';

    return (
      title !== initialTitle ||
      content !== initialContentValue ||
      description !== initialDescription ||
      category !== initialCategory ||
      tagsInput !== initialTags
    );
  }, [category, content, description, initialContent, initialItem, open, tagsInput, title]);

  const tagPreview = useMemo(() => {
    const normalizedCategory = category.trim().toLowerCase();
    const tags = parseTagsInput(tagsInput);
    return [...(normalizedCategory ? [normalizedCategory] : []), ...tags].filter(
      (tag, index, array) => array.indexOf(tag) === index
    );
  }, [category, tagsInput]);

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
        tags: tagPreview,
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
        <Dialog.Overlay className="fixed inset-0 z-[82] bg-black/30 backdrop-blur-[1.5px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[83] flex max-h-[86vh] w-[min(700px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[16px] border border-[color:color-mix(in_srgb,var(--border)_78%,transparent)] bg-[color:color-mix(in_srgb,var(--bg-primary)_95%,var(--bg-secondary))] shadow-[0_26px_90px_rgba(0,0,0,0.22)] outline-none">
          <div className="flex items-start justify-between gap-4 px-7 pb-4 pt-6">
            <div>
              <Dialog.Title className="text-[22px] font-semibold leading-7 tracking-[-0.03em] text-[var(--text-primary)]">
                {dialogTitle}
              </Dialog.Title>
            </div>

            <div className="flex items-center gap-3">
              {isDirty && (
                <div className="flex items-center gap-2 text-[13px] text-[var(--text-secondary)]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[#f59e0b]" />
                  <span>Unsaved changes</span>
                </div>
              )}
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-[9px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                  aria-label="Close prompt editor"
                  title="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-7 py-2">
            <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_180px]">
              <label className="block space-y-2">
                <span className="text-[13px] font-medium text-[var(--text-primary)]">Title</span>
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Summarize repo before coding"
                  className="h-11 w-full rounded-[10px] border border-[color:color-mix(in_srgb,var(--border)_80%,transparent)] bg-[color:color-mix(in_srgb,var(--bg-primary)_78%,var(--bg-secondary))] px-3 text-[15px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
                />
              </label>

              <label className="block space-y-2">
                <span className="text-[13px] font-medium text-[var(--text-primary)]">Category</span>
                <input
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                  placeholder="research"
                  className="h-11 w-full rounded-[10px] border border-[color:color-mix(in_srgb,var(--border)_80%,transparent)] bg-[color:color-mix(in_srgb,var(--bg-primary)_78%,var(--bg-secondary))] px-3 text-[14px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
                />
              </label>
            </div>

            <label className="mt-5 block space-y-2">
              <span className="text-[13px] font-medium text-[var(--text-primary)]">Tags</span>
              <input
                value={tagsInput}
                onChange={(event) => setTagsInput(event.target.value)}
                placeholder="customers, analysis, planning"
                className="h-11 w-full rounded-[10px] border border-[color:color-mix(in_srgb,var(--border)_80%,transparent)] bg-[color:color-mix(in_srgb,var(--bg-primary)_78%,var(--bg-secondary))] px-3 text-[14px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
              />
            </label>

            {tagPreview.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {tagPreview.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-[7px] bg-[color:color-mix(in_srgb,var(--bg-tertiary)_78%,transparent)] px-2.5 py-1 text-[13px] leading-5 text-[var(--text-secondary)]"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}

            <label className="mt-5 block space-y-2">
              <span className="text-[13px] font-medium text-[var(--text-primary)]">Description</span>
              <input
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Optional note about when to use this prompt"
                className="h-11 w-full rounded-[10px] border border-[color:color-mix(in_srgb,var(--border)_80%,transparent)] bg-[color:color-mix(in_srgb,var(--bg-primary)_78%,var(--bg-secondary))] px-3 text-[14px] text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
              />
            </label>

            <label className="mt-5 block space-y-2">
              <span className="text-[13px] font-medium text-[var(--text-primary)]">Prompt</span>
              <textarea
                value={content}
                onChange={(event) => setContent(event.target.value)}
                rows={12}
                placeholder="Write the prompt you want to reuse..."
                className="min-h-[260px] w-full resize-y rounded-[10px] border border-[color:color-mix(in_srgb,var(--border)_80%,transparent)] bg-[color:color-mix(in_srgb,var(--bg-primary)_78%,var(--bg-secondary))] px-4 py-3 font-mono text-[13px] leading-6 text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
              />
            </label>

            {error ? <div className="mt-3 text-sm text-[#dc2626]">{error}</div> : null}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-[color:color-mix(in_srgb,var(--border)_52%,transparent)] px-7 py-4">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="inline-flex h-10 items-center rounded-[10px] border border-[color:color-mix(in_srgb,var(--border)_72%,transparent)] bg-[color:color-mix(in_srgb,var(--bg-primary)_72%,transparent)] px-4 text-[14px] text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={saving}
              className="inline-flex h-10 items-center rounded-[10px] bg-[var(--accent)] px-4 text-[14px] font-medium text-[var(--accent-foreground)] shadow-[0_1px_2px_rgba(0,0,0,0.12)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? 'Saving...' : initialItem ? 'Save Changes' : 'Save Prompt'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
