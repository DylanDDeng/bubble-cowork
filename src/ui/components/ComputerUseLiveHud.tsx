import { useEffect, useMemo, useState } from 'react';
import { Monitor, X } from './icons';
import { sendEvent } from '../hooks/useIPC';
import type { ComputerUseGrantView, ComputerUseLiveFrame } from '../../shared/computer-use';

export function ComputerUseGrantBadge({
  sessionId,
  grants,
}: {
  sessionId: string;
  grants: ComputerUseGrantView[];
}) {
  if (grants.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700">
      <span className="font-medium">Computer Use allowed until revoked</span>
      {grants.map((grant) => (
        <span key={grant.key} className="rounded bg-[var(--bg-primary)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-primary)]">
          {grant.tool} · {grant.app}
        </span>
      ))}
      <button
        type="button"
        onClick={() => sendEvent({ type: 'computerUse.revoke', payload: { sessionId } })}
        className="ml-auto text-[11px] font-medium uppercase tracking-[0.08em] text-amber-800 hover:underline"
      >
        Revoke
      </button>
    </div>
  );
}

export function ComputerUseLiveHud({
  sessionId,
  frame,
  frames,
  grants,
  isForeground,
  detached,
}: {
  sessionId: string;
  frame: ComputerUseLiveFrame | null;
  frames: ComputerUseLiveFrame[];
  grants: ComputerUseGrantView[];
  isForeground: boolean;
  detached: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [parkedSha256, setParkedSha256] = useState<string | null>(null);
  const [unseen, setUnseen] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);

  const latestSha = frame?.media?.sha256 || null;
  useEffect(() => {
    if (!isForeground) return;
    if (frame) setOpen(true);
  }, [frame?.at, isForeground]);

  useEffect(() => {
    if (parkedSha256 && latestSha && parkedSha256 !== latestSha && frame?.hasFreshMedia) {
      setUnseen((count) => count + 1);
    }
  }, [latestSha, parkedSha256, frame?.hasFreshMedia]);

  const shown = useMemo(() => {
    if (parkedSha256) {
      return frames.find((item) => item.media?.sha256 === parkedSha256) || frame;
    }
    return frame;
  }, [frame, frames, parkedSha256]);

  useEffect(() => {
    let cancelled = false;
    const media = shown?.media;
    if (!media) {
      setPreview(null);
      return;
    }
    void window.electron.readComputerUseArtifact(media.sessionId, media.sha256).then((dataUrl) => {
      if (!cancelled) setPreview(dataUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [shown?.media?.sessionId, shown?.media?.sha256]);

  const popOut = () => {
    void window.electron.openComputerUsePreview({
      sessionId,
      parkedSha256,
      live: frame,
      frames,
      grants,
    });
  };

  if (!isForeground || (!open && !pinned && !detached) || (!shown && !detached)) return null;

  if (detached) {
    return (
      <div className="pointer-events-none absolute bottom-3 right-3 z-20">
        <div className="pointer-events-auto flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-2 text-[12px] shadow-[0_16px_40px_rgba(15,23,42,0.16)]">
          <Monitor className="h-3.5 w-3.5 text-[var(--text-muted)]" />
          <span className="text-[var(--text-secondary)]">Preview popped out</span>
          <button
            type="button"
            onClick={() => void window.electron.closeComputerUsePreview()}
            className="text-[11px] font-medium text-[var(--text-primary)]"
          >
            Dock
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute bottom-3 right-3 z-20">
      <div className="pointer-events-auto w-[320px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] shadow-[0_16px_40px_rgba(15,23,42,0.16)]">
        <div className="flex items-center gap-2 px-3 py-2">
          <Monitor className="h-3.5 w-3.5 text-[var(--text-muted)]" />
          <div className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-primary)]">{shown?.label}</div>
          <button type="button" onClick={popOut} className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
            Pop out
          </button>
          <button type="button" onClick={() => setPinned((value) => !value)} className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-muted)]">
            {pinned ? 'Pinned' : 'Pin'}
          </button>
          <button type="button" onClick={() => { setOpen(false); setPinned(false); }} className="text-[var(--text-muted)]">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {preview ? (
          <img src={preview} alt="" className="max-h-44 w-full object-contain bg-[var(--bg-secondary)]" />
        ) : (
          <div className="px-3 py-6 text-center text-[11px] text-[var(--text-muted)]">Waiting for a screenshot</div>
        )}
        {unseen > 0 && parkedSha256 ? (
          <button
            type="button"
            onClick={() => {
              setParkedSha256(null);
              setUnseen(0);
            }}
            className="w-full border-t border-[var(--border)] px-3 py-1.5 text-[11px] text-[var(--text-primary)]"
          >
            Show latest ({unseen})
          </button>
        ) : null}
        {grants.length > 0 ? (
          <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] px-3 py-2 text-[11px]">
            <span className="truncate text-[var(--text-secondary)]">
              Allowed until revoked · {grants.map((grant) => grant.app).join(', ')}
            </span>
            <button
              type="button"
              onClick={() => sendEvent({ type: 'computerUse.revoke', payload: { sessionId } })}
              className="font-medium text-amber-700"
            >
              Revoke
            </button>
          </div>
        ) : null}
        <div className="flex justify-end gap-2 border-t border-[var(--border)] px-3 py-2">
          <button
            type="button"
            onClick={() => sendEvent({ type: 'session.stop', payload: { sessionId } })}
            className="rounded-md bg-[var(--text-primary)] px-2 py-1 text-[11px] font-medium text-[var(--bg-primary)]"
          >
            Stop Computer Use
          </button>
        </div>
      </div>
    </div>
  );
}
