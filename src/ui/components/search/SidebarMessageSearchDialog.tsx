import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { LoaderCircle, MessageSquareText, Search, X } from 'lucide-react';
import { useDebounce } from '../../hooks/useDebounce';
import { useAppStore } from '../../store/useAppStore';
import type { ChatMessageSearchResult } from '../../types';

function formatMessageTypeLabel(type: ChatMessageSearchResult['messageType']): string {
  if (type === 'user_prompt') {
    return 'Prompt';
  }
  if (type === 'assistant') {
    return 'Assistant';
  }
  return 'User';
}

function HighlightedSnippet({ text, query }: { text: string; query: string }) {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return <>{text}</>;
  }

  const lowerText = text.toLowerCase();
  const lowerQuery = normalizedQuery.toLowerCase();
  const segments: Array<{ text: string; match: boolean }> = [];
  let cursor = 0;

  while (cursor < text.length) {
    const matchIndex = lowerText.indexOf(lowerQuery, cursor);
    if (matchIndex === -1) {
      segments.push({ text: text.slice(cursor), match: false });
      break;
    }

    if (matchIndex > cursor) {
      segments.push({ text: text.slice(cursor, matchIndex), match: false });
    }

    segments.push({
      text: text.slice(matchIndex, matchIndex + normalizedQuery.length),
      match: true,
    });
    cursor = matchIndex + normalizedQuery.length;
  }

  return (
    <>
      {segments.map((segment, index) =>
        segment.match ? (
          <mark
            key={`${segment.text}-${index}`}
            className="rounded-[4px] bg-[var(--tree-file-accent-fg)]/14 px-0.5 text-[var(--text-primary)]"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={`${segment.text}-${index}`}>{segment.text}</span>
        )
      )}
    </>
  );
}

export function SidebarMessageSearchDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { setActiveSession, setShowNewSession, setShowSettings } = useAppStore();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ChatMessageSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const debouncedQuery = useDebounce(query, 180);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setLoading(false);
      return;
    }

    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 10);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    let cancelled = false;

    if (!debouncedQuery.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    window.electron
      .searchChatMessages(debouncedQuery, 80)
      .then((nextResults) => {
        if (!cancelled) {
          setResults(nextResults);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error('Failed to search chat messages:', error);
          setResults([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  const summary = useMemo(() => {
    if (!debouncedQuery.trim()) {
      return 'Search your sent messages';
    }
    if (loading) {
      return 'Searching messages...';
    }
    return `${results.length} result${results.length === 1 ? '' : 's'}`;
  }, [debouncedQuery, loading, results.length]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[90] bg-[rgba(15,23,42,0.18)] backdrop-blur-[1px]" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[100] w-[min(680px,calc(100vw-96px))] -translate-x-1/2 -translate-y-1/2 rounded-[20px] border border-[var(--border)] bg-[var(--bg-secondary)] p-0 shadow-[0_24px_60px_rgba(15,23,42,0.18)]">
          <div className="border-b border-[var(--border)] px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[15px] font-semibold text-[var(--text-primary)]">
                  <MessageSquareText className="h-4.5 w-4.5 text-[var(--text-secondary)]" />
                  <Dialog.Title>Search Messages</Dialog.Title>
                </div>
                <Dialog.Description className="mt-1 text-sm text-[var(--text-secondary)]">
                  {summary}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="flex h-8 w-8 items-center justify-center rounded-[10px] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                  aria-label="Close search"
                >
                  <X className="h-4 w-4" />
                </button>
              </Dialog.Close>
            </div>

            <div className="relative mt-4">
              <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]">
                {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              </div>
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search chat messages..."
                className="h-11 w-full rounded-[14px] border border-[var(--border)] bg-[var(--bg-primary)] pl-10 pr-10 text-sm text-[var(--text-primary)] outline-none transition-colors placeholder:text-[var(--text-muted)] focus:border-[var(--accent)]"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-[10px] p-1.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          </div>

          <div className="max-h-[min(70vh,720px)] overflow-y-auto px-3 py-3">
            {!debouncedQuery.trim() ? (
              <div className="flex flex-col items-center justify-center rounded-[16px] border border-dashed border-[var(--border)] bg-[var(--bg-primary)] px-6 py-12 text-center">
                <Search className="mb-3 h-5 w-5 text-[var(--text-muted)]" />
                <div className="text-sm font-medium text-[var(--text-primary)]">
                  Search across your sent prompts
                </div>
                <div className="mt-1 max-w-[420px] text-sm leading-6 text-[var(--text-secondary)]">
                  Search only the messages you sent, then open the matching thread from the results list.
                </div>
              </div>
            ) : results.length === 0 && !loading ? (
              <div className="rounded-[16px] border border-dashed border-[var(--border)] bg-[var(--bg-primary)] px-6 py-10 text-center text-sm text-[var(--text-secondary)]">
                No matching messages found.
              </div>
            ) : (
              <div className="space-y-2">
                {results.map((result, index) => (
                  <button
                    key={`${result.sessionId}-${result.createdAt}-${index}`}
                    type="button"
                    onClick={() => {
                      setShowSettings(false);
                      setShowNewSession(false);
                      setActiveSession(result.sessionId);
                      onOpenChange(false);
                    }}
                    className="w-full rounded-[16px] border border-[var(--border)] bg-[var(--bg-primary)] px-4 py-3 text-left transition-colors hover:border-[var(--accent)]/30 hover:bg-[var(--bg-tertiary)]/45"
                  >
                    <div className="flex items-center gap-2">
                      <div className="truncate text-sm font-medium text-[var(--text-primary)]">
                        {result.sessionTitle}
                      </div>
                      <span className="rounded-full bg-[var(--bg-tertiary)] px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">
                        {formatMessageTypeLabel(result.messageType)}
                      </span>
                    </div>
                    <div className="mt-2 text-sm leading-6 text-[var(--text-secondary)]">
                      <HighlightedSnippet text={result.snippet} query={debouncedQuery} />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
