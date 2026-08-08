import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';

/**
 * Global keyboard shortcuts
 * - Cmd/Ctrl + K: Toggle the search palette (threads, projects, actions)
 * - Cmd/Ctrl + B: Toggle the thread sidebar
 * - Cmd/Ctrl + Alt + U: Toggle the sidebar activity view
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
    sidebarCollapsed,
    setSidebarCollapsed,
    toggleSidebarActivityView,
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

      // Cmd/Ctrl + B: 切换左侧 thread sidebar，与 Synara 的 sidebar.toggle 行为保持一致
      if (isMod && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setSidebarCollapsed(!sidebarCollapsed);
        return;
      }

      // Cmd/Ctrl + Alt + U: 切换侧边栏 activity view，对齐 Codex 的 ⌥⌘U。
      // macOS 上 Option 组合会改写 e.key（⌥U 是死键），必须用 e.code 判断。
      if (isMod && e.altKey && e.code === 'KeyU') {
        e.preventDefault();
        toggleSidebarActivityView();
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
    sidebarCollapsed,
    setSidebarCollapsed,
    toggleSidebarActivityView,
  ]);

  return { sidebarSearchRef };
}
