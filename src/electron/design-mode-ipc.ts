import { BrowserWindow, ipcMain } from 'electron';
import { designModeService } from './design-mode-service';
import type { DesignApplyInput, DesignModeTarget } from '../shared/design-mode-types';

// All IPC channels live here so both the main process and the preload bridge
// reference a single source of truth (mirrors browser-ipc.ts).
export const DESIGN_CHANNELS = {
  enable: 'desktop:design-mode-enable',
  disable: 'desktop:design-mode-disable',
  preview: 'desktop:design-mode-preview',
  clearPreview: 'desktop:design-mode-clear-preview',
  apply: 'desktop:design-mode-apply',
  undo: 'desktop:design-mode-undo',
  rollbackLastFailed: 'desktop:design-mode-rollback-last-failed',
  event: 'desktop:design-mode-event',
} as const;

let unsubscribe: (() => void) | null = null;

export function registerDesignModeIpc(mainWindow: BrowserWindow): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  for (const channel of Object.values(DESIGN_CHANNELS)) {
    ipcMain.removeHandler(channel);
  }

  unsubscribe = designModeService.subscribe((event) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(DESIGN_CHANNELS.event, event);
    }
  });

  mainWindow.on('closed', () => {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  });

  ipcMain.handle(DESIGN_CHANNELS.enable, (_event, input: DesignModeTarget & { projectRoot: string }) =>
    designModeService.enable(input)
  );
  ipcMain.handle(DESIGN_CHANNELS.disable, (_event, input: DesignModeTarget) =>
    designModeService.disable(input)
  );
  ipcMain.handle(DESIGN_CHANNELS.preview, (_event, input: DesignModeTarget & { property: string; value: string }) =>
    designModeService.preview(input)
  );
  ipcMain.handle(DESIGN_CHANNELS.clearPreview, (_event, input: DesignModeTarget) =>
    designModeService.clearPreview(input)
  );
  ipcMain.handle(DESIGN_CHANNELS.apply, (_event, input: DesignApplyInput) =>
    designModeService.apply(input)
  );
  ipcMain.handle(DESIGN_CHANNELS.undo, (_event, input: DesignModeTarget) =>
    designModeService.undo(input)
  );
  ipcMain.handle(DESIGN_CHANNELS.rollbackLastFailed, (_event, input: DesignModeTarget) =>
    designModeService.rollbackLastFailed(input)
  );
}
