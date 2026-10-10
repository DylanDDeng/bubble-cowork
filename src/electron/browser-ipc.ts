import { BrowserWindow, Menu, clipboard, ipcMain, shell } from 'electron';
import { browserManager } from './browserManager';
import { designModeService } from './design-mode-service';
import { ipcMainHandle } from './util';
import type { BrowserShortcut } from './browser/shortcuts';
import type {
  BrowserChromeFocusInput,
  BrowserCommandEvent,
  BrowserFindInput,
  BrowserMenuInput,
  BrowserNavigateInput,
  BrowserOpenInput,
  BrowserSessionInput,
  BrowserSessionState,
  BrowserViewportInput,
  BrowserZoomInput,
} from '../shared/browser-types';

// All IPC channels live here so both the main process and the preload bridge
// reference a single source of truth.
export const BROWSER_CHANNELS = {
  open: 'desktop:browser-open',
  close: 'desktop:browser-close',
  hide: 'desktop:browser-hide',
  getState: 'desktop:browser-get-state',
  setPanelBounds: 'desktop:browser-set-panel-bounds',
  navigate: 'desktop:browser-navigate',
  reload: 'desktop:browser-reload',
  goBack: 'desktop:browser-go-back',
  goForward: 'desktop:browser-go-forward',
  openDevTools: 'desktop:browser-open-devtools',
  capture: 'desktop:browser-capture',
  snapshot: 'desktop:browser-snapshot',
  readPage: 'desktop:browser-read-page',
  state: 'desktop:browser-state',
  sendSelection: 'desktop:browser-send-selection',
  stop: 'desktop:browser-stop',
  find: 'desktop:browser-find',
  stopFind: 'desktop:browser-stop-find',
  zoom: 'desktop:browser-zoom',
  setChromeFocus: 'desktop:browser-set-chrome-focus',
  command: 'desktop:browser-command',
  findResult: 'desktop:browser-find-result',
  showMenu: 'desktop:browser-show-menu',
} as const;

function sendCommand(mainWindow: BrowserWindow, sessionId: string, command: BrowserCommandEvent['command']): void {
  if (!mainWindow.isDestroyed()) mainWindow.webContents.send(BROWSER_CHANNELS.command, { sessionId, command });
}

