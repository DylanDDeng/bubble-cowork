import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Bookmark,
  Copy,
  Download,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type { PromptLibraryItem } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import {
  deletePromptLibraryItem,
  exportPromptLibrary,
  getPromptLibraryItems,
  importPromptLibrary,
} from '../../utils/prompt-library-api';
import { PromptLibraryEditorDialog } from './PromptLibraryEditorDialog';

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

const TAG_PALETTE = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e',
  '#f97316', '#eab308', '#22c55e', '#14b8a6',
  '#06b6d4', '#3b82f6',
];

function getTagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  }
  return TAG_PALETTE[Math.abs(hash) % TAG_PALETTE.length];
}

function matchesPrompt(item: PromptLibraryItem, query: string, selectedTags: string[]): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  const queryMatched =
    !normalizedQuery ||
    item.title.toLowerCase().includes(normalizedQuery) ||
    item.content.toLowerCase().includes(normalizedQuery) ||
    item.description?.toLowerCase().includes(normalizedQuery) ||
    item.tags.some((tag) => tag.includes(normalizedQuery));

  if (!queryMatched) {
    return false;
  }

  if (selectedTags.length === 0) {
    return true;
  }

  return selectedTags.every((tag) => item.tags.includes(tag));
}

export function PromptLibraryPanel() {
  const { requestPromptLibraryInsert } = useAppStore();
  const [items, setItems] = useState<PromptLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<PromptLibraryItem | null>(null);

  const loadItems = async () => {
    setLoading(true);
    try {
      setItems(await getPromptLibraryItems());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load Prompt Library.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadItems();
  }, []);

  const allTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      for (const tag of item.tags) {
        counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }

    return Array.from(counts.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .map(([tag]) => tag);
  }, [items]);

  const filteredItems = useMemo(
    () => items.filter((item) => matchesPrompt(item, searchQuery, selectedTags)),
    [items, searchQuery, selectedTags]
  );

  const handleDelete = async (item: PromptLibraryItem) => {
    if (!window.confirm(`Delete "${item.title}" from Prompt Library?`)) {
      return;
    }

    try {
      setItems(await deletePromptLibraryItem(item.id));
      toast.success(`Deleted "${item.title}".`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete prompt.');
    }
  };

  const handleImport = async () => {
    try {
      const result = await importPromptLibrary();
      setItems(result.items);
      if (!result.filePath) {
        return;
      }

      toast.success(`Imported ${result.importedCount} prompt${result.importedCount === 1 ? '' : 's'}${result.skippedCount ? `, skipped ${result.skippedCount}` : ''}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to import prompts.');
    }
  };

  const handleExport = async () => {
    try {
      const result = await exportPromptLibrary();
      if (result.canceled || !result.filePath) {
        return;
      }

      toast.success(`Exported ${result.count} prompt${result.count === 1 ? '' : 's'}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to export prompts.');
    }
  };

  const toggleTag = (tag: string) => {
    setSelectedTags((current) =>
      current.includes(tag) ? current.filter((value) => value !== tag) : [...current, tag]
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
      <div className="flex items-center justify-between gap-2 px-1 pb-3 pt-4">
        <div className="text-base font-semibold text-[var(--text-primary)]">Prompt Library</div>

        <div className="flex items-center gap-1">
          <IconActionButton title="Import prompts" onClick={() => void handleImport()}>
            <Upload className="h-4 w-4" />
          </IconActionButton>
          <IconActionButton title="Export prompts" onClick={() => void handleExport()} disabled={items.length === 0}>
            <Download className="h-4 w-4" />
          </IconActionButton>
          <IconActionButton
            title="New prompt"
            onClick={() => {
              setEditingItem(null);
              setEditorOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
          </IconActionButton>
        </div>
      </div>

      <div className="relative px-1 pb-3">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
        <input
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Search prompts, content, or tags"
          className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] py-2 pl-9 pr-9 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
        />
        {searchQuery ? (
          <button
            type="button"
            onClick={() => setSearchQuery('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>

      {allTags.length > 0 ? (
        <div className="flex flex-wrap gap-2 px-1 pb-3">
          {allTags.map((tag) => {
            const active = selectedTags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                onClick={() => toggleTag(tag)}
                className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                  active
                    ? 'border-[var(--accent)] bg-[var(--accent-light)] font-medium text-[var(--text-primary)]'
                    : 'border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                }`}
              >
                #{tag}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-1">
        {loading ? (
          <div className="rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-8 text-sm text-[var(--text-secondary)]">
            Loading prompts...
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="flex flex-col items-center rounded-[var(--radius-2xl)] border border-dashed border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-10 text-center">
            <Bookmark className="mb-3 h-8 w-8 text-[var(--text-muted)]" strokeWidth={1.5} />
            <div className="text-sm text-[var(--text-secondary)]">
              {items.length === 0
                ? 'No prompts saved yet.'
                : 'No prompts match your current search.'}
            </div>
            {items.length === 0 && (
              <button
                type="button"
                onClick={() => {
                  setEditingItem(null);
                  setEditorOpen(true);
                }}
                className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]"
              >
                <Plus className="h-3.5 w-3.5" />
                Create your first prompt
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-3 pb-2">
            {filteredItems.map((item) => (
              <div
                key={item.id}
                className="group/card relative overflow-hidden rounded-[var(--radius-2xl)] border border-[var(--border)] bg-[var(--bg-secondary)]"
              >
                {item.tags.length > 0 && (
                  <div
                    className="absolute left-0 top-0 bottom-0 w-[3px]"
                    style={{ backgroundColor: getTagColor(item.tags[0]) }}
                  />
                )}

                <div className="p-4">
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--text-primary)]">
                      {item.title}
                    </div>
                    <span className="flex-shrink-0 text-[11px] text-[var(--text-muted)]">
                      {formatRelativeTime(item.updatedAt)}
                    </span>
                  </div>

                  {item.tags.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {item.tags.map((tag) => (
                        <button
                          key={tag}
                          type="button"
                          onClick={() => toggleTag(tag)}
                          className="rounded-full bg-[var(--bg-tertiary)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                        >
                          #{tag}
                        </button>
                      ))}
                    </div>
                  )}

                  {item.description && (
                    <div className="mt-2 text-xs leading-5 text-[var(--text-secondary)]">
                      {item.description}
                    </div>
                  )}

                  <div className="relative mt-2">
                    <div className="line-clamp-3 whitespace-pre-wrap text-[13px] leading-5 text-[var(--text-secondary)]">
                      {item.content}
                    </div>
                    <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-[var(--bg-secondary)] to-transparent" />
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    <InlineActionButton
                      onClick={() => {
                        requestPromptLibraryInsert(item.content, 'append');
                        toast.success(`Inserted "${item.title}" into the composer.`);
                      }}
                      tone="primary"
                    >
                      Insert
                    </InlineActionButton>
                    <div className="flex items-center gap-1 opacity-0 transition-opacity duration-150 group-hover/card:opacity-100">
                      <InlineActionButton
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(item.content);
                            toast.success(`Copied "${item.title}".`);
                          } catch {
                            toast.error('Failed to copy prompt.');
                          }
                        }}
                      >
                        <Copy className="h-3.5 w-3.5" />
                        Copy
                      </InlineActionButton>
                      <InlineActionButton
                        onClick={() => {
                          setEditingItem(item);
                          setEditorOpen(true);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        Edit
                      </InlineActionButton>
                      <InlineActionButton onClick={() => void handleDelete(item)} tone="danger">
                        <Trash2 className="h-3.5 w-3.5" />
                      </InlineActionButton>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <PromptLibraryEditorDialog
        open={editorOpen}
        onOpenChange={(open) => {
          setEditorOpen(open);
          if (!open) {
            setEditingItem(null);
          }
        }}
        initialItem={editingItem}
        onSaved={(nextItems, savedTitle) => {
          setItems(nextItems);
          toast.success(`${editingItem ? 'Updated' : 'Saved'} "${savedTitle}".`);
          setEditingItem(null);
        }}
      />
    </div>
  );
}

function IconActionButton({
  children,
  disabled,
  onClick,
  title,
}: {
  children: ReactNode;
  disabled?: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--sidebar-item-hover)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function InlineActionButton({
  children,
  onClick,
  tone = 'default',
}: {
  children: ReactNode;
  onClick: () => void;
  tone?: 'default' | 'primary' | 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
        tone === 'danger'
          ? 'text-[#dc2626] hover:bg-[#dc2626]/10'
          : tone === 'primary'
            ? 'font-medium text-[var(--text-primary)] bg-[var(--accent-light)] hover:bg-[var(--accent)]/15'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
      }`}
    >
      {children}
    </button>
  );
}
