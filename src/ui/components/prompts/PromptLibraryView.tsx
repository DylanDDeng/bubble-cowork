import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  Bookmark,
  Copy,
  Download,
  LayoutGrid,
  LayoutList,
  LoaderCircle,
  MoreHorizontal,
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
import { SidebarHeaderTrigger } from '../Sidebar';
import {
  deletePromptLibraryItem,
  exportPromptLibrary,
  getPromptLibraryItems,
  importPromptLibrary,
} from '../../utils/prompt-library-api';
import { PromptLibraryEditorDialog } from './PromptLibraryEditorDialog';

type PromptViewMode = 'grid' | 'list';

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
  '#2f7d46',
  '#1f6fb2',
  '#9a6b19',
  '#6555b8',
  '#9a4a6f',
  '#3c7d7d',
  '#7b6238',
  '#64748b',
];

function getTagColor(tag: string): string {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) {
    hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  }
  return TAG_PALETTE[Math.abs(hash) % TAG_PALETTE.length];
}

function getPromptCategory(item: PromptLibraryItem): string {
  return item.tags[0] || 'General';
}

function matchesPrompt(item: PromptLibraryItem, query: string, category: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  const queryMatched =
    !normalizedQuery ||
    item.title.toLowerCase().includes(normalizedQuery) ||
    item.content.toLowerCase().includes(normalizedQuery) ||
    item.description?.toLowerCase().includes(normalizedQuery) ||
    item.tags.some((tag) => tag.includes(normalizedQuery));

  if (!queryMatched) return false;
  if (category === 'all') return true;
  return item.tags.includes(category);
}