function showToolbarMenu(mainWindow: BrowserWindow, input: BrowserMenuInput): void {
  const page = browserManager.getState({ sessionId: input.sessionId }).page;
  if (!page || mainWindow.isDestroyed()) return;
  const sessionId = input.sessionId;
  const web = /^https?:\/\//i.test(page.url);
  const zoomPercent = Math.round((page.zoom || 1) * 100);
  const run = (action: BrowserShortcut) => () => void runBrowserShortcut(mainWindow, sessionId, action).catch(() => {});
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(input.compact
      ? ([
          { label: 'Screenshot to Chat', click: () => sendCommand(mainWindow, sessionId, 'screenshot') },
          {
            label: input.annotating ? 'Stop Annotating' : 'Annotate Page',
            click: () => sendCommand(mainWindow, sessionId, 'annotate'),
          },
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    { label: 'Send Page Text to Chat', click: () => sendCommand(mainWindow, sessionId, 'readout') },
    { type: 'separator' },
    { label: 'Find in Page…', accelerator: 'CmdOrCtrl+F', registerAccelerator: false, click: run('find') },
    { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', registerAccelerator: false, click: run('zoom-in') },
    { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', registerAccelerator: false, click: run('zoom-out') },
    {
      label: zoomPercent === 100 ? 'Actual Size' : `Actual Size (now ${zoomPercent}%)`,
      accelerator: 'CmdOrCtrl+0',
      registerAccelerator: false,
      enabled: zoomPercent !== 100,
      click: run('zoom-reset'),
    },
    { type: 'separator' },
    { label: 'Copy Link', enabled: Boolean(page.url), click: () => clipboard.writeText(page.url) },
    { label: 'Open in Default Browser', enabled: web, click: () => void shell.openExternal(page.url) },
    { type: 'separator' },
    { label: 'Developer Tools', click: () => browserManager.openDevTools({ sessionId }) },
  ];
  Menu.buildFromTemplate(template).popup({ window: mainWindow, x: Math.round(input.x), y: Math.round(input.y) });
}

let unsubscribe: (() => void) | null = null;
let unsubscribeSelection: (() => void) | null = null;
let unsubscribeShortcut: (() => void) | null = null;
let unsubscribeFind: (() => void) | null = null;

/**
 * A browser shortcut, from the page's keyboard or the app menu while the
 * panel chrome has focus. Navigation drains design mode first, as the
 * toolbar buttons do; panel-side actions go to the renderer.
 */
export async function runBrowserShortcut(
  mainWindow: BrowserWindow,
  sessionId: string,
  action: BrowserShortcut
): Promise<void> {
  const input = { sessionId };
  switch (action) {
    case 'focus-address':
    case 'find':
      browserManager.focusAppWindow();
      sendCommand(mainWindow, sessionId, action);
      return;
    case 'reload':
    case 'hard-reload':
      await designModeService.drainForBrowserSession(sessionId);
      browserManager.reload({ ...input, ignoreCache: action === 'hard-reload' });
      return;
    case 'back':
      await designModeService.drainForBrowserSession(sessionId);
      browserManager.goBack(input);
      return;
    case 'forward':
      await designModeService.drainForBrowserSession(sessionId);
      browserManager.goForward(input);
      return;
    case 'zoom-in':
    case 'zoom-out':
    case 'zoom-reset':
      browserManager.zoom({ ...input, direction: action === 'zoom-in' ? 'in' : action === 'zoom-out' ? 'out' : 'reset' });
      return;
  }
}

export function registerBrowserIpc(mainWindow: BrowserWindow): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (unsubscribeSelection) {
    unsubscribeSelection();
    unsubscribeSelection = null;
  }
  unsubscribeShortcut?.();
  unsubscribeShortcut = null;
  unsubscribeFind?.();
  unsubscribeFind = null;
  for (const channel of Object.values(BROWSER_CHANNELS)) {
    ipcMain.removeHandler(channel);
  }

  browserManager.setWindow(mainWindow);

  unsubscribe = browserManager.subscribe((state: BrowserSessionState) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(BROWSER_CHANNELS.state, state);
    }
  });

  unsubscribeSelection = browserManager.subscribeSendSelection((event) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(BROWSER_CHANNELS.sendSelection, event);
    }
  });

  unsubscribeShortcut = browserManager.subscribeShortcut((sessionId, action) => {
    void runBrowserShortcut(mainWindow, sessionId, action).catch(() => {});
  });
  unsubscribeFind = browserManager.subscribeFind((result) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(BROWSER_CHANNELS.findResult, result);
  });

  mainWindow.on('closed', () => {
    unsubscribeShortcut?.();
    unsubscribeShortcut = null;
    unsubscribeFind?.();
    unsubscribeFind = null;
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (unsubscribeSelection) {
      unsubscribeSelection();
      unsubscribeSelection = null;
    }
    browserManager.setWindow(null);
  });

  ipcMainHandle(BROWSER_CHANNELS.open, (_event, input: BrowserOpenInput) =>
    browserManager.open(input)
  );
  ipcMainHandle(BROWSER_CHANNELS.close, async (_event, input: BrowserSessionInput) => {
    // Drain design mode first: close destroys the WebContentsView, and a
    // just-submitted annotation would die in the in-page queue with it.
    await designModeService.disableForBrowserSession(input.sessionId);
    return browserManager.close(input);
  });
  ipcMainHandle(BROWSER_CHANNELS.hide, (_event, input: BrowserSessionInput) => {
    browserManager.hide(input);
    return browserManager.getState(input);
  });
  ipcMainHandle(BROWSER_CHANNELS.getState, (_event, input: BrowserSessionInput) =>
    browserManager.getState(input)
  );
  ipcMainHandle(BROWSER_CHANNELS.setPanelBounds, (_event, input: BrowserViewportInput) =>
    browserManager.setPanelBounds(input)
  );
  ipcMainHandle(BROWSER_CHANNELS.navigate, async (_event, input: BrowserNavigateInput) => {
    await designModeService.drainForBrowserSession(input.sessionId);
    return browserManager.navigate(input);
  });
  ipcMainHandle(BROWSER_CHANNELS.reload, async (_event, input: BrowserSessionInput) => {
    await designModeService.drainForBrowserSession(input.sessionId);
    return browserManager.reload(input);
  });
  ipcMainHandle(BROWSER_CHANNELS.goBack, async (_event, input: BrowserSessionInput) => {
    await designModeService.drainForBrowserSession(input.sessionId);
    return browserManager.goBack(input);
  });
  ipcMainHandle(BROWSER_CHANNELS.goForward, async (_event, input: BrowserSessionInput) => {
    await designModeService.drainForBrowserSession(input.sessionId);
    return browserManager.goForward(input);
  });
  ipcMainHandle(BROWSER_CHANNELS.openDevTools, (_event, input: BrowserSessionInput) => {
    browserManager.openDevTools(input);
    return browserManager.getState({ sessionId: input.sessionId });
  });
  ipcMainHandle(BROWSER_CHANNELS.capture, (_event, input: BrowserSessionInput) =>
    browserManager.capturePage(input)
  );
  ipcMainHandle(BROWSER_CHANNELS.snapshot, (_event, input: BrowserSessionInput) =>
    browserManager.snapshotPage(input)
  );
  ipcMainHandle(BROWSER_CHANNELS.readPage, (_event, input: BrowserSessionInput) =>
    browserManager.readPageContent(input)
  );
  ipcMainHandle(BROWSER_CHANNELS.stop, (_event, input: BrowserSessionInput) => browserManager.stop(input));
  ipcMainHandle(BROWSER_CHANNELS.find, (_event, input: BrowserFindInput) => {
    browserManager.find(input);
  });
  ipcMainHandle(BROWSER_CHANNELS.stopFind, (_event, input: BrowserSessionInput) => {
    browserManager.stopFind(input);
  });
  ipcMainHandle(BROWSER_CHANNELS.zoom, (_event, input: BrowserZoomInput) => browserManager.zoom(input));
  ipcMainHandle(BROWSER_CHANNELS.setChromeFocus, (_event, input: BrowserChromeFocusInput) => {
    browserManager.setChromeFocus(input.sessionId);
  });
  ipcMainHandle(BROWSER_CHANNELS.showMenu, (_event, input: BrowserMenuInput) => {
    showToolbarMenu(mainWindow, input);
  });
}

export function disposeBrowserIpc(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (unsubscribeSelection) {
    unsubscribeSelection();
    unsubscribeSelection = null;
  }
  browserManager.dispose();
}
