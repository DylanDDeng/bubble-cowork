import { useEffect, useMemo, useState } from 'react';
import type { Attachment, SessionView } from '../types';
import { collectSessionSources, mergeSessionSources } from '../../shared/session-sources';
import { loadSessionSources } from '../utils/session-source-client';

export function useSessionSources(session: SessionView | null) {
  const sessionId = session?.id ?? null;
  const [history, setHistory] = useState<{ sessionId: string; sources: Attachment[]; error: string | null } | null>(null);
  const [revision, setRevision] = useState(0);
  const local = useMemo(() => collectSessionSources(session?.messages ?? []), [session?.messages]);
  const localKey = JSON.stringify(local.map(source => source.path));
  useEffect(() => {
    if (!sessionId || !session || session.isDraft) return;
    let cancelled = false;
    const controller = new AbortController();
    void loadSessionSources(session, window.electron, controller.signal).then(sources => {
      if (!cancelled) setHistory({ sessionId, sources, error: null });
    }).catch(() => {
      if (!cancelled) setHistory({ sessionId, sources: [], error: 'Could not load earlier attachments.' });
    });
    return () => { cancelled = true; controller.abort(); };
  }, [sessionId, session?.isDraft, session?.historyCursor, session?.hasMoreHistory, localKey, revision]);
  const current = history?.sessionId === sessionId ? history : null;
  return {
    sources: useMemo(() => mergeSessionSources(current?.sources ?? [], local), [current, local]),
    loading: Boolean(sessionId && !session?.isDraft && !current),
    error: current?.error ?? null,
    refresh: () => setRevision(value => value + 1),
  };
}
