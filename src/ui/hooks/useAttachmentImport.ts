import { useEffect, useRef, useState, type DragEvent } from 'react';
import { toast } from 'sonner';
import type { AttachmentImportResult } from '../../shared/attachment-policy';
import type { Attachment } from '../types';
import { importComposerFiles } from '../utils/import-composer-files';

export function useAttachmentImport(sessionId: string | null, busy: boolean, add: (attachments: Attachment[]) => void) {
  const identity = useRef({ sessionId, generation: 0 });
  const pending = useRef(0);
  const [count, setCount] = useState(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (identity.current.sessionId !== sessionId) {
    identity.current = { sessionId, generation: identity.current.generation + 1 };
  }
  async function run(operation: () => Promise<AttachmentImportResult>) {
    if (busy) return;
    const origin = identity.current;
    pending.current += 1;
    setCount(pending.current);
    try {
      const result = await operation();
      if (!mounted.current || origin !== identity.current) return;
      add(result.attachments);
      if (result.errors.length) toast.error(result.errors.join('\n'));
    } catch (error) {
      if (mounted.current && origin === identity.current) toast.error(error instanceof Error ? error.message : 'Could not attach these files.');
    } finally {
      pending.current -= 1;
      if (mounted.current) setCount(pending.current);
    }
  }
  return {
    isImporting: count > 0,
    pending,
    files: (files: File[]) => { void run(() => importComposerFiles(files)); },
    dropProps: {
      onDragOver: (event: DragEvent<HTMLElement>) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault(); event.stopPropagation();
        event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        const files = Array.from(event.dataTransfer.files);
        if (!files.length) return;
        event.preventDefault(); event.stopPropagation();
        void run(() => importComposerFiles(files));
      },
    },
    choose: () => run(() => window.electron.chooseAttachments()),
    pasteNative: (): boolean => {
      const paths = window.electron.getClipboardFilePaths?.() || [];
      if (!paths.length) return false;
      void run(() => window.electron.importAttachments(paths));
      return true;
    },
  };
}
