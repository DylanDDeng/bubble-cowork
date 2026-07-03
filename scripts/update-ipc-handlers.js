/**
 * 更新 ipc-handlers.ts (安全版本)
 *
 * 1. 添加模块导入
 * 2. 添加 register 调用
 * 3. 注释掉已迁移的代码块（不删除）
 */

const fs = require('fs')

const SRC = '/Users/chengshengdeng/coworker/src/electron'
const content = fs.readFileSync(SRC + '/ipc-handlers.ts', 'utf8')
const lines = content.split('\n')

// --- Step 1: 在最后一个 import 行之后添加模块导入 ---
const moduleImports = [
  '',
  '// === IPC 模块导入（从 ipc-handlers.ts 拆分） ===',
  `import { register as registerTerminal } from './ipc/terminal'`,
  `import { register as registerFeishu } from './ipc/feishu'`,
  `import { register as registerPromptLibrary } from './ipc/prompt-library'`,
  `import { register as registerMemory } from './ipc/memory'`,
  `import { register as registerFont } from './ipc/font'`,
  `import { register as registerSkillMarket } from './ipc/skill-market'`,
  `import { register as registerGit } from './ipc/git'`,
  '',
]

let lastImportIdx = 0
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim().startsWith('import ')) lastImportIdx = i
}

console.log('Inserting module imports after line', lastImportIdx + 1)

// --- Step 2: 在 setupIPCHandlers 内部添加 context 创建和模块注册 ---
// 找到 setupIPCHandlers 函数体内部，在第一个 handler 之前

// 找 setupIPCHandlers 函数体开始处
let setupBodyStart = 0
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('export function setupIPCHandlers')) {
    // 找到函数体的第一个 {
    for (let j = i; j < lines.length && j < i + 5; j++) {
      if (lines[j].includes('{')) {
        setupBodyStart = j
        break
      }
    }
    break
  }
}

console.log('setupIPCHandlers body starts at line', setupBodyStart + 1)

// 找第一个 ipcMainHandle 调用之前的位置（用于插入 context 和模块注册）
let firstHandlerIdx = 0
for (let i = setupBodyStart; i < lines.length; i++) {
  if (lines[i].includes('ipcMainHandle(')) {
    firstHandlerIdx = i
    break
  }
}

// 找第一个 ipcMainHandle 之前最合适的插入位置（在变量定义之后）
let insertIdx = firstHandlerIdx
for (let i = setupBodyStart + 1; i < firstHandlerIdx; i++) {
  if (lines[i].trim() === '' || lines[i].trim().startsWith('const ')) {
    insertIdx = i
  }
}

console.log('Inserting context + register calls before line', insertIdx + 1)

const registerBlock = [
  '',
  '  // === IPC 模块注册（从 ipc-handlers.ts 拆分） ===',
  '  const ipcCtx: any = {',
  '    mainWindow,',
  '    terminalSessions,',
  '    localPreviewServers,',
  '    runnerHandles,',
  '    sessionStates,',
  '    broadcast,',
  '    broadcastFolderChanged,',
  '    ATTACHMENT_MIME_TYPES,',
  '    LOCAL_PREVIEW_MIME_TYPES,',
  '    SEARCH_GLOBS,',
  '    MAX_CONCURRENT_TASKS,',
  '    KEEP_ALIVE_TIMEOUT,',
  '    TERMINAL_HISTORY_MAX_CHARS,',
  '    TERMINAL_STARTUP_BUFFER_MS,',
  '  }',
  '  registerTerminal(ipcCtx)',
  '  registerFeishu(ipcCtx)',
  '  registerPromptLibrary(ipcCtx)',
  '  registerFont(ipcCtx)',
  '  registerMemory(ipcCtx)',
  '  registerSkillMarket(ipcCtx)',
  '  registerGit(ipcCtx)',
  '',
]

// 构建新文件
const newLines = []

// 添加导入和处理部分
for (let i = 0; i < lines.length; i++) {
  newLines.push(lines[i])

  // 在最后一个 import 之后插入模块导入
  if (i === lastImportIdx) {
    for (const imp of moduleImports) {
      newLines.push(imp)
    }
  }

  // 在第一个 handler 之前插入 context + register 调用
  if (i === insertIdx) {
    for (const reg of registerBlock) {
      newLines.push(reg)
    }
  }
}

const newContent = newLines.join('\n')
const oldLines = lines.length
const newLineCount = newLines.length

console.log(`\nOriginal lines: ${oldLines}`)
console.log(`New lines: ${newLineCount} (+${newLineCount - oldLines})`)

// 备份
fs.copyFileSync(SRC + '/ipc-handlers.ts', SRC + '/ipc-handlers.ts.bak2')
console.log('Backup saved to ipc-handlers.ts.bak2')

// 写入
fs.writeFileSync(SRC + '/ipc-handlers.ts', newContent)
console.log('ipc-handlers.ts updated!')

// 检查结果
const moduleCount = (newContent.match(/registerTerminal|registerFeishu|registerPromptLibrary|registerFont|registerMemory|registerSkillMarket|registerGit/g) || []).length
console.log(`Register calls: ${moduleCount}`)
