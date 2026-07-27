import { useEffect, useMemo, useState } from 'react';
import { FileText, X } from './icons';
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

const PASTED_TEXT_LABEL_MAX_CHARS = 120;

function pastedTextLabel(text: string): string {
  const firstLine =
    text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) || 'Pasted text';

  return firstLine.length > PASTED_TEXT_LABEL_MAX_CHARS
    ? `${firstLine.slice(0, PASTED_TEXT_LABEL_MAX_CHARS)}...`
    : firstLine;
}

/**
 * Composer pasted-text attachment: a compact horizontal chip — icon tile on
 * the left, the pasted text's first line as the title, a "Pasted text"
 * subtitle, and a floating remove badge on the corner.
 */
function PastedTextComposerChip({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove?: (attachmentId: string) => void;
}) {
  const label = pastedTextLabel(attachment.previewText || '');

  return (
    <div
      className="relative inline-flex max-w-[240px] items-center gap-2.5 rounded-2xl border border-[var(--border)] bg-[var(--bg-primary)] py-2 pl-2 pr-3 shadow-sm"
      title={attachment.path}
    >
      <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[10px] bg-[var(--bg-tertiary)]">
        <FileText className="h-4.5 w-4.5 text-[var(--text-secondary)]" />
      </div>

      <div className="min-w-0">
        <div className="truncate text-xs font-medium text-[var(--text-primary)]">{label}</div>
        <div className="text-[10px] text-[var(--text-muted)]">Pasted text</div>
      </div>

      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(attachment.id)}
          className="absolute -right-1.5 -top-1.5 inline-flex h-[18px] w-[18px] items-center justify-center rounded-full bg-[var(--text-primary)] text-[var(--bg-primary)] shadow-[0_1px_4px_rgba(0,0,0,0.28)] transition-opacity hover:opacity-85"
          title="Remove"
          aria-label="Remove attachment"
        >
          <X className="h-2.5 w-2.5" />
        </button>
      )}
    </div>
  );
}

/**
 * Sent-message pasted-text attachment: a single-line pill above the bubble —
 * small icon plus the pasted text's truncated first line.
 */
function PastedTextMessagePill({ attachment }: { attachment: Attachment }) {
  const label = pastedTextLabel(attachment.previewText || '');

  return (
    <div
      className="inline-flex max-w-[320px] items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-tertiary)] px-3 py-1.5"
      title={attachment.path}
    >
      <FileText className="h-3.5 w-3.5 flex-shrink-0 text-[var(--text-muted)]" />
      <span className="truncate text-xs text-[var(--text-secondary)]">{label}</span>
    </div>
  );
}

/**
 * Composer image attachment: a plain square thumbnail with a floating remove
 * badge on its corner — no chip frame, no filename, no size (the picture is
 * the label).
 */
function ImageAttachmentThumb({
  attachment,
  preview,
  onRemove,
  onPreviewError,
}: {
  attachment: Attachment;
  preview?: string;
  onRemove?: (attachmentId: string) => void;
  onPreviewError: () => void;
}) {
  return (
    <div className="relative" title={attachment.path}>
      <div className="h-[84px] w-[84px] overflow-hidden rounded-[12px] border border-[var(--border)] bg-white">
        {preview ? (
          <img
            src={preview}
            className="h-full w-full object-cover"
            alt={attachment.name || 'Image attachment'}
            onError={onPreviewError}
          />
        ) : (
          <div className="h-full w-full bg-[var(--bg-secondary)]" />
        )}
      </div>

      {onRemove && (
        <button
          type="button"
          onClick={() => onRemove(attachment.id)}
          className="absolute right-1 top-1 inline-flex h-[22px] w-[22px] items-center justify-center rounded-full bg-[var(--text-primary)] text-[var(--bg-primary)] shadow-[0_1px_4px_rgba(0,0,0,0.28)] transition-opacity hover:opacity-85"
          title="Remove"
          aria-label="Remove attachment"
        >
          <X className="h-3 w-3" />
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
          return variant === 'message' ? (
            <PastedTextMessagePill key={a.id} attachment={a} />
          ) : (
            <PastedTextComposerChip key={a.id} attachment={a} onRemove={onRemove} />
          );
        }

        const preview = a.kind === 'image' ? previews[a.id] || undefined : undefined;

        if (a.kind === 'image' && variant === 'composer') {
          return (
            <ImageAttachmentThumb
              key={a.id}
              attachment={a}
              preview={preview}
              onRemove={onRemove}
              onPreviewError={() => setPreviews((prev) => ({ ...prev, [a.id]: null }))}
            />
          );
        }

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
