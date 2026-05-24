/**
 * Prompt Library 模块
 *
 * 管理提示词库的 CRUD 操作和导入导出。
 */

import { ipcMainHandle } from '../util'
import { IPCHandlerContext } from './context'
import {
  listPromptLibraryItems,
  savePromptLibraryItem,
  deletePromptLibraryItem,
  importPromptLibraryFile,
  exportPromptLibraryFile,
} from '../libs/prompt-library'
import type { UpsertPromptLibraryItemInput } from '../../shared/types'
import { dialog } from 'electron'

export function register(ctx: IPCHandlerContext): void {
  const { mainWindow } = ctx

  ipcMainHandle('get-prompt-library', async () => {
    return listPromptLibraryItems()
  })

  ipcMainHandle('save-prompt-library-item', async (_event, input: UpsertPromptLibraryItemInput) => {
    return savePromptLibraryItem(input)
  })

  ipcMainHandle('delete-prompt-library-item', async (_event, id: string) => {
    return deletePromptLibraryItem(id)
  })

  ipcMainHandle('import-prompt-library', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'JSON', extensions: ['json'] },
      ],
    })

    if (result.canceled || !result.filePaths[0]) {
      return {
        items: listPromptLibraryItems(),
        importedCount: 0,
        skippedCount: 0,
        filePath: null,
      }
    }

    return importPromptLibraryFile(result.filePaths[0])
  })

  ipcMainHandle('export-prompt-library', async () => {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: 'prompt-library.json',
      filters: [
        { name: 'JSON', extensions: ['json'] },
      ],
    })

    if (result.canceled || !result.filePath) {
      return { ok: false, exportedCount: 0, filePath: null }
    }

    return exportPromptLibraryFile(result.filePath)
  })
}
