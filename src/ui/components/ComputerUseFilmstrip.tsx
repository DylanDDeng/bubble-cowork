import { useEffect, useMemo, useState } from 'react';
import type { ComputerUseLiveFrame } from '../../shared/computer-use';

export function useComputerUseFramePreviews(frames: ComputerUseLiveFrame[]) {
  const shots = useMemo(() => frames.filter((frame) => frame.media), [frames]);
  const [previews, setPreviews] = useState<Record<string, string | null>>({});

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

  return { shots, previews };
}

export function ComputerUseFilmstrip({
  frames,
  selectedSha,
  onSelect,
}: {
  frames: ComputerUseLiveFrame[];
  selectedSha: string | null;
  onSelect: (sha256: string | null) => void;
}) {
  const { shots, previews } = useComputerUseFramePreviews(frames);
  if (shots.length === 0) return null;

  return (
    <div className="scrollbar-slim flex gap-1.5 overflow-x-auto">
      {shots.map((frame) => {
        const sha = frame.media?.sha256 || frame.toolUseId;
        const active = selectedSha === frame.media?.sha256;
        return (
          <button
            key={sha}
            type="button"
            title={frame.label}
            onClick={() => onSelect(frame.media?.sha256 || null)}
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
  );
}

export function ComputerUseSelectedFrame({
  frame,
  preview,
  tall,
}: {
  frame: ComputerUseLiveFrame;
  preview: string | null;
  tall?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]">
      {preview ? (
        <img
          src={preview}
          alt=""
          className={`w-full object-contain ${tall ? 'max-h-[min(420px,calc(100vh-220px))]' : 'max-h-40'}`}
        />
      ) : (
        <div className="px-3 py-6 text-center text-[11px] text-[var(--text-muted)]">
          {tall ? 'Waiting for a screenshot' : 'Loading screenshot…'}
        </div>
      )}
      <div className="truncate px-2 py-1.5 text-[11px] text-[var(--text-secondary)]">{frame.label}</div>
    </div>
  );
}
