import { useEffect, useMemo, useState } from 'react';
import { Monitor } from '../icons';
import { sendEvent } from '../../hooks/useIPC';
import { environmentHasComputerUseSection, type ComputerUseLiveFrame } from '../../../shared/computer-use';
import type { SessionView } from '../../types';

export { environmentHasComputerUseSection };

export function EnvironmentComputerUseSection({
  session,
  sessionId,
}: {
  session: SessionView | null;
  sessionId: string | null;
}) {
  const frames = session?.computerUseFrames || [];
  const grants = session?.computerUseGrants || [];
  const shots = useMemo(() => frames.filter((frame) => frame.media), [frames]);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string | null>>({});

  const latestSha = shots.at(-1)?.media?.sha256 || null;
  const selected = useMemo(() => {
    const sha = selectedSha || latestSha;
    return shots.find((frame) => frame.media?.sha256 === sha) || shots.at(-1) || null;
  }, [latestSha, selectedSha, shots]);

  useEffect(() => {
    if (selectedSha && !shots.some((frame) => frame.media?.sha256 === selectedSha)) {
      setSelectedSha(null);
    }
  }, [selectedSha, shots]);

  useEffect(() => {
    let cancelled = false;
    const refs = shots
      .map((frame) => frame.media)
      .filter((media): media is NonNullable<ComputerUseLiveFrame['media']> => Boolean(media));
    if (refs.length === 0) {
      setPreviews({});
      return;
    }
    void Promise.all(
      refs.map(async (ref) => {
        try {
          const dataUrl = await window.electron.readComputerUseArtifact(ref.sessionId, ref.sha256);
          return [ref.sha256, dataUrl] as const;
        } catch {
          return [ref.sha256, null] as const;
        }
      })
    ).then((entries) => {
      if (!cancelled) setPreviews(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [shots]);

  if (!sessionId || (shots.length === 0 && grants.length === 0)) return null;

  return (
    <section className="space-y-2 border-t border-[var(--border)] px-3 py-3">
      <div className="flex items-center gap-1.5 px-2 text-[11px] font-medium text-[var(--text-muted)]">
        <Monitor className="h-3 w-3" />
        <span>Computer Use</span>
        {shots.length > 0 ? <span>· {shots.length}</span> : null}
      </div>
      {grants.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 px-2 text-[11px] text-[var(--text-secondary)]">
          <span className="min-w-0 flex-1 truncate">
            Allowed until revoked · {grants.map((grant) => grant.app).join(', ')}
          </span>
          <button
            type="button"
            onClick={() => sendEvent({ type: 'computerUse.revoke', payload: { sessionId } })}
            className="shrink-0 font-medium text-amber-700 hover:underline"
          >
            Revoke
          </button>
        </div>
      ) : null}
      {selected ? <ComputerUseSelectedFrame frame={selected} preview={previews[selected.media?.sha256 || ''] || null} /> : null}
      {shots.length > 0 ? (
        <div className="scrollbar-slim flex gap-1.5 overflow-x-auto px-2">
          {shots.map((frame) => {
            const sha = frame.media?.sha256 || frame.toolUseId;
            const active = selected?.media?.sha256 === frame.media?.sha256;
            return (
              <button
                key={sha}
                type="button"
                title={frame.label}
                onClick={() => setSelectedSha(frame.media?.sha256 || null)}
                className={`h-14 w-[72px] shrink-0 overflow-hidden rounded-md border bg-[var(--bg-secondary)] ${
                  active
                    ? 'border-[var(--text-primary)]'
                    : 'border-[var(--border)] hover:border-[var(--text-muted)]'
                }`}
              >
                {previews[sha] ? (
                  <img src={previews[sha] || ''} alt="" className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full items-center justify-center px-1 text-[9px] leading-tight text-[var(--text-muted)]">
                    {frame.tool || 'shot'}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="px-2 text-[11px] leading-5 text-[var(--text-muted)]">No screenshots yet.</div>
      )}
    </section>
  );
}

function ComputerUseSelectedFrame({
  frame,
  preview,
}: {
  frame: ComputerUseLiveFrame;
  preview: string | null;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]">
      {preview ? (
        <img src={preview} alt="" className="max-h-40 w-full object-contain" />
      ) : (
        <div className="px-3 py-6 text-center text-[11px] text-[var(--text-muted)]">Loading screenshot…</div>
      )}
      <div className="truncate px-2 py-1.5 text-[11px] text-[var(--text-secondary)]">{frame.label}</div>
    </div>
  );
}

