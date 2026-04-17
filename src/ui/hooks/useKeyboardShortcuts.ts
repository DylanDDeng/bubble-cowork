import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';

/**
 * Global keyboard shortcuts
 * - Cmd/Ctrl + K: Toggle the search palette (threads, projects, actions)
 * - Cmd/Ctrl + F: Open in-session search
 * - Escape: Close search panel
 */
export function useKeyboardShortcuts() {
  const sidebarSearchRef = useRef<HTMLInputElement>(null);
  const {
    openInSessionSearch,
    closeInSessionSearch,
    inSessionSearchOpen,
    activeSessionId,
    toggleSearchPalette,
    searchPaletteOpen,
    setSearchPaletteOpen,
  } = useAppStore();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;

      // Cmd/Ctrl + K: 切换搜索命令面板
      if (isMod && e.key === 'k') {
        e.preventDefault();
        toggleSearchPalette();
        return;
      }

      // Cmd/Ctrl + F: 打开会话内搜索
      if (isMod && e.key === 'f') {
        e.preventDefault();
        if (activeSessionId) {
          openInSessionSearch();
        }
      }

      // Escape: 关闭搜索面板
      if (e.key === 'Escape') {
        if (searchPaletteOpen) {
          setSearchPaletteOpen(false);
        } else if (inSessionSearchOpen) {
          closeInSessionSearch();
        } else if (document.activeElement === sidebarSearchRef.current) {
          sidebarSearchRef.current?.blur();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [
    openInSessionSearch,
    closeInSessionSearch,
    inSessionSearchOpen,
    activeSessionId,
    toggleSearchPalette,
    searchPaletteOpen,
    setSearchPaletteOpen,
  ]);

  return { sidebarSearchRef };
}
