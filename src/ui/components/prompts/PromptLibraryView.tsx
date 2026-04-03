import { useEffect, useMemo, useState } from 'react';
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
import {
  deletePromptLibraryItem,
  exportPromptLibrary,
  getPromptLibraryItems,
  importPromptLibrary,
  savePromptLibraryItem,
} from '../../utils/prompt-library-api';

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

  if (!queryMatched) return false;
  if (selectedTags.length === 0) return true;
  return selectedTags.every((tag) => item.tags.includes(tag));
}

function parseTagsInput(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((tag) => tag.trim().toLowerCase())
    .filter((tag, index, array) => tag.length > 0 && array.indexOf(tag) === index);
}

type RightPanelMode = 'empty' | 'detail' | 'editor';

export function PromptLibraryView() {
  const [items, setItems] = useState<PromptLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<RightPanelMode>('empty');
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
    [items, searchQuery, selectedTags],
  );

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId],
  );

  const handleDelete = async (item: PromptLibraryItem) => {
    if (!window.confirm(`Delete "${item.title}" from Prompt Library?`)) return;
    try {
      const next = await deletePromptLibraryItem(item.id);
      setItems(next);
      if (selectedId === item.id) {
        setSelectedId(null);
        setPanelMode('empty');
      }
      toast.success(`Deleted "${item.title}".`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete prompt.');
    }
  };

  const handleImport = async () => {
    try {
      const result = await importPromptLibrary();
      setItems(result.items);
      if (!result.filePath) return;
      toast.success(
        `Imported ${result.importedCount} prompt${result.importedCount === 1 ? '' : 's'}${result.skippedCount ? `, skipped ${result.skippedCount}` : ''}.`,
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to import prompts.');
    }
  };

  const handleExport = async () => {
    try {
      const result = await exportPromptLibrary();
      if (result.canceled || !result.filePath) return;
      toast.success(`Exported ${result.count} prompt${result.count === 1 ? '' : 's'}.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to export prompts.');
    }
  };

  const handleCopy = async (item: PromptLibraryItem) => {
    try {
      await navigator.clipboard.writeText(item.content);
      toast.success(`Copied "${item.title}" to clipboard.`);
    } catch {
      toast.error('Failed to copy prompt.');
    }
  };

  const toggleTag = (tag: string) => {
    setSelectedTags((current) =>
      current.includes(tag) ? current.filter((v) => v !== tag) : [...current, tag],
    );
  };

  const openNewEditor = () => {
    setEditingItem(null);
    setSelectedId(null);
    setPanelMode('editor');
  };

  const openEditEditor = (item: PromptLibraryItem) => {
    setEditingItem(item);
    setPanelMode('editor');
  };

  const handleEditorSaved = (nextItems: PromptLibraryItem[], savedTitle: string, savedId: string) => {
    setItems(nextItems);
    setSelectedId(savedId);
    setPanelMode('detail');
    toast.success(`${editingItem ? 'Updated' : 'Saved'} "${savedTitle}".`);
    setEditingItem(null);
  };

  const handleEditorCancel = () => {
    if (selectedItem) {
      setPanelMode('detail');
    } else {
      setPanelMode('empty');
    }
    setEditingItem(null);
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--bg-primary)]">
      <div className="h-8 drag-region flex-shrink-0 border-b border-[var(--border)]" />

      <div className="flex min-h-0 flex-1">
        {/* ===== Left pane: list ===== */}
        <aside className="flex w-[320px] flex-shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-tertiary)]">
          {/* Header */}
          <div className="flex items-center justify-between gap-2 px-4 pb-3 pt-5">
            <h1 className="text-lg font-semibold text-[var(--text-primary)]">Prompt Library</h1>
            <div className="flex items-center gap-1">
              <HeaderIconButton title="Import" onClick={() => void handleImport()}>
                <Upload className="h-4 w-4" />
              </HeaderIconButton>
              <HeaderIconButton title="Export" onClick={() => void handleExport()} disabled={items.length === 0}>
                <Download className="h-4 w-4" />
              </HeaderIconButton>
              <HeaderIconButton title="New prompt" onClick={openNewEditor}>
                <Plus className="h-4 w-4" />
              </HeaderIconButton>
            </div>
          </div>

          {/* Search */}
          <div className="relative px-4 pb-3">
            <Search className="pointer-events-none absolute left-7 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search prompts..."
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] py-2 pl-9 pr-9 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-6 top-1/2 -translate-y-1/2 rounded-md p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Tags */}
          {allTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-4 pb-3">
              {allTags.map((tag) => {
                const active = selectedTags.includes(tag);
                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleTag(tag)}
                    className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
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
          )}

          {/* List */}
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {loading ? (
              <div className="px-2 py-8 text-center text-sm text-[var(--text-secondary)]">Loading...</div>
            ) : filteredItems.length === 0 ? (
              <div className="flex flex-col items-center px-4 py-10 text-center">
                <Bookmark className="mb-3 h-8 w-8 text-[var(--text-muted)]" strokeWidth={1.5} />
                <div className="text-sm text-[var(--text-secondary)]">
                  {items.length === 0 ? 'No prompts saved yet.' : 'No prompts match your search.'}
                </div>
                {items.length === 0 && (
                  <button
                    type="button"
                    onClick={openNewEditor}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Create your first prompt
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-1">
                {filteredItems.map((item) => {
                  const isActive = selectedId === item.id && panelMode === 'detail';
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        setSelectedId(item.id);
                        setPanelMode('detail');
                        setEditingItem(null);
                      }}
                      className={`group relative flex w-full flex-col gap-1 rounded-xl px-3 py-2.5 text-left transition-colors ${
                        isActive
                          ? 'bg-[var(--sidebar-item-active)] text-[var(--text-primary)]'
                          : 'text-[var(--text-primary)] hover:bg-[var(--sidebar-item-hover)]'
                      }`}
                    >
                      {item.tags.length > 0 && (
                        <div
                          className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full"
                          style={{ backgroundColor: getTagColor(item.tags[0]) }}
                        />
                      )}
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.title}</span>
                        <span className="flex-shrink-0 text-[11px] text-[var(--text-muted)]">
                          {formatRelativeTime(item.updatedAt)}
                        </span>
                      </div>
                      {item.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {item.tags.map((tag) => (
                            <span
                              key={tag}
                              className="rounded-full bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]"
                            >
                              #{tag}
                            </span>
                          ))}
                        </div>
                      )}
                      {item.description && (
                        <div className="truncate text-xs text-[var(--text-muted)]">{item.description}</div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </aside>

        {/* ===== Right pane: detail / editor ===== */}
        <main className="min-w-0 flex-1 overflow-y-auto bg-[var(--bg-primary)]">
          {panelMode === 'empty' && (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <Bookmark className="mb-4 h-12 w-12 text-[var(--text-muted)]" strokeWidth={1} />
              <div className="text-sm text-[var(--text-secondary)]">
                Select a prompt to view, or create a new one.
              </div>
            </div>
          )}

          {panelMode === 'detail' && selectedItem && (
            <PromptDetailPane
              item={selectedItem}
              onCopy={() => void handleCopy(selectedItem)}
              onEdit={() => openEditEditor(selectedItem)}
              onDelete={() => void handleDelete(selectedItem)}
              onTagClick={toggleTag}
            />
          )}

          {panelMode === 'editor' && (
            <PromptEditorPane
              initialItem={editingItem}
              onSaved={handleEditorSaved}
              onCancel={handleEditorCancel}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function PromptDetailPane({
  item,
  onCopy,
  onEdit,
  onDelete,
  onTagClick,
}: {
  item: PromptLibraryItem;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onTagClick: (tag: string) => void;
}) {
  return (
    <div className="mx-auto max-w-3xl px-10 py-8">
      {/* Title + actions */}
      <div className="flex items-start justify-between gap-4">
        <h2 className="text-[22px] font-semibold tracking-[-0.03em] text-[var(--text-primary)]">
          {item.title}
        </h2>
        <div className="flex flex-shrink-0 items-center gap-1">
          <ActionButton onClick={onCopy}>
            <Copy className="h-3.5 w-3.5" />
            Copy
          </ActionButton>
          <ActionButton onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </ActionButton>
          <ActionButton onClick={onDelete} tone="danger">
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </ActionButton>
        </div>
      </div>

      {/* Meta */}
      <div className="mt-2 flex items-center gap-3 text-xs text-[var(--text-muted)]">
        <span>Updated {formatRelativeTime(item.updatedAt)}</span>
        {item.createdAt !== item.updatedAt && (
          <span>Created {formatRelativeTime(item.createdAt)}</span>
        )}
      </div>

      {/* Tags */}
      {item.tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {item.tags.map((tag) => {
            const color = getTagColor(tag);
            return (
              <button
                key={tag}
                type="button"
                onClick={() => onTagClick(tag)}
                className="rounded-full border px-2.5 py-1 text-xs transition-colors border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
                {tag}
              </button>
            );
          })}
        </div>
      )}

      {/* Description */}
      {item.description && (
        <div className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3 text-sm leading-6 text-[var(--text-secondary)]">
          {item.description}
        </div>
      )}

      {/* Content */}
      <div className="mt-6">
        <div className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--text-muted)]">
          Prompt Content
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-5 py-4 text-sm leading-6 text-[var(--text-primary)] whitespace-pre-wrap">
          {item.content}
        </div>
      </div>
    </div>
  );
}

function PromptEditorPane({
  initialItem,
  onSaved,
  onCancel,
}: {
  initialItem: PromptLibraryItem | null;
  onSaved: (items: PromptLibraryItem[], savedTitle: string, savedId: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(initialItem?.title ?? '');
  const [content, setContent] = useState(initialItem?.content ?? '');
  const [description, setDescription] = useState(initialItem?.description ?? '');
  const [tagsInput, setTagsInput] = useState(initialItem?.tags.join(', ') ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTitle(initialItem?.title ?? '');
    setContent(initialItem?.content ?? '');
    setDescription(initialItem?.description ?? '');
    setTagsInput(initialItem?.tags.join(', ') ?? '');
    setSaving(false);
    setError(null);
  }, [initialItem]);

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
      const savedItem = items.find((item) => item.title === title.trim());
      onSaved(items, title.trim(), savedItem?.id ?? initialItem?.id ?? '');
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : 'Failed to save prompt.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-10 py-8">
      <h2 className="text-[22px] font-semibold tracking-[-0.03em] text-[var(--text-primary)]">
        {initialItem ? 'Edit Prompt' : 'New Prompt'}
      </h2>
      <p className="mt-1 text-sm text-[var(--text-muted)]">
        Save reusable prompts with tags for quick access.
      </p>

      <div className="mt-6 space-y-5">
        <label className="block space-y-2">
          <span className="text-sm font-medium text-[var(--text-primary)]">Title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Summarize repo before coding"
            className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2.5 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
          />
        </label>

        <label className="block space-y-2">
          <span className="text-sm font-medium text-[var(--text-primary)]">Prompt</span>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={12}
            placeholder="Write the prompt you want to reuse..."
            className="w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-3 text-sm leading-6 text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
          />
        </label>

        <div className="grid gap-5 md:grid-cols-2">
          <label className="block space-y-2">
            <span className="text-sm font-medium text-[var(--text-primary)]">Tags</span>
            <input
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="research, repo, summary"
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2.5 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
            />
          </label>

          <label className="block space-y-2">
            <span className="text-sm font-medium text-[var(--text-primary)]">Description</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional note about when to use this"
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2.5 text-sm text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
            />
          </label>
        </div>

        {error && <div className="text-sm text-[#dc2626]">{error}</div>}
      </div>

      <div className="mt-8 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={saving}
          className="rounded-xl bg-[var(--accent)] px-5 py-2.5 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? 'Saving...' : initialItem ? 'Save Changes' : 'Save Prompt'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-xl px-5 py-2.5 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function HeaderIconButton({
  children,
  disabled,
  onClick,
  title,
}: {
  children: React.ReactNode;
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

function ActionButton({
  children,
  onClick,
  tone = 'default',
}: {
  children: React.ReactNode;
  onClick: () => void;
  tone?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
        tone === 'danger'
          ? 'text-[#dc2626] hover:bg-[#dc2626]/10'
          : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
      }`}
    >
      {children}
    </button>
  );
}
