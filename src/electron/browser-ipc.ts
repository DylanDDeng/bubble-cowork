import { BrowserWindow, ipcMain } from 'electron';
import { browserManager } from './browserManager';
import type {
  BrowserNavigateInput,
  BrowserNewTabInput,
  BrowserOpenInput,
  BrowserSessionInput,
  BrowserSetPanelBoundsInput,
  BrowserTabInput,
  SessionBrowserState,
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
  newTab: 'desktop:browser-new-tab',
  closeTab: 'desktop:browser-close-tab',
  selectTab: 'desktop:browser-select-tab',
  openDevTools: 'desktop:browser-open-devtools',
  capture: 'desktop:browser-capture',
  readPage: 'desktop:browser-read-page',
  state: 'desktop:browser-state',
  sendSelection: 'desktop:browser-send-selection',
} as const;

let unsubscribe: (() => void) | null = null;
let unsubscribeSelection: (() => void) | null = null;

export function registerBrowserIpc(mainWindow: BrowserWindow): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (unsubscribeSelection) {
    unsubscribeSelection();
    unsubscribeSelection = null;
  }
  for (const channel of Object.values(BROWSER_CHANNELS)) {
    ipcMain.removeHandler(channel);
  }

  browserManager.setWindow(mainWindow);

  unsubscribe = browserManager.subscribe((state: SessionBrowserState) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(BROWSER_CHANNELS.state, state);
    }
  });

  unsubscribeSelection = browserManager.subscribeSendSelection((event) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(BROWSER_CHANNELS.sendSelection, event);
    }
  });

  mainWindow.on('closed', () => {
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

  ipcMain.handle(BROWSER_CHANNELS.open, (_event, input: BrowserOpenInput) =>
    browserManager.open(input)
  );
  ipcMain.handle(BROWSER_CHANNELS.close, (_event, input: BrowserSessionInput) =>
    browserManager.close(input)
  );
  ipcMain.handle(BROWSER_CHANNELS.hide, (_event, input: BrowserSessionInput) => {
    browserManager.hide(input);
    return browserManager.getState(input);
  });
  ipcMain.handle(BROWSER_CHANNELS.getState, (_event, input: BrowserSessionInput) =>
    browserManager.getState(input)
  );
  ipcMain.handle(BROWSER_CHANNELS.setPanelBounds, (_event, input: BrowserSetPanelBoundsInput) =>
    browserManager.setPanelBounds(input)
  );
  ipcMain.handle(BROWSER_CHANNELS.navigate, (_event, input: BrowserNavigateInput) =>
    browserManager.navigate(input)
  );
  ipcMain.handle(BROWSER_CHANNELS.reload, (_event, input: BrowserTabInput) =>
    browserManager.reload(input)
  );
  ipcMain.handle(BROWSER_CHANNELS.goBack, (_event, input: BrowserTabInput) =>
    browserManager.goBack(input)
  );
  ipcMain.handle(BROWSER_CHANNELS.goForward, (_event, input: BrowserTabInput) =>
    browserManager.goForward(input)
  );
  ipcMain.handle(BROWSER_CHANNELS.newTab, (_event, input: BrowserNewTabInput) =>
    browserManager.newTab(input)
  );
  ipcMain.handle(BROWSER_CHANNELS.closeTab, (_event, input: BrowserTabInput) =>
    browserManager.closeTab(input)
  );
  ipcMain.handle(BROWSER_CHANNELS.selectTab, (_event, input: BrowserTabInput) =>
    browserManager.selectTab(input)
  );
  ipcMain.handle(BROWSER_CHANNELS.openDevTools, (_event, input: BrowserTabInput) => {
    browserManager.openDevTools(input);
    return browserManager.getState({ sessionId: input.sessionId });
  });
  ipcMain.handle(BROWSER_CHANNELS.capture, (_event, input: BrowserTabInput) =>
    browserManager.capturePage(input)
  );
  ipcMain.handle(BROWSER_CHANNELS.readPage, (_event, input: BrowserTabInput) =>
    browserManager.readPageContent(input)
  );
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
