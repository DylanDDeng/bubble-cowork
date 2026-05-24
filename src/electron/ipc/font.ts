/**
 * 字体模块
 *
 * 管理系统字体和自定义字体导入。
 */

import { ipcMainHandle } from '../util'
import { IPCHandlerContext } from './context'
import {
  getFontSettings,
  saveFontSelections,
  listSystemFonts,
  importFontFile,
  deleteImportedFont,
} from '../libs/font-settings'
import { dialog } from 'electron'

export function register(ctx: IPCHandlerContext): void {
  const { mainWindow } = ctx

  ipcMainHandle('get-font-settings', async () => {
    return getFontSettings()
  })

  ipcMainHandle('save-font-selections', async (_event, selections: any) => {
    return saveFontSelections(selections)
  })

  ipcMainHandle('list-system-fonts', async () => {
    return listSystemFonts()
  })

  ipcMainHandle('import-font-file', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'Fonts', extensions: ['ttf', 'otf', 'woff', 'woff2'] },
      ],
    })

    if (result.canceled || !result.filePaths[0]) {
      return null
    }

    return importFontFile(result.filePaths[0])
  })

  ipcMainHandle('delete-imported-font', async (_event, fontId: string) => {
    return deleteImportedFont(fontId)
  })
}
