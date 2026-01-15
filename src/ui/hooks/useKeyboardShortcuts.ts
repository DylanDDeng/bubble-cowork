import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';

/**
 * 全局快捷键 hook
 * - Cmd/Ctrl + K: 聚焦侧边栏搜索
 * - Cmd/Ctrl + F: 打开会话内搜索
 * - Escape: 关闭搜索面板
 */
export function useKeyboardShortcuts() {
  const sidebarSearchRef = useRef<HTMLInputElement>(null);
  const { openInSessionSearch, closeInSessionSearch, inSessionSearchOpen, activeSessionId } =
    useAppStore();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;

      // Cmd/Ctrl + K: 聚焦侧边栏搜索
      if (isMod && e.key === 'k') {
        e.preventDefault();
        sidebarSearchRef.current?.focus();
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
        if (inSessionSearchOpen) {
          closeInSessionSearch();
        } else {
          // 如果侧边栏搜索有焦点，清除焦点
          if (document.activeElement === sidebarSearchRef.current) {
            sidebarSearchRef.current?.blur();
          }
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [openInSessionSearch, closeInSessionSearch, inSessionSearchOpen, activeSessionId]);

  return { sidebarSearchRef };
}
