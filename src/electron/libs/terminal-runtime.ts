import type { BrowserWindow } from 'electron';
import type { TerminalEvent } from '../../shared/terminal';
import { TerminalManager } from './terminal-manager';

type TerminalEventSubscriber = (payload: TerminalEvent) => void;

const subscribers = new Set<TerminalEventSubscriber>();

let mainWindow: BrowserWindow | null = null;

function emitTerminalEvent(payload: TerminalEvent): void {
  const win = mainWindow;
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('terminal-event', JSON.stringify(payload));
  }

  for (const subscriber of subscribers) {
    try {
      subscriber(payload);
    } catch (error) {
      console.warn('[Terminal] Event subscriber failed:', error);
    }
  }
}

export const terminalManager = new TerminalManager(emitTerminalEvent);

export function attachTerminalWindow(win: BrowserWindow): void {
  mainWindow = win;
}

export function subscribeTerminalEvents(subscriber: TerminalEventSubscriber): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

export function disposeTerminalRuntime(): void {
  terminalManager.disposeAll();
  subscribers.clear();
  mainWindow = null;
}
