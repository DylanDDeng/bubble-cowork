import { useMemo } from 'react';
import { Monitor } from '../icons';
import { sendEvent } from '../../hooks/useIPC';
import {
  environmentHasComputerUseSection,
  formatComputerUseScreenshotFileName,
} from '../../../shared/computer-use';
import type { SessionView } from '../../types';
import { FileTypeIcon } from '../FileTypeIcon';

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
  const shots = useMemo(() => frames.filter((frame) => frame.media), [frames]);

  if (!sessionId || (shots.length === 0 && grants.length === 0)) return null;

  const openShot = (sha256: string | null) => {
    if (previewOpen) {
      if (sha256) void window.electron.setComputerUsePreviewParked(sha256);
      return;
    }
    void window.electron.openComputerUsePreview({
      sessionId,
      parkedSha256: sha256,
      live: session?.computerUseLive || shots.at(-1) || null,
      frames,
      grants,
    });
  };

  const popOut = () => {
    if (previewOpen) {
      void window.electron.closeComputerUsePreview();
      return;
    }
    openShot(shots.at(-1)?.media?.sha256 || null);
  };

  return (
    <section className="space-y-1 border-t border-[var(--border)] px-3 py-3">
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
      {shots.length > 0 ? (
        shots.map((frame, index) => {
          const sha = frame.media?.sha256 || null;
          const fileName = formatComputerUseScreenshotFileName({
            app: frame.app,
            mimeType: frame.media?.mimeType,
            index: index + 1,
          });
          return (
            <button
              key={sha || frame.toolUseId}
              type="button"
              title={frame.label}
              onClick={() => openShot(sha)}
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] text-[var(--text-primary)] transition-colors hover:bg-[var(--sidebar-item-hover)]"
            >
              <FileTypeIcon name={fileName} className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{fileName}</span>
              {frame.label ? (
                <span className="max-w-[120px] truncate text-[11px] text-[var(--text-muted)]">{frame.label}</span>
              ) : null}
            </button>
          );
        })
      ) : (
        <div className="px-2 text-[11px] leading-5 text-[var(--text-muted)]">No screenshots yet.</div>
      )}
    </section>
  );
}
