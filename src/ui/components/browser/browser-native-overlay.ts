import { createContext, useContext, useId, useLayoutEffect } from 'react';

type BrowserNativeOverlayContextValue = {
  hidden: boolean;
  setOverlayOpen: (sourceId: string, open: boolean) => void;
};

const defaultContextValue: BrowserNativeOverlayContextValue = {
  hidden: false,
  setOverlayOpen: () => {},
};

/**
 * Native WebContentsViews sit above the React tree. App-level DOM overlays
 * register here so BrowserPanel can detach the native view before a menu,
 * lightbox, or dialog paints above it.
 */
export const BrowserNativeOverlayContext = createContext<BrowserNativeOverlayContextValue>(
  defaultContextValue
);

export function useBrowserNativeOverlay(): boolean {
  return useContext(BrowserNativeOverlayContext).hidden;
}

export function useBrowserNativeOverlayRegistration(open: boolean): void {
  const sourceId = useId();
  const { setOverlayOpen } = useContext(BrowserNativeOverlayContext);

  useLayoutEffect(() => {
    setOverlayOpen(sourceId, open);
    return () => setOverlayOpen(sourceId, false);
  }, [open, setOverlayOpen, sourceId]);
}
