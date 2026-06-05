/**
 * IPC 共享上下文
 *
 * 所有 IPC handler 模块需要的共享状态和依赖。
 * 每个模块通过 register(context) 接收此对象。
 */

import { BrowserWindow } from 'electron'
import * as http from 'http'

// --- 第三方导入（由各模块按需 import） ---
// 以下类型在此声明以便 context 中使用：

export interface LocalPreviewServer {
  server: http.Server
  port: number
}

export interface RunnerHandle {
  handle: any
  onTurnDone?: () => Promise<void>
}

export interface SessionStateEntry {
  pendingPermissions?: Map<string, any>
}

export interface RoutedAgentSequence {
  cancelled: boolean
}

/**
 * 完整的 IPC handler 上下文。
 * 每个模块的 register(context) 只访问它需要的字段。
 */
export interface IPCHandlerContext {
  /** 主窗口引用 */
  mainWindow: BrowserWindow

  // --- 模块级可变状态 ---
  localPreviewServers: Map<string, LocalPreviewServer>
  runnerHandles: Map<string, RunnerHandle>
  sessionStates: Map<string, SessionStateEntry>
  activeRoutedAgentSequences: Map<string, RoutedAgentSequence>

  // --- 工具函数（set in factory） ---
  broadcast: (type: string, payload: any) => void
  broadcastFolderChanged: () => void

  // --- 常量 ---
  ATTACHMENT_MIME_TYPES: Set<string>
  LOCAL_PREVIEW_MIME_TYPES: Set<string>
  SEARCH_GLOBS: string[]
  MAX_CONCURRENT_TASKS: number
  KEEP_ALIVE_TIMEOUT: number
}

/**
 * 创建 IPC handler 上下文对象（在 setupIPCHandlers 中调用）。
 * 注意：sessions / folderConfig / settingsManager 等单例模块
 * 在各 ipc/ 模块中直接 import，不通过 context 传递。
 */
export function createIPCHandlerContext(mainWindow: BrowserWindow): IPCHandlerContext {
  const localPreviewServers = new Map<string, LocalPreviewServer>()
  const runnerHandles = new Map<string, RunnerHandle>()
  const sessionStates = new Map<string, SessionStateEntry>()
  const activeRoutedAgentSequences = new Map<string, RoutedAgentSequence>()

  const ATTACHMENT_MIME_TYPES = new Set([
    'text/plain', 'text/markdown', 'text/tsx', 'text/typescript',
    'text/javascript', 'text/html', 'text/css', 'text/json',
    'text/x-sh', 'text/x-python', 'text/x-rust', 'text/x-go',
    'text/x-java', 'text/x-c', 'text/x-c++src',
  ])

  const LOCAL_PREVIEW_MIME_TYPES = new Set([
    'text/html', 'image/png', 'image/jpeg', 'image/gif',
    'image/svg+xml', 'text/plain', 'text/markdown', 'application/pdf',
  ])

  const SEARCH_GLOBS = [
    '**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx',
    '**/*.json', '**/*.md', '**/*.mdx',
    '**/*.css', '**/*.scss', '**/*.html',
    '**/*.py', '**/*.rs', '**/*.go',
    '**/*.java', '**/*.c', '**/*.cpp', '**/*.h',
    '**/*.yaml', '**/*.yml', '**/*.toml',
    '**/*.xml', '**/*.sql', '**/*.graphql',
    '**/*.sh', '**/*.bash', '**/*.zsh',
    '**/*.Dockerfile', '**/Dockerfile',
  ]

  const broadcast = (type: string, payload: any): void => {
    mainWindow.webContents.send('main-message', { type, payload })
  }

  const broadcastFolderChanged = (): void => {
    broadcast('folder.changed', {})
  }

  return {
    mainWindow,
    localPreviewServers,
    runnerHandles,
    sessionStates,
    activeRoutedAgentSequences,
    broadcast,
    broadcastFolderChanged,
    ATTACHMENT_MIME_TYPES,
    LOCAL_PREVIEW_MIME_TYPES,
    SEARCH_GLOBS,
    MAX_CONCURRENT_TASKS: 8,
    KEEP_ALIVE_TIMEOUT: 60000,
  }
}
