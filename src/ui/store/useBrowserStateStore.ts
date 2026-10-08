import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { BrowserSessionState } from '../../shared/browser-types';
import { rendererStateStorage } from '../utils/renderer-state-storage';

/**
 * Last known page of each browser session, persisted so tab labels and the
 * panel can show something right away (after a restart or session switch)
 * before the main process reports the live page.
 */
export interface RememberedPage {
  pageId: string;
  url: string;
  title: string;
  favicon: string | null;
  seenAt: number;
}

interface BrowserPageMemory {
  pages: Record<string, RememberedPage>;
  remember: (state: BrowserSessionState) => void;
  forget: (browserSessionId: string) => void;
}

export const useBrowserStateStore = create<BrowserPageMemory>()(
  persist(
    (set) => ({
      pages: {},
      remember: ({ sessionId, page }) => {
        if (!page) return;
        set((current) => {
          const known = current.pages[sessionId];
          if (known && known.pageId === page.id && known.url === page.url && known.title === page.title && known.favicon === page.favicon) {
            return current;
          }
          return {
            pages: {
              ...current.pages,
              [sessionId]: { pageId: page.id, url: page.url, title: page.title, favicon: page.favicon, seenAt: Date.now() },
            },
          };
        });
      },
      forget: (browserSessionId) =>
        set((current) => {
          if (!(browserSessionId in current.pages)) return current;
          const pages = { ...current.pages };
          delete pages[browserSessionId];
          return { pages };
        }),
    }),
    { name: 'aegis:browser-pages:v2', storage: createJSONStorage(() => rendererStateStorage) }
  )
);
