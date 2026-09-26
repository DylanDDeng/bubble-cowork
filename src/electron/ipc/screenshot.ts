import type { BrowserWindow } from 'electron';
import type { ScreenshotExportAction, ScreenshotMode, ScreenshotRect } from '../../shared/screenshot';
import {
  attachScreenshotHost,
  captureScreenshot,
  closeScreenshotEditor,
  completeScreenshotSelection,
  exportScreenshot,
  isScreenshotEditorSender,
  loadScreenshotEditorPayload,
  openLastScreenshot,
  requestScreenRecordingPermission,
  retakeScreenshot,
} from '../libs/screenshot';
import { ipcMainHandle } from '../util';

export function setupScreenshotIPC(mainWindow: BrowserWindow): void {
  attachScreenshotHost(mainWindow);
  ipcMainHandle('screenshot-capture', (_event, mode: ScreenshotMode) => captureScreenshot(mode));
  ipcMainHandle('screenshot-selection-complete', (event, id: string, rect: ScreenshotRect | null) => {
    completeScreenshotSelection(event.sender, id, rect);
  });
  ipcMainHandle('screenshot-open-last', () => openLastScreenshot());
  ipcMainHandle('screenshot-request-permission', () => requestScreenRecordingPermission());
  // Editor-only channels: the capture and its exports never serve other windows.
  ipcMainHandle('screenshot-editor-load', (event) => (isScreenshotEditorSender(event.sender) ? loadScreenshotEditorPayload() : null));
  ipcMainHandle('screenshot-export', (event, action: ScreenshotExportAction, data: Uint8Array, name?: string) => {
    if (!isScreenshotEditorSender(event.sender)) return { ok: false, message: 'Unauthorized sender.' };
    return exportScreenshot(action, data, name);
  });
  ipcMainHandle('screenshot-editor-close', (event) => {
    if (isScreenshotEditorSender(event.sender)) closeScreenshotEditor();
  });
  ipcMainHandle('screenshot-retake', (event) => (isScreenshotEditorSender(event.sender) ? retakeScreenshot() : { status: 'cancelled' as const }));
}
