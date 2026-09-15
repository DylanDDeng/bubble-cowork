import { useEffect, useRef } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useTabsStore } from '../store/useTabsStore';
import { useAppPreferences } from '../store/useAppPreferences';
import { matchesShortcut, SHORTCUT_COMMANDS, shortcutBindings, shortcutConflict } from '../../shared/keyboard-shortcuts';

/** One dispatcher for the keymap shown in Settings. Local editors handle keys first. */
export function useKeyboardShortcuts() {
  const sidebarSearchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-shortcut-capture], .xterm, .cm-editor') || document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [data-shortcut-recording]')) return;
      const state = useAppStore.getState();
      if (event.key === 'Escape') {
        if (state.searchPaletteOpen) state.setSearchPaletteOpen(false);
        else if (state.inSessionSearchOpen) state.closeInSessionSearch();
        else if (document.activeElement === sidebarSearchRef.current) sidebarSearchRef.current?.blur();
        return;
      }
      const overrides = useAppPreferences.getState().keyboardShortcuts;
      const command = SHORTCUT_COMMANDS.find(c => shortcutBindings(c.id, overrides).some(b => matchesShortcut(event, b) && !shortcutConflict(b, c.id, overrides)));
      if (!command) return;
      const id = command.id;
      if (state.showSettings && id !== 'settings') return;
      // Leave formatting and cursor navigation with editable controls.
      const editing = target?.closest('input, textarea, [contenteditable="true"], [role="textbox"]');
      if (editing && ['sidebar', 'activity', 'back', 'forward'].includes(id)) return;
      if (id === 'find' && (state.activeWorkspace !== 'chat' || !state.activeSessionId)) return;
      const tabs = useTabsStore.getState();
      if (id === 'closeTab' && (tabs.tabs.length <= 1 || !tabs.activeTabId)) return;
      event.preventDefault();
      switch (id) {
        case 'search': state.toggleSearchPalette(); break;
        case 'sidebar': state.setSidebarCollapsed(!state.sidebarCollapsed); break;
        case 'activity': state.toggleSidebarActivityView(); break;
        case 'back': tabs.goBack(); break;
        case 'forward': tabs.goForward(); break;
        case 'settings': state.setShowSettings(true); break;
        case 'newTask': state.setShowNewSession(true); break;
        case 'find': state.openInSessionSearch(); break;
        case 'newTab': tabs.openTab({ kind: 'chat', sessionId: null }); break;
        case 'closeTab': tabs.closeTab(tabs.activeTabId!); break;
        case 'nextTab':
        case 'previousTab': {
          const index = tabs.tabs.findIndex(t => t.id === tabs.activeTabId);
          const next = tabs.tabs[(index + (id === 'nextTab' ? 1 : -1) + tabs.tabs.length) % tabs.tabs.length];
          if (next) tabs.activateTab(next.id);
          break;
        }
        default: {
          const number = Number(id.slice(3));
          const tab = number === 9 ? tabs.tabs.at(-1) : tabs.tabs[number - 1];
          if (tab) tabs.activateTab(tab.id);
        }
      }
    };
    // Bubble on window: React controls and document-level local handlers get priority.
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
  return { sidebarSearchRef };
}
