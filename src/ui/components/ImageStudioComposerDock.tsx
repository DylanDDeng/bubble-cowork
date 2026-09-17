import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';

const useDock = create<{ hosts: Record<string, HTMLDivElement | null> }>(() => ({ hosts: {} }));

// The portal container never changes: moving it preserves the editor, draft,
// attachments, selection and open permission request across workspace views.
export function ImageStudioComposerHome({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const home = useRef<HTMLDivElement>(null);
  const [container] = useState(() => document.createElement('div'));
  const host = useDock(state => state.hosts[sessionId]);
  useLayoutEffect(() => {
    const target = host || home.current;
    target?.appendChild(container);
    return () => { container.remove(); };
  }, [host, container]);
  return <><div ref={home} data-composer-home={sessionId} />{createPortal(children, container)}</>;
}

export function ImageStudioComposerSlot({ sessionId }: { sessionId: string }) {
  const attach = useCallback((host: HTMLDivElement | null) => {
    useDock.setState(state => ({ hosts: { ...state.hosts, [sessionId]: host } }));
  }, [sessionId]);
  return <div ref={attach} className="image-studio-composer-slot" />;
}
