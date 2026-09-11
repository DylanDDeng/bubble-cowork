import { BrowserWindow, shell } from 'electron';
import { getSession } from '../libs/session-store';
import { DEV_SERVER_URL, getPreloadPath, getUIPath, ipcMainHandle, isDev } from '../util';
import type { ServerEvent } from '../../shared/types';

/** Secondary windows own ephemeral UI state, while task data stays shared. */
export const sessionWindows = new Map<number, { window: BrowserWindow; rendererState: Record<string, string> }>();

export function broadcastSessionEvent(primary: BrowserWindow, event: ServerEvent): void {
  const targets = event.type === 'session.open' ? [primary] : [primary, ...[...sessionWindows.values()].map(value => value.window)];
  for (const win of new Set(targets)) {
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('server-event', JSON.stringify(event));
  }
}

export function setupSessionWindowsIPC(options: {
  backgroundColor: () => string;
  rendererState: () => Record<string, string>;
  onCreate: (win: BrowserWindow) => void;
}) {
  ipcMainHandle('open-session-window', async (_, sessionId: string) => {
    const task = typeof sessionId === 'string' ? getSession(sessionId) : undefined;
    if (!task || task.hidden_from_threads) throw new Error('This conversation is no longer available.');
    const win = new BrowserWindow({
      width: 1100, height: 800, minWidth: 560, minHeight: 600, show: false,
      title: task.title, titleBarStyle: 'hidden', trafficLightPosition: { x: 15, y: 15 },
      backgroundColor: options.backgroundColor(),
      webPreferences: { preload: getPreloadPath(), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    const rendererState = { ...options.rendererState() };
    // Retain appearance and provider preferences, start with fresh navigation.
    for (const key of Object.keys(rendererState)) {
      if (/tabs|browser|board/i.test(key)) delete rendererState[key];
    }
    try {
      const saved = JSON.parse(rendererState['cowork-app-storage'] || '{}');
      const state: Record<string, unknown> = { activeWorkspace: 'chat' };
      for (const key of ['theme', 'themeState', 'uiFontFamily', 'chatCodeFontFamily', 'skinImage', 'skinImageData', 'skinOpacity']) {
        if (saved.state?.[key] !== undefined) state[key] = saved.state[key];
      }
      rendererState['cowork-app-storage'] = JSON.stringify({ ...saved, state });
    } catch { delete rendererState['cowork-app-storage']; }
    sessionWindows.set(win.webContents.id, { window: win, rendererState });
    const webContentsId = win.webContents.id;
    win.once('closed', () => sessionWindows.delete(webContentsId));
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (event, url) => {
      if (url !== win.webContents.getURL()) {
        event.preventDefault();
        if (/^https?:/i.test(url)) void shell.openExternal(url);
      }
    });
    options.onCreate(win);
    try {
      if (isDev()) {
        const url = new URL(DEV_SERVER_URL);
        url.searchParams.set('sessionWindow', sessionId);
        await win.loadURL(url.toString());
      } else {
        await win.loadFile(getUIPath(), { query: { sessionWindow: sessionId } });
      }
      win.show();
    } catch (error) { win.destroy(); throw error; }
  });
}
