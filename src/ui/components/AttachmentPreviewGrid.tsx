import { useEffect, useMemo, useState } from 'react';
import type { Attachment } from '../types';

export function AttachmentPreviewGrid({ attachments }: { attachments: Attachment[] }) {
  const imageAttachments = useMemo(
    () => attachments.filter((a) => a.kind === 'image'),
    [attachments]
  );

  const [previews, setPreviews] = useState<Record<string, string | null>>({});

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

  if (imageAttachments.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap justify-end gap-2">
      {imageAttachments.map((a) => {
        const preview = previews[a.id] || undefined;
        return (
          <div
            key={a.id}
            className="w-40 h-40 rounded-xl overflow-hidden border border-[var(--border)] bg-white shadow-sm"
            title={a.path}
          >
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
              <div className="w-full h-full bg-[var(--bg-tertiary)]" />
            )}
          </div>
        );
      })}
    </div>
  );
}
