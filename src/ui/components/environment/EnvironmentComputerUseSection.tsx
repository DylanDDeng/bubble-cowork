import { useEffect, useMemo, useState } from 'react';
import { Monitor } from '../icons';
import { sendEvent } from '../../hooks/useIPC';
import { environmentHasComputerUseSection } from '../../../shared/computer-use';
import type { SessionView } from '../../types';
import { ComputerUseFilmstrip, ComputerUseSelectedFrame, useComputerUseFramePreviews } from '../ComputerUseFilmstrip';

export { environmentHasComputerUseSection };

export function EnvironmentComputerUseSection({
  session,
  sessionId,
  previewOpen,
}: {
  session: SessionView | null;
  sessionId: string | null;
  previewOpen: boolean;
}) {
  const frames = session?.computerUseFrames || [];
  const grants = session?.computerUseGrants || [];
  const { shots, previews } = useComputerUseFramePreviews(frames);
  const [selectedSha, setSelectedSha] = useState<string | null>(null);

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

  if (!sessionId || (shots.length === 0 && grants.length === 0)) return null;

  const popOut = () => {
    if (previewOpen) {
      void window.electron.closeComputerUsePreview();
      return;
    }
    void window.electron.openComputerUsePreview({
      sessionId,
      parkedSha256: selected?.media?.sha256 || null,
      live: session?.computerUseLive || selected,
      frames,
      grants,
    });
  };

  return (
    <section className="space-y-2 border-t border-[var(--border)] px-3 py-3">
      <div className="flex items-center gap-1.5 px-2 text-[11px] font-medium text-[var(--text-muted)]">
        <Monitor className="h-3 w-3" />
        <span>Computer Use</span>
        {shots.length > 0 ? <span>· {shots.length}</span> : null}
        <button
          type="button"
          onClick={popOut}
          className="ml-auto text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          {previewOpen ? 'Dock' : 'Pop out'}
        </button>
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
      {selected ? (
        <ComputerUseSelectedFrame frame={selected} preview={previews[selected.media?.sha256 || ''] || null} />
      ) : null}
      {shots.length > 0 ? (
        <div className="px-2">
          <ComputerUseFilmstrip
            frames={frames}
            selectedSha={selected?.media?.sha256 || null}
            onSelect={setSelectedSha}
          />
        </div>
      ) : (
        <div className="px-2 text-[11px] leading-5 text-[var(--text-muted)]">No screenshots yet.</div>
      )}
    </section>
  );
}
