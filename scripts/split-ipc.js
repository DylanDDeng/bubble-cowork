/**
 * IPC 拆分脚本
 *
 * 读取 ipc-handlers.ts，将其拆分为 14 个模块文件，
 * 并输出新的瘦身版 ipc-handlers.ts
 */

const fs = require('fs')
const path = require('path')

const SRC = '/Users/chengshengdeng/coworker/src/electron'
const INPUT = path.join(SRC, 'ipc-handlers.ts')
const OUTPUT_DIR = path.join(SRC, 'ipc')

const content = fs.readFileSync(INPUT, 'utf8')
const lines = content.split('\n')

// ================================================================
// 1. 确定模块边界
// ================================================================

// 行 1-104: imports
// 行 105-160: 常量 (SEARCH_GLOBS, ATTACHMENT_MIME_TYPES, LOCAL_PREVIEW_MIME_TYPES, KEEP_ALIVE_TIMEOUT, MAX_CONCURRENT_TASKS)
// 行 160-400: terminal 辅助函数 + terminalSessions Map (198)
// 行 400-500: broadcast 函数定义等
// 行 ~2800-3120: agents 辅助函数
// 行 3120-3243: channel 辅助函数
// 行 3243-4909: setupIPCHandlers 中的 ipcMainHandle 处理器 (85个)
// 行 3243-3280: setupIPCHandlers 开头 (变量定义、client-event 监听)
// 行 4910-5200: handleClientEvent + handleSessionList + broadcastProfileSnapshots 等
// 行 5200-7760: 更多 handle 函数 (handleSessionStart, handleSessionContinue, etc.)
// 行 7760-7787: export function cleanup()

// ================================================================
// 2. 提取各个 section 的行号范围
// ================================================================

// 从已知 handler 列表提取行号范围
function findHandlerRange(startLine, channelName) {
  let i = startLine
  while (i < lines.length && !lines[i].includes("ipcMainHandle('" + channelName + "'")) {
    i++
  }
  if (i >= lines.length) return null

  // 找到函数的结束：匹配括号
  let depth = 0
  let start = i
  for (let j = i; j < lines.length; j++) {
    const line = lines[j]
    for (const ch of line) {
      if (ch === '{') depth++
      if (ch === '}') depth--
    }
    if (depth < 0) {
      return { start: i + 1, end: j + 1 }
    }
    if (depth === 0 && j > i && line.trim().startsWith('}')) {
      // actually should be } followed by ) or ;
      if (line.includes('})') || line.includes('});')) {
        return { start: i + 1, end: j + 1 }
      }
    }
  }
  return { start: i + 1, end: i + 3 } // fallback
}

// 手动定义所有模块的边界
const modules = {
  'terminal.ts': {
    helpers: lines.slice(198, 401),  // terminalSessions + helper functions
    handlers: lines.slice(3287, 3349),  // terminal IPC handlers
  },
}

// ================================================================
// 3. 生成终端模块文件
// ================================================================

console.log('Module boundaries:')
console.log('  Terminal helpers: 198-401')
console.log('  Terminal handlers: 3287-3349')
console.log('')
console.log('For now, printing info about file structure...')

// 输出 setupIPCHandlers 内部关键区域
let inSetup = false
let setupStart = 0
let setupEnd = 0
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('export function setupIPCHandlers')) {
    inSetup = true
    setupStart = i + 1
  }
  if (inSetup && lines[i].includes('export function cleanup()')) {
    setupEnd = i + 1
    break
  }
}

console.log('')
console.log('setupIPCHandlers: lines ' + setupStart + ' - ' + setupEnd)
console.log('Total file lines: ' + lines.length)
console.log('')
console.log('Compact structure:')
console.log('  1-104: imports')
console.log('  105-160: shared constants')
console.log('  160-401: terminal helper functions + terminalSessions')
console.log('  402-3242: other helper functions (broadcast, runner, agents, channel, mcp, files, skills, folders, profiles, search, settings helpers)')
console.log('  3243-4909: ipcMainHandle handlers (85 handlers)')
console.log('  4910-7769: handleClientEvent + handle functions')
console.log('  7770-7787: export function cleanup()')
console.log('')

// 列出所有 helper 函数定义（setupIPCHandlers 之前）
console.log('Helper functions (before setupIPCHandlers):')
for (let i = 0; i < setupStart - 1; i++) {
  const line = lines[i]
  if (/^(export )?(async )?function /.test(line.trim())) {
    const name = line.match(/function (\w+)/)
    if (name) {
      console.log('  Line ' + (i + 1) + ': ' + name[1])
    }
  }
}