export function PromptLibraryView() {
  const {
    sidebarCollapsed,
    requestPromptLibraryInsert,
    setActiveWorkspace,
    setChatSidebarView,
    setShowSettings,
  } = useAppStore();
  const [items, setItems] = useState<PromptLibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [viewMode, setViewMode] = useState<PromptViewMode>('grid');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
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

  const categories = useMemo(() => {
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
    () => items.filter((item) => matchesPrompt(item, searchQuery, selectedCategory)),
    [items, searchQuery, selectedCategory],
  );

  const selectedItem = useMemo(
    () => items.find((item) => item.id === selectedId) ?? null,
    [items, selectedId],
  );

  const openPromptDetail = (item: PromptLibraryItem) => {
    setSelectedId(item.id);
    setDetailOpen(true);
  };

  const openNewEditor = () => {
    setEditingItem(null);
    setEditorOpen(true);
  };

  const openEditEditor = (item: PromptLibraryItem) => {
    setEditingItem(item);
    setDetailOpen(false);
    setEditorOpen(true);
  };

  const handleDelete = async (item: PromptLibraryItem) => {
    if (!window.confirm(`Delete "${item.title}" from Prompt Library?`)) return;
    try {
      const next = await deletePromptLibraryItem(item.id);
      setItems(next);
      if (selectedId === item.id) {
        setSelectedId(null);
        setDetailOpen(false);
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

  const handleUsePrompt = (item: PromptLibraryItem) => {
    requestPromptLibraryInsert(item.content, 'append');
    setActiveWorkspace('chat');
    setChatSidebarView('threads');
    setShowSettings(false);
    setDetailOpen(false);
    toast.success(`Inserted "${item.title}".`);
  };

  const clearFilters = () => {
    setSearchQuery('');
    setSelectedCategory('all');
  };

  const hasFilters = Boolean(searchQuery.trim()) || selectedCategory !== 'all';

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[color:color-mix(in_srgb,var(--bg-primary)_92%,var(--bg-tertiary))]">
      <div className={`${sidebarCollapsed ? 'h-12' : 'h-8'} drag-region flex-shrink-0 bg-transparent`}>
        <div className="flex h-full items-center px-3">
          {sidebarCollapsed ? <SidebarHeaderTrigger className="ml-[72px]" /> : null}
        </div>
      </div>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1500px] px-8 pb-8 pt-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="text-[25px] font-semibold leading-8 tracking-[-0.03em] text-[var(--text-primary)]">
                Prompt Library
              </h1>
              <p className="mt-1 text-[14px] text-[var(--text-secondary)]">
                {items.length} saved prompt{items.length === 1 ? '' : 's'}
              </p>
            </div>

            <div className="flex items-center gap-2">
              <HeaderIconButton title="Import" onClick={() => void handleImport()}>
                <Upload className="h-4 w-4" />
              </HeaderIconButton>
              <HeaderIconButton title="Export" onClick={() => void handleExport()} disabled={items.length === 0}>
                <Download className="h-4 w-4" />
              </HeaderIconButton>
              <button
                type="button"
                onClick={openNewEditor}
                className="inline-flex h-10 items-center gap-2 rounded-[10px] bg-[var(--accent)] px-4 text-[14px] font-medium text-[var(--accent-foreground)] shadow-[0_1px_2px_rgba(0,0,0,0.12)] transition-colors hover:bg-[var(--accent-hover)]"
              >
                <Plus className="h-4 w-4" />
                <span>New Prompt</span>
              </button>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div className="relative w-full max-w-[690px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--text-muted)]" />
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search prompts..."
                className="h-10 w-full rounded-[10px] border border-[color:color-mix(in_srgb,var(--border)_80%,transparent)] bg-[color:color-mix(in_srgb,var(--bg-primary)_68%,transparent)] pl-9 pr-9 text-[14px] text-[var(--text-primary)] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                  aria-label="Clear prompt search"
                  title="Clear"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <select
                value={selectedCategory}
                onChange={(event) => setSelectedCategory(event.target.value)}
                className="h-10 min-w-[220px] rounded-[10px] border border-[color:color-mix(in_srgb,var(--border)_80%,transparent)] bg-[color:color-mix(in_srgb,var(--bg-primary)_72%,transparent)] px-3 text-[14px] text-[var(--text-primary)] outline-none transition-colors focus:border-[var(--accent)]"
                aria-label="Filter prompt category"
              >
                <option value="all">All categories</option>
                {categories.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>

              <div className="inline-flex h-10 items-center rounded-[10px] border border-[color:color-mix(in_srgb,var(--border)_72%,transparent)] bg-[color:color-mix(in_srgb,var(--bg-primary)_64%,transparent)] p-1">
                <ViewModeButton
                  active={viewMode === 'grid'}
                  title="Grid view"
                  onClick={() => setViewMode('grid')}
                >
                  <LayoutGrid className="h-4 w-4" />
                </ViewModeButton>
                <ViewModeButton
                  active={viewMode === 'list'}
                  title="List view"
                  onClick={() => setViewMode('list')}
                >
                  <LayoutList className="h-4 w-4" />
                </ViewModeButton>
              </div>
            </div>
          </div>

          <section className="mt-5">
            {loading ? (
              <div className="flex items-center gap-2 rounded-[14px] border border-[var(--border)] bg-[color:color-mix(in_srgb,var(--bg-primary)_70%,transparent)] px-4 py-4 text-[14px] text-[var(--text-secondary)]">
                <LoaderCircle className="h-4 w-4 animate-spin" />
                <span>Loading prompts...</span>
              </div>
            ) : filteredItems.length === 0 ? (
              <EmptyPromptState
                hasItems={items.length > 0}
                hasFilters={hasFilters}
                onCreate={openNewEditor}
                onClearFilters={clearFilters}
              />
            ) : (
              <div
                className={
                  viewMode === 'grid'
                    ? 'grid grid-cols-1 gap-5 lg:grid-cols-2 2xl:grid-cols-4'
                    : 'grid grid-cols-1 gap-3'
                }
              >
                {filteredItems.map((item) => (
                  <PromptCard
                    key={item.id}
                    item={item}
                    selected={selectedId === item.id}
                    viewMode={viewMode}
                    onSelect={() => openPromptDetail(item)}
                    onCopy={() => void handleCopy(item)}
                  />
                ))}
              </div>
            )}
          </section>
        </div>
      </main>

      <PromptDetailDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        item={selectedItem}
        onCopy={handleCopy}
        onEdit={openEditEditor}
        onDelete={handleDelete}
        onUsePrompt={handleUsePrompt}
        onCategoryClick={setSelectedCategory}
      />

      <PromptLibraryEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
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

function PromptCard({
  item,
  selected,
  viewMode,
  onSelect,
  onCopy,
}: {
  item: PromptLibraryItem;
  selected: boolean;
  viewMode: PromptViewMode;
  onSelect: () => void;
  onCopy: () => void;
}) {
  const category = getPromptCategory(item);
  const color = getTagColor(category);
  const compact = viewMode === 'list';

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      className={`group relative cursor-pointer rounded-[14px] border bg-[color:color-mix(in_srgb,var(--bg-primary)_64%,transparent)] px-5 py-4 text-left shadow-[0_1px_1px_rgba(0,0,0,0.035)] outline-none transition-[border-color,background-color,box-shadow] hover:bg-[color:color-mix(in_srgb,var(--bg-primary)_80%,var(--bg-tertiary))] ${
        selected
          ? 'border-[var(--accent)] shadow-[0_0_0_1px_var(--accent),0_12px_34px_rgba(0,0,0,0.08)]'
          : 'border-[color:color-mix(in_srgb,var(--border)_76%,transparent)]'
      } ${compact ? 'min-h-[92px]' : 'min-h-[174px]'}`}
      aria-label={`Open ${item.title} prompt detail`}
    >
      <div className={`flex ${compact ? 'items-center' : 'items-start'} gap-4`}>
        <div className="mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px] bg-[color:color-mix(in_srgb,var(--bg-tertiary)_76%,transparent)] text-[var(--text-secondary)]">
          <Bookmark className="h-[17px] w-[17px]" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="truncate text-[14px] font-semibold leading-5 tracking-[-0.01em] text-[var(--text-primary)]">
                {item.title}
              </h3>
              <div className="mt-1 text-[12px] text-[var(--text-secondary)]">
                {formatRelativeTime(item.updatedAt)}
              </div>
            </div>
            <CategoryPill category={category} color={color} />
          </div>

          <p className={`${compact ? 'mt-1 line-clamp-1 max-w-3xl' : 'mt-5 line-clamp-3'} text-[13px] leading-5 text-[var(--text-secondary)]`}>
            {item.description || item.content}
          </p>

          <div className={`${compact ? 'mt-2' : 'absolute bottom-4 left-[68px] right-4'} flex items-end justify-between gap-3`}>
            <div className="flex min-w-0 flex-wrap gap-1.5">
              {item.tags.slice(0, compact ? 5 : 3).map((tag) => (
                <span
                  key={tag}
                  className="max-w-[115px] truncate rounded-[6px] bg-[color:color-mix(in_srgb,var(--bg-tertiary)_84%,transparent)] px-2 py-0.5 text-[11px] leading-4 text-[var(--text-muted)]"
                  title={tag}
                >
                  {tag}
                </span>
              ))}
            </div>

            <div className="flex flex-shrink-0 items-center gap-1 opacity-80 transition-opacity group-hover:opacity-100">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onCopy();
                }}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                aria-label={`Copy ${item.title}`}
                title="Copy"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onSelect();
                }}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                aria-label={`More actions for ${item.title}`}
                title="More"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

function PromptDetailDialog({
  open,
  onOpenChange,
  item,
  onCopy,
  onEdit,
  onDelete,
  onUsePrompt,
  onCategoryClick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: PromptLibraryItem | null;
  onCopy: (item: PromptLibraryItem) => void;
  onEdit: (item: PromptLibraryItem) => void;
  onDelete: (item: PromptLibraryItem) => void;
  onUsePrompt: (item: PromptLibraryItem) => void;
  onCategoryClick: (category: string) => void;
}) {
  const category = item ? getPromptCategory(item) : '';
  const color = item ? getTagColor(category) : '';

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/25 backdrop-blur-[1.5px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[81] flex max-h-[82vh] w-[min(620px,calc(100vw-48px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-[16px] border border-[color:color-mix(in_srgb,var(--border)_78%,transparent)] bg-[color:color-mix(in_srgb,var(--bg-primary)_94%,var(--bg-secondary))] shadow-[0_24px_80px_rgba(0,0,0,0.2)] outline-none">
          {!item ? (
            <div className="flex min-h-[320px] items-center justify-center p-6 text-[14px] leading-7 text-[var(--text-muted)]">
              Select a prompt card to inspect its content.
            </div>
          ) : (
            <>
              <div className="border-b border-[color:color-mix(in_srgb,var(--border)_58%,transparent)] px-7 pb-5 pt-6">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <Dialog.Title className="break-words text-[18px] font-semibold leading-6 tracking-[-0.02em] text-[var(--text-primary)]">
                      {item.title}
                    </Dialog.Title>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-[var(--text-muted)]">
                      <span>Last updated {formatRelativeTime(item.updatedAt)}</span>
                      <span>•</span>
                      <span>Category:</span>
                      <CategoryPill category={category} color={color} />
                    </div>
                  </div>

                  <Dialog.Close asChild>
                    <button
                      type="button"
                      className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[9px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                      aria-label="Close prompt detail"
                      title="Close"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </Dialog.Close>
                </div>

                {item.tags.length > 0 && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {item.tags.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => onCategoryClick(tag)}
                        className="rounded-[7px] bg-[color:color-mix(in_srgb,var(--bg-tertiary)_78%,transparent)] px-2 py-1 text-[12px] leading-4 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-7 py-5">
                {item.description && (
                  <p className="mb-5 text-[14px] leading-6 text-[var(--text-secondary)]">
                    {item.description}
                  </p>
                )}

                <div className="mb-2 text-[13px] font-medium text-[var(--text-primary)]">Prompt</div>
                <pre className="max-h-[300px] overflow-auto whitespace-pre-wrap break-words rounded-[10px] border border-[color:color-mix(in_srgb,var(--border)_78%,transparent)] bg-[color:color-mix(in_srgb,var(--bg-primary)_78%,var(--bg-secondary))] p-4 font-mono text-[12px] leading-5 text-[var(--text-primary)]">
                  {item.content}
                </pre>
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-[color:color-mix(in_srgb,var(--border)_52%,transparent)] px-7 py-4">
                <div className="flex items-center gap-2">
                  <DialogActionButton onClick={() => onCopy(item)}>
                    <Copy className="h-4 w-4" />
                    <span>Copy</span>
                  </DialogActionButton>
                  <DialogActionButton onClick={() => onEdit(item)}>
                    <Pencil className="h-4 w-4" />
                    <span>Edit</span>
                  </DialogActionButton>
                  <DialogActionButton tone="danger" onClick={() => onDelete(item)}>
                    <Trash2 className="h-4 w-4" />
                    <span>Delete</span>
                  </DialogActionButton>
                </div>

                <button
                  type="button"
                  onClick={() => onUsePrompt(item)}
                  className="inline-flex h-10 items-center justify-center rounded-[10px] bg-[var(--accent)] px-4 text-[14px] font-medium text-[var(--accent-foreground)] shadow-[0_1px_2px_rgba(0,0,0,0.12)] transition-colors hover:bg-[var(--accent-hover)]"
                >
                  Use Prompt
                </button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function EmptyPromptState({
  hasItems,
  hasFilters,
  onCreate,
  onClearFilters,
}: {
  hasItems: boolean;
  hasFilters: boolean;
  onCreate: () => void;
  onClearFilters: () => void;
}) {
  return (
    <div className="flex min-h-[320px] flex-col items-center justify-center rounded-[16px] border border-dashed border-[color:color-mix(in_srgb,var(--border)_78%,transparent)] bg-[color:color-mix(in_srgb,var(--bg-primary)_66%,transparent)] px-6 py-10 text-center">
      <Bookmark className="mb-4 h-10 w-10 text-[var(--text-muted)]" strokeWidth={1.5} />
      <div className="text-sm text-[var(--text-secondary)]">
        {hasItems ? 'No prompts match your filters.' : 'No prompts saved yet.'}
      </div>
      <button
        type="button"
        onClick={hasFilters ? onClearFilters : onCreate}
        className="mt-4 inline-flex items-center gap-1.5 rounded-[10px] border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-tertiary)]"
      >
        {hasFilters ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
        <span>{hasFilters ? 'Clear filters' : 'Create your first prompt'}</span>
      </button>
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
      className="flex h-10 w-10 items-center justify-center rounded-[10px] border border-[color:color-mix(in_srgb,var(--border)_78%,transparent)] bg-[color:color-mix(in_srgb,var(--bg-primary)_66%,transparent)] text-[var(--text-secondary)] shadow-[0_1px_1px_rgba(0,0,0,0.04)] transition-colors hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function ViewModeButton({
  active,
  children,
  onClick,
  title,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-[8px] transition-colors ${
        active
          ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)] shadow-[0_1px_1px_rgba(0,0,0,0.05)]'
          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
      }`}
    >
      {children}
    </button>
  );
}

function DialogActionButton({
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
      className={`inline-flex h-9 items-center gap-2 rounded-[9px] border px-3 text-[13px] transition-colors ${
        tone === 'danger'
          ? 'border-transparent text-[#dc2626] hover:bg-[#dc2626]/10'
          : 'border-[color:color-mix(in_srgb,var(--border)_72%,transparent)] bg-[color:color-mix(in_srgb,var(--bg-primary)_72%,transparent)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
      }`}
    >
      {children}
    </button>
  );
}

function CategoryPill({ category, color }: { category: string; color: string }) {
  return (
    <span
      className="inline-flex max-w-[140px] items-center rounded-[6px] px-2 py-0.5 text-[11px] font-medium leading-4"
      style={{
        color,
        backgroundColor: `color-mix(in srgb, ${color} 15%, transparent)`,
      }}
      title={category}
    >
      <span className="truncate">{category}</span>
    </span>
  );
}
