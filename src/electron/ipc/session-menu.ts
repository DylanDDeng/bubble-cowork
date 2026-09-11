import { BrowserWindow, Menu, nativeImage, type MenuItemConstructorOptions } from 'electron';
import type { SessionMenuAction, SessionMenuIcon, SessionMenuRequest } from '../../shared/session-menu';
import { ipcMainHandle } from '../util';

const symbols: Record<SessionMenuIcon, string> = {
  pin: 'pin', copy: 'doc.on.doc', link: 'link', folder: 'folder',
  fork: 'arrow.triangle.branch', worktree: 'arrow.triangle.branch',
  apply: 'arrow.triangle.merge', trash: 'trash', rename: 'pencil', unread: 'circle', archive: 'archivebox', section: 'rectangle.3.group', share: 'square.and.arrow.up', window: 'macwindow',
};
const actions = new Set<SessionMenuAction>([
  'pin', 'copy-link', 'copy-cwd', 'fork', 'new-worktree-thread',
  'move-worktree', 'apply-worktree', 'discard-worktree', 'delete',
  'rename', 'unread', 'archive', 'copy-markdown', 'project-choose', 'section-none', 'section-new', 'fork-local', 'fork-worktree', 'open-window', 'export', 'share',
]);

export function buildSessionNativeMenu(request: SessionMenuRequest, select: (action: SessionMenuAction) => void): Menu {
  const seen = new Set<string>();
  function items(value: unknown, depth = 0, parentEnabled = true): MenuItemConstructorOptions[] {
    if (!Array.isArray(value) || value.length > 256 || depth > 1) throw new Error('Invalid conversation menu');
    return value.map(item => {
      if (!item || typeof item !== 'object') throw new Error('Invalid menu item');
      if (item.type === 'separator') return { type: 'separator' };
      if (typeof item.label !== 'string' || item.label.length > 120 || !Object.hasOwn(symbols, item.icon)) throw new Error('Invalid menu item');
      if (item.enabled !== undefined && typeof item.enabled !== 'boolean') throw new Error('Invalid menu state');
      if (item.id && ((!actions.has(item.id) && !/^(project|section|editor):\d{1,3}$/.test(item.id)) || seen.has(item.id))) throw new Error('Invalid menu action');
      if (item.checked !== undefined && typeof item.checked !== 'boolean') throw new Error('Invalid menu state');
      if (item.id) seen.add(item.id);
      if (Boolean(item.id) === Boolean(item.submenu)) throw new Error('Invalid menu action');
      return {
        id: item.id,
        label: item.label,
        ...(item.checked !== undefined ? { type: 'checkbox' as const, checked: item.checked } : {}),
        enabled: parentEnabled && item.enabled !== false,
        icon: process.platform === 'darwin' ? nativeImage.createMenuSymbol(symbols[item.icon as SessionMenuIcon]) : undefined,
        ...(item.submenu ? { submenu: items(item.submenu, depth + 1, parentEnabled && item.enabled !== false) } : {
          click: () => select(item.id),
        }),
      };
    });
  }
  return Menu.buildFromTemplate(items(request.items));
}

export function setupSessionMenuIPC(): void {
  const active = new Map<number, () => void>();
  ipcMainHandle('show-session-menu', (event, request: SessionMenuRequest) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed()) return null;
    active.get(event.sender.id)?.();
    return new Promise<SessionMenuAction | null>((resolve, reject) => {
      let chosen: SessionMenuAction | null = null;
      let settled = false;
      let menu: Menu;
      const finish = () => {
        if (settled) return;
        settled = true;
        event.sender.removeListener('destroyed', cancel);
        if (active.get(event.sender.id) === cancel) active.delete(event.sender.id);
        resolve(chosen);
      };
      const cancel = () => { menu.closePopup(window); finish(); };
      try {
        menu = buildSessionNativeMenu(request, action => { chosen = action; });
        event.sender.once('destroyed', cancel);
        active.set(event.sender.id, cancel);
        const position = request.position;
        const zoom = event.sender.getZoomFactor();
        menu.popup({
          window,
          ...(position && Number.isFinite(position.x) && Number.isFinite(position.y) ? {
            x: Math.round(Math.max(0, Math.min(window.getContentSize()[0], position.x * zoom))),
            y: Math.round(Math.max(0, Math.min(window.getContentSize()[1], position.y * zoom))),
          } : {}),
          // Defer renderer actions until native menu tracking has ended.
          callback: () => setImmediate(finish),
        });
      } catch (error) {
        event.sender.removeListener('destroyed', cancel);
        if (active.get(event.sender.id) === cancel) active.delete(event.sender.id);
        reject(error);
      }
    });
  });
}
