import { useMemo } from 'react';
import { Mic, Plus, Trash2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';

function formatUpdatedAt(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

export function PodcastSidebarPanel() {
  const {
    podcastDrafts,
    activePodcastDraftId,
    createPodcastDraft,
    setActivePodcastDraft,
    deletePodcastDraft,
  } = useAppStore();

  const drafts = useMemo(
    () => Object.values(podcastDrafts).sort((left, right) => right.updatedAt - left.updatedAt),
    [podcastDrafts]
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
      <div className="flex items-center justify-between gap-2 px-1 pb-3 pt-4">
        <div>
          <div className="text-base font-semibold text-[var(--text-primary)]">Podcast Studio</div>
          <div className="text-xs text-[var(--text-muted)]">Turn sources into scripted episodes.</div>
        </div>

        <button
          type="button"
          onClick={() => createPodcastDraft()}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          title="New episode"
          aria-label="New episode"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1">
        {drafts.length === 0 ? (
          <button
            type="button"
            onClick={() => createPodcastDraft()}
            className="w-full rounded-[18px] border border-dashed border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-8 text-left text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
          >
            Create your first episode draft. Add a YouTube video, files, or links and turn them into a podcast workflow.
          </button>
        ) : (
          <div className="space-y-3 pb-2">
            {drafts.map((draft) => {
              const active = draft.id === activePodcastDraftId;

              return (
                <div
                  key={draft.id}
                  className={`rounded-[18px] border p-3 transition-colors ${
                    active
                      ? 'border-[var(--sidebar-item-border)] bg-[var(--sidebar-item-active)]'
                      : 'border-[var(--border)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)]'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setActivePodcastDraft(draft.id)}
                    className="flex w-full items-start gap-3 text-left"
                  >
                    <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] text-[var(--text-secondary)]">
                      <Mic className="h-4 w-4" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-[var(--text-primary)]">{draft.title}</div>
                      <div className="mt-1 text-xs text-[var(--text-muted)]">
                        {draft.sources.length} source{draft.sources.length === 1 ? '' : 's'} · Updated {formatUpdatedAt(draft.updatedAt)}
                      </div>
                    </div>
                  </button>

                  <div className="mt-3 flex justify-end">
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(`Delete “${draft.title}”?`)) {
                          deletePodcastDraft(draft.id);
                        }
                      }}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-primary)] hover:text-[var(--text-primary)]"
                      title="Delete draft"
                      aria-label="Delete draft"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
