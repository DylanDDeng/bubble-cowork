import { createContext, useContext } from 'react';

/**
 * True while an HTML overlay in the right-utility chrome (the + tab menu)
 * is open. Native WebContentsViews sit above the React tree, so those
 * popups would otherwise render underneath the page and look "stuck" as a
 * Files ⌘P chip over the browser.
 */
export const BrowserNativeOverlayContext = createContext(false);

export function useBrowserNativeOverlay(): boolean {
  return useContext(BrowserNativeOverlayContext);
}
