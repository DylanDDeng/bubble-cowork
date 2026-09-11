import { dialog, ipcMain, type BrowserWindow } from 'electron';
import { ATTACHMENT_MIME_TYPES } from '../../shared/attachment-policy';
import { clipboardFilePaths, importAttachmentBytes, importAttachmentPaths } from '../libs/file-attachments';
import { ipcMainHandle, ipcMainOn } from '../util';

export function setupAttachmentIPC(mainWindow: BrowserWindow): void {
  ipcMainHandle('import-attachments', (_event, paths: string[]) => importAttachmentPaths(paths));
  ipcMainHandle('create-file-attachment', (_event, name: string, data: Uint8Array) => importAttachmentBytes(name, data));
  ipcMain.removeAllListeners('clipboard-file-paths');
  ipcMainOn('clipboard-file-paths', (event) => { event.returnValue = clipboardFilePaths(); });
  ipcMainHandle('choose-attachments', async () => {
    const selected = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Supported files', extensions: Object.keys(ATTACHMENT_MIME_TYPES).map(ext => ext.slice(1)) }],
    });
    return selected.canceled ? { attachments: [], errors: [] } : importAttachmentPaths(selected.filePaths);
  });
}
