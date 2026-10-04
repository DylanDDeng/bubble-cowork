import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAppReducedMotion } from '../../hooks/useAppReducedMotion';
import './environment-panel-layout.css';

type PanelMode = 'overlay' | 'shift' | 'gutter';
type PanelLayout = {
  surface: HTMLDivElement | null;
  mode: PanelMode;
  visible: boolean;
  register: (surface: HTMLDivElement) => () => void;
  setRequested: (requested: boolean) => void;
};
const Context = createContext<PanelLayout | null>(null);
export const useEnvironmentPanelLayout = () => useContext(Context);

export function EnvironmentPanelProvider({ children }: { children: ReactNode }) {
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  // The active session's card has content and has not been closed.
  const [requested, setRequested] = useState(false);
  const register = useCallback((element: HTMLDivElement) => {
    setSurface(element);
    return () => setSurface(current => current === element ? null : current);
  }, []);
  useLayoutEffect(() => {
    if (!surface) { setWidth(0); return; }
    const measure = () => setWidth(surface.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [surface]);
  const mode: PanelMode = width < 1096 ? 'overlay' : width < 1536 ? 'shift' : 'gutter';
  const visible = !!surface && requested && mode !== 'overlay';
  const value = useMemo(() => ({ surface, mode, visible, register, setRequested }), [surface, mode, visible, register]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Observe the unshifted active pane, including in split layouts. */
export function EnvironmentChatSurface({ active, children }: { active: boolean; children: ReactNode }) {
  const layout = useEnvironmentPanelLayout();
  const ref = useRef<HTMLDivElement>(null);
  const register = layout?.register;
  const reducedMotion = useAppReducedMotion();
  useLayoutEffect(() => {
    if (active && ref.current && register) return register(ref.current);
  }, [active, register]);
  const mode = active && layout?.visible ? layout.mode : 'overlay';
  return (
    <div ref={ref} className="environment-chat-surface" data-environment-mode={mode} data-environment-reduced-motion={reducedMotion || undefined}>
      <div className="environment-chat-content">{children}</div>
    </div>
  );
}
