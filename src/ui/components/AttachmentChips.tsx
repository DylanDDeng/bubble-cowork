import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import type { Attachment } from '../types';
import { FileTypeIcon } from './FileTypeIcon';

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

function normalizePreviewText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function PastedTextAttachmentCard({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove?: (attachmentId: string) => void;
}) {
  const previewText = normalizePreviewText(attachment.previewText || '');

  return (
    <div
      className="relative w-[128px] rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] p-3 shadow-sm"
      title={attachment.path}
    >
      <div
        className="overflow-hidden text-[10px] leading-[1.45] text-[var(--text-secondary)]"
        style={{
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: 5,
          minHeight: '72px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {previewText}
      </div>

      <div className="mt-2 inline-flex rounded-md border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-secondary)]">
        PASTED
      </div>

      {onRemove && (
        <button
          onClick={() => onRemove(attachment.id)}
          className="absolute right-2 top-2 rounded p-1 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-secondary)]"
          title="Remove"
          aria-label="Remove attachment"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
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
        if (a.uiType === 'pasted_text' && a.previewText) {
          return <PastedTextAttachmentCard key={a.id} attachment={a} onRemove={onRemove} />;
        }

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
              <div className="w-8 h-8 rounded-md border border-[var(--border)] bg-white flex-shrink-0 flex items-center justify-center">
                <FileTypeIcon
                  name={a.name}
                  className="h-5 w-5"
                  fallbackClassName="h-4.5 w-4.5 text-[var(--text-muted)]"
                />
              </div>
            )}

            <div className="min-w-0">
              <div className="text-xs text-[var(--text-primary)] truncate max-w-[180px]">
                {a.name}
              </div>
              <div className="text-[10px] text-[var(--text-muted)]">{formatBytes(a.size)}</div>
            </div>

            {onRemove && (
              <button
                onClick={() => onRemove(a.id)}
                className="ml-1 p-1 rounded hover:bg-[var(--border)] transition-colors"
                title="Remove"
                aria-label="Remove attachment"
              >
                <X className="w-3.5 h-3.5 text-[var(--text-muted)]" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
