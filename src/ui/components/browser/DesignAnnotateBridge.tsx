import { useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import { useAppStore } from '../../store/useAppStore';
import type { DesignSelectionInfo } from '../../../shared/design-mode-types';
import type { Attachment } from '../../../shared/types';
import { computeAnnotationCrop, composeAnnotationText } from './design-annotate';

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Crop a captured PNG data URL to the annotation region; null → use original. */
async function cropDataUrl(
  dataUrl: string,
  crop: { sx: number; sy: number; sw: number; sh: number } | null
): Promise<Uint8Array | null> {
  if (!crop) return null;
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('screenshot decode failed'));
    image.src = dataUrl;
  });
  const canvas = document.createElement('canvas');
  canvas.width = crop.sw;
  canvas.height = crop.sh;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.drawImage(image, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Headless design-mode companion: listens for annotate submissions from the
 * in-page bubble and lands them in the composer — the user's note, a
 * screenshot cropped to the element (submit-time geometry), and the element
 * context. Design mode never writes source files; the agent does.
 *
 * Mounted for the PANEL's browser session (not gated on the design target):
 * the service's disable path performs a final queue drain, and those last
 * annotate events arrive after the UI already cleared its design state — a
 * target-gated bridge would unmount and drop them.
 */
export function DesignAnnotateBridge({
  browserSessionId,
  onDesignDisabled,
  resolveChatTargetId,
}: {
  browserSessionId: string;
  onDesignDisabled: (tabId: string) => void;
  resolveChatTargetId: () => string;
}) {
  const requestChatInjection = useAppStore((s) => s.requestChatInjection);

  const sendAnnotation = useCallback(
    async (tabId: string, note: string, target: DesignSelectionInfo) => {
      const attachments: Attachment[] = [];
      let pageUrl: string | null = null;
      try {
        const captured = await window.electron.browser.capture({ sessionId: browserSessionId, tabId });
        if (captured.ok && captured.base64 && captured.dataUrl) {
          pageUrl = captured.pageUrl ?? null;
          // Fresh geometry at submit time — the selection-time rect is stale
          // the moment the page scrolls. When the element cannot be measured
          // any more (removed / inspector lost), do NOT crop from stale
          // coordinates: a full screenshot beats a confidently wrong region.
          const measured = await window.electron.designMode.measureSelection({ sessionId: browserSessionId, tabId });
          const crop =
            measured.found && measured.rect && measured.viewport
              ? computeAnnotationCrop(measured.rect, measured.viewport, {
                  width: captured.width ?? 0,
                  height: captured.height ?? 0,
                })
              : null;
          const cropped = await cropDataUrl(captured.dataUrl, crop).catch(() => null);
          const bytes = cropped ?? base64ToBytes(captured.base64);
          const attachment = (await window.electron.createInlineImageAttachment(
            captured.mimeType || 'image/png',
            bytes
          )) as Attachment | null;
          if (attachment) attachments.push(attachment);
        }
      } catch {
        // Screenshot is best-effort; the annotation still carries the context.
      }
      requestChatInjection({
        sessionId: resolveChatTargetId(),
        text: composeAnnotationText({ note, selection: target, pageUrl, hasScreenshot: attachments.length > 0 }),
        attachments,
        mode: 'append',
        source: 'design-annotate',
      });
      toast.success('Annotation sent to the composer — review and send');
    },
    [browserSessionId, requestChatInjection, resolveChatTargetId]
  );

  useEffect(() => {
    return window.electron.designMode.onEvent((event) => {
      if (event.sessionId !== browserSessionId) return;
      if (event.kind === 'annotate') void sendAnnotation(event.tabId, event.note, event.info);
      if (event.kind === 'disabled') onDesignDisabled(event.tabId);
    });
  }, [browserSessionId, sendAnnotation, onDesignDisabled]);

  return null;
}
