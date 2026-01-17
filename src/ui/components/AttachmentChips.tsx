import { useEffect, useMemo, useState } from 'react';
import type { Attachment } from '../types';

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = unitIndex === 0 ? 0 : value >= 10 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

export function AttachmentChips({
  attachments,
  onRemove,
  variant = 'composer',
}: {
  attachments: Attachment[];
  onRemove?: (attachmentId: string) => void;
  variant?: 'composer' | 'message';
}) {
  const [previews, setPreviews] = useState<Record<string, string | null>>({});

  const imageAttachments = useMemo(
    () => attachments.filter((a) => a.kind === 'image'),
    [attachments]
  );

  useEffect(() => {
    let cancelled = false;

    const missing = imageAttachments.filter(
      (a) => !Object.prototype.hasOwnProperty.call(previews, a.id)
    );
    if (missing.length === 0) {
      return;
    }

    (async () => {
      const entries = await Promise.all(
        missing.map(async (a) => {
          const dataUrl = await window.electron.readAttachmentPreview(a.path);
          return [a.id, dataUrl] as const;
        })
      );

      if (cancelled) return;

      setPreviews((prev) => {
        const next = { ...prev };
        for (const [id, dataUrl] of entries) {
          next[id] = dataUrl;
        }
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [imageAttachments, previews]);

  const chipBg =
    variant === 'composer' ? 'bg-[var(--bg-tertiary)]' : 'bg-[var(--bg-tertiary)]';
  const chipBorder =
    variant === 'composer' ? 'border border-[var(--border)]' : 'border border-[var(--border)]';

  return (
    <div className="flex flex-wrap gap-2">
      {attachments.map((a) => {
        const preview = a.kind === 'image' ? previews[a.id] || undefined : undefined;
        return (
          <div
            key={a.id}
            className={`max-w-full inline-flex items-center gap-2 rounded-lg px-2 py-1 ${chipBg} ${chipBorder}`}
            title={a.path}
          >
            {a.kind === 'image' ? (
              <div className="w-8 h-8 rounded-md overflow-hidden border border-[var(--border)] bg-white flex-shrink-0">
                {preview ? (
                  <img
                    src={preview}
                    className="w-full h-full object-cover"
                    alt=""
                    onError={() => {
                      setPreviews((prev) => ({ ...prev, [a.id]: null }));
                    }}
                  />
                ) : (
                  <div className="w-full h-full bg-[var(--bg-secondary)]" />
                )}
              </div>
            ) : (
              <FileIcon />
            )}

            <div className="min-w-0">
              <div className="text-xs text-[var(--text-primary)] truncate max-w-[180px]">
                {a.name}
              </div>
              <div className="text-[11px] text-[var(--text-muted)]">{formatBytes(a.size)}</div>
            </div>

            {onRemove && (
              <button
                onClick={() => onRemove(a.id)}
                className="ml-1 p-1 rounded hover:bg-[var(--border)] transition-colors"
                title="Remove"
                aria-label="Remove attachment"
              >
                <CloseIcon />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FileIcon() {
  return (
    <svg
      className="w-8 h-8 p-1.5 rounded-md border border-[var(--border)] bg-white text-[var(--text-muted)] flex-shrink-0"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M14 2v6h6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      className="w-3.5 h-3.5 text-[var(--text-muted)]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
