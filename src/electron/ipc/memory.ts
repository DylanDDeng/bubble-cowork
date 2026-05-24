/**
 * memory 模块
 *
 * 从 ipc-handlers.ts 自动提取
 */

import { ipcMainHandle } from '../util'
import { IPCHandlerContext } from './context'
import { getMemoryWorkspace } from '../libs/memory-store'
import { saveMemoryDocument } from '../libs/memory-store'

export function register(_ctx: IPCHandlerContext): void {
  ipcMainHandle('get-memory-workspace', async (_event, projectCwd?: string | null) => {
    return getMemoryWorkspace(projectCwd);
  });

  ipcMainHandle('save-memory-document', async (_event, filePath: string, content: string) => {
    return saveMemoryDocument(filePath, content);
  });

}
