import { useEffect, useMemo, useState } from 'react';
import { Monitor } from './icons';
import { sendEvent } from '../hooks/useIPC';
import { applyThemePreferences, DEFAULT_THEME_STATE, DEFAULT_UI_FONT_FAMILY } from '../theme/themes';
import { ComputerUseFilmstrip, ComputerUseSelectedFrame, useComputerUseFramePreviews } from './ComputerUseFilmstrip';
import type { ComputerUsePreviewSnapshot } from '../../shared/computer-use';

export function ComputerUsePreviewApp() {
  const [snapshot, setSnapshot] = useState<ComputerUsePreviewSnapshot | null>(null);

  useEffect(() => {
    applyThemePreferences({
      themeMode: 'system',
      themeState: DEFAULT_THEME_STATE,
      uiFontFamily: DEFAULT_UI_FONT_FAMILY,
      chatCodeFontFamily: '',
    });
    let cancelled = false;
    void window.electron.getComputerUsePreviewState().then((state) => {
      if (!cancelled) setSnapshot(state);
    });
    const unsubscribe = window.electron.onComputerUsePreviewState((state) => {
      setSnapshot(state);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const frames = snapshot?.frames || [];
  const { previews } = useComputerUseFramePreviews(frames);
  const latestSha = frames.filter((frame) => frame.media).at(-1)?.media?.sha256 || null;
  const selectedSha = snapshot?.parkedSha256 || latestSha;
  const selected = useMemo(
    () => frames.find((frame) => frame.media?.sha256 === selectedSha) || snapshot?.live || null,
    [frames, selectedSha, snapshot?.live]
  );

  if (!snapshot) {
    return (
      <div className="flex h-screen items-center justify-center bg-[var(--bg-primary)] text-[12px] text-[var(--text-muted)]">
        Opening Computer Use…
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <div className="drag-region flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
        <Monitor className="no-drag h-3.5 w-3.5 text-[var(--text-muted)]" />
        <div className="min-w-0 flex-1 truncate text-[12px]">{selected?.label || 'Computer Use'}</div>
        <button
          type="button"
          className="no-drag text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          onClick={() => void window.electron.closeComputerUsePreview()}
        >
          Dock
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-3">
        {selected ? (
          <ComputerUseSelectedFrame
            frame={selected}
            preview={previews[selected.media?.sha256 || ''] || null}
            tall
          />
        ) : (
          <div className="rounded-lg border border-[var(--border)] px-3 py-8 text-center text-[12px] text-[var(--text-muted)]">
            Waiting for a screenshot
          </div>
        )}
        <ComputerUseFilmstrip
          frames={frames}
          selectedSha={selectedSha}
          onSelect={(sha256) => void window.electron.setComputerUsePreviewParked(sha256)}
        />
      </div>
      {snapshot.grants.length > 0 ? (
        <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] px-3 py-2 text-[11px]">
          <span className="truncate text-[var(--text-secondary)]">
            Allowed until revoked · {snapshot.grants.map((grant) => grant.app).join(', ')}
          </span>
          <button
            type="button"
            className="no-drag font-medium text-amber-700"
            onClick={() => sendEvent({ type: 'computerUse.revoke', payload: { sessionId: snapshot.sessionId } })}
          >
            Revoke
          </button>
        </div>
      ) : null}
      <div className="flex justify-end border-t border-[var(--border)] px-3 py-2">
        <button
          type="button"
          className="no-drag rounded-md bg-[var(--text-primary)] px-2 py-1 text-[11px] font-medium text-[var(--bg-primary)]"
          onClick={() => sendEvent({ type: 'session.stop', payload: { sessionId: snapshot.sessionId } })}
        >
          Stop Computer Use
        </button>
      </div>
    </div>
  );
}
