import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { toast } from 'sonner';
import type { Attachment } from '../types';
import { importStudioImages } from '../lib/image-studio';
import { useImageStudioStore } from '../store/useImageStudioStore';

const prefix = 'image-studio:';

/** Reconcile selected images without removing/reimporting the existing chips. */
export function useImageStudioAttachments(sessionId: string | null | undefined, paths: string[], setAttachments: Dispatch<SetStateAction<Attachment[]>>) {
  const [loading, setLoading] = useState(false);
  const cache = useRef({ sessionId, imports: new Map<string, Promise<Attachment>>(), ready: new Map<string, Attachment>() });
  const selectionKey = JSON.stringify(paths);
  useEffect(() => {
    if (cache.current.sessionId !== sessionId) cache.current = { sessionId, imports: new Map(), ready: new Map() };
    if (!sessionId) { setLoading(false); return; }
    const { imports, ready } = cache.current;
    const selected: string[] = JSON.parse(selectionKey);
    let cancelled = false;
    const reconcile = (previous: Attachment[], added?: Attachment) => {
      const known = new Map(previous.filter(item => item.id.startsWith(prefix)).map(item => [item.id, item]));
      if (added) known.set(added.id, added);
      return [...previous.filter(item => !item.id.startsWith(prefix)),
        ...selected.map(path => ready.get(path) || known.get(prefix + path) || {
          // Reserve the chip immediately; sending stays blocked until import
          // supplies the real file metadata. The stable ID preserves its DOM.
          id: prefix + path, path, name: path.split('/').pop() || 'Image',
          kind: 'image' as const, size: 0, mimeType: 'application/octet-stream',
        })];
    };
    // Prune removed selections immediately while preserving retained objects.
    setAttachments(previous => reconcile(previous));
    const missing = selected.filter(path => !ready.has(path));
    setLoading(missing.length > 0);
    void Promise.all(missing.map(async path => {
      let imported = imports.get(path);
      if (!imported) {
        imported = importStudioImages([path]).then(([item]) => {
          const attachment = { ...item, id: prefix + path };
          ready.set(path, attachment);
          return attachment;
        });
        imports.set(path, imported);
        // A failure must be retryable; successful imports are reused for quick toggles.
        imported.catch(() => { if (imports.get(path) === imported) imports.delete(path); });
      }
      try {
        const item = await imported;
        if (!cancelled) setAttachments(previous => reconcile(previous, item));
      } catch (error) {
        if (cancelled) return;
        const studio = useImageStudioStore.getState();
        const selection = studio.sessions[sessionId];
        if (selection?.selected.includes(path)) {
          studio.patch(sessionId, { selected: selection.selected.filter(item => item !== path) });
          toast.error(error instanceof Error ? error.message : String(error));
        }
      }
    })).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sessionId, selectionKey, setAttachments]);
  return loading || (paths.length > 0 && (cache.current.sessionId !== sessionId || paths.some(path => !cache.current.ready.has(path))));
}
