import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { Attachment } from '../types';
import { Download, X } from './icons';
import {
  Dialog,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from './ui/dialog';

export function AttachmentPreviewGrid({ attachments }: { attachments: Attachment[] }) {
  const imageAttachments = useMemo(
    () => attachments.filter((a) => a.kind === 'image'),
    [attachments]
  );

  const [previews, setPreviews] = useState<Record<string, string | null>>({});
  const [selectedAttachmentId, setSelectedAttachmentId] = useState<string | null>(null);

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

  const selectedAttachment = imageAttachments.find((a) => a.id === selectedAttachmentId) ?? null;
  const selectedPreview = selectedAttachment ? previews[selectedAttachment.id] : null;
  const selectedName = selectedAttachment?.name || selectedAttachment?.path.split('/').pop() || 'Image attachment';

  const handleDownload = async () => {
    if (!selectedAttachment || !selectedPreview) return;

    const downloadAttachment = window.electron.downloadAttachment;
    if (typeof downloadAttachment !== 'function') {
      const link = document.createElement('a');
      link.href = selectedPreview;
      link.download = selectedName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      toast.success('Image downloaded.');
      return;
    }

    try {
      const result = await downloadAttachment(selectedAttachment.path, selectedName);
      if (result.error) {
        toast.error(result.error);
      } else if (result.filePath) {
        toast.success(`Saved to Downloads: ${result.filePath.split('/').pop()}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save image.');
    }
  };

  return (
    <>
      <div className="flex flex-wrap justify-end gap-2">
        {imageAttachments.map((a) => {
          const preview = previews[a.id] || undefined;
          return preview ? (
            <button
              key={a.id}
              type="button"
              className="h-40 w-40 cursor-pointer overflow-hidden rounded-xl bg-white outline-none"
              title={`Open ${a.name || a.path}`}
              aria-label={`Open image attachment ${a.name || a.path.split('/').pop() || ''}`}
              onClick={() => setSelectedAttachmentId(a.id)}
            >
              <img
                src={preview}
                className="h-full w-full object-cover"
                alt={a.name || 'Image attachment'}
                onError={() => {
                  setPreviews((prev) => ({ ...prev, [a.id]: null }));
                }}
              />
            </button>
          ) : (
            <div
              key={a.id}
              className="h-40 w-40 overflow-hidden rounded-xl bg-white"
              title={a.path}
            >
              <div className="w-full h-full bg-[var(--bg-tertiary)]" />
            </div>
          );
        })}
      </div>

      <Dialog
        open={Boolean(selectedAttachment && selectedPreview)}
        onOpenChange={(open) => {
          if (!open) setSelectedAttachmentId(null);
        }}
      >
        <DialogPortal>
          <DialogOverlay className="fixed inset-0 z-[100] bg-black/70 backdrop-blur-sm" />
          <DialogContent
            className="fixed inset-0 z-[101] flex cursor-zoom-out items-center justify-center p-8 outline-none"
            onClick={(event) => {
              if (event.target === event.currentTarget) {
                setSelectedAttachmentId(null);
              }
            }}
          >
            <DialogTitle className="sr-only">{selectedName}</DialogTitle>
            {selectedPreview ? (
              <img
                src={selectedPreview}
                alt={selectedName}
                className="max-h-[calc(100vh-64px)] max-w-[calc(100vw-64px)] cursor-default rounded-lg object-contain shadow-2xl"
              />
            ) : null}
            <div className="absolute right-5 top-5 flex items-center gap-2">
              <button
                type="button"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/45 text-white transition-colors hover:bg-black/65"
                aria-label="Download image"
                title="Download"
                onClick={() => void handleDownload()}
              >
                <Download className="h-5 w-5" />
              </button>
              <button
                type="button"
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-black/45 text-white transition-colors hover:bg-black/65"
                aria-label="Close image preview"
                title="Close"
                onClick={() => setSelectedAttachmentId(null)}
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="pointer-events-none absolute bottom-4 left-1/2 max-w-[70vw] -translate-x-1/2 truncate rounded-full bg-black/45 px-3 py-1.5 text-[12px] text-white/90">
              {selectedName}
            </div>
          </DialogContent>
        </DialogPortal>
      </Dialog>
    </>
  );
}
