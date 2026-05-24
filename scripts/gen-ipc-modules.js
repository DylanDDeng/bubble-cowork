/**
 * 批量生成 IPC 模块文件
 * 从 ipc-handlers.ts 提取各个 handler 模块
 */
const fs = require('fs')

const SRC = '/Users/chengshengdeng/coworker/src/electron'
const content = fs.readFileSync(SRC + '/ipc-handlers.ts', 'utf8')
const lines = content.split('\n')

// 提取行范围的辅助函数
function extractLines(startLine, endLine) {
  return lines.slice(startLine - 1, endLine).join('\n')
}

// 从导入找到哪个模块导出了什么符号
const importMap = {
  'getCodexModelConfig': './libs/codex-settings',
  'saveCodexModelVisibility': './libs/codex-settings',
  'getCodexRuntimeStatus': './libs/codex-runtime-status',
  'getCodexUsageReport': './libs/codex-usage-report',
  'getCodexComposerCapabilities': './libs/codex-composer-capabilities',
  'codexListPlugins': './libs/codex-plugin-manager',
  'codexReadPlugin': './libs/codex-plugin-manager',
  'codexListSkills': './libs/codex-skills',
  'getOpencodeModelConfig': './libs/opencode-settings',
  'saveOpencodeModelVisibility': './libs/opencode-settings',
  'getOpencodeRuntimeStatus': './libs/opencode-runtime-status',
  'getOpencodeUsageReport': './libs/opencode-usage-report',
  'getClaudeModelConfig': './libs/claude-settings',
  'saveClaudeCompatibleProviderConfig': './libs/claude-settings',
  'getClaudeCompatibleProviderConfig': './libs/claude-settings',
  'getClaudeUsageReport': './libs/claude-usage-report',
  'getClaudeRuntimeStatus': './libs/claude-runtime-status',
  'getClaudeRuntimeStatusCached': './libs/claude-runtime-status',
  'formatClaudeRuntimeBlockingMessage': './libs/claude-runtime-status',
  'invalidateClaudeRuntimeCache': './libs/claude-runtime-status',
  'getAegisBuiltinAgentConfig': './libs/builtin-agent-manager',
  'saveAegisBuiltinAgentConfig': './libs/builtin-agent-manager',
  'listAegisSkillsForProvider': './libs/builtin-agent/skills/manager',
  'getPromptLibrary': './libs/prompt-library',
  'savePromptLibraryItem': './libs/prompt-library',
  'deletePromptLibraryItem': './libs/prompt-library',
  'importPromptLibrary': './libs/prompt-library',
  'exportPromptLibrary': './libs/prompt-library',
  'getFeishuBridgeStatus': './libs/feishu-bridge',
  'startFeishuBridge': './libs/feishu-bridge',
  'stopFeishuBridge': './libs/feishu-bridge',
  'getMemoryWorkspace': './libs/memory-store',
  'saveMemoryDocument': './libs/memory-store',
  'getFontSettings': './libs/font-manager',
  'saveFontSelections': './libs/font-manager',
  'listSystemFonts': './libs/font-manager',
  'importFontFile': './libs/font-manager',
  'deleteImportedFont': './libs/font-manager',
  'loadSkillMarketHot': './libs/skill-market',
  'searchSkillMarket': './libs/skill-market',
  'getSkillMarketDetail': './libs/skill-market',
  'installSkillFromMarket': './libs/skill-market',
}

// 对于每个 handler block，找出它引用的导入符号
function findUsedImports(code) {
  const used = new Set()
  for (const [name, importPath] of Object.entries(importMap)) {
    if (code.includes(name)) {
      used.add(`import { ${name} } from '${importPath}'`)
    }
  }
  if (code.includes('dialog.')) used.add("import { dialog, BrowserWindow } from 'electron'")
  if (code.includes('shell.')) used.add("import { shell } from 'electron'")
  if (code.includes('execFile')) used.add("import { execFile } from 'child_process'")

  return Array.from(used)
}

// 生成模块文件内容
function generateModuleFile(modName, startLine, endLine) {
  const code = extractLines(startLine, endLine)
  const usedImports = findUsedImports(code)

  const defaultImports = [
    "import { ipcMainHandle } from '../util'",
    "import { IPCHandlerContext } from './context'",
  ]

  const allImports = [...defaultImports, ...usedImports]
    .filter((v, i, a) => a.indexOf(v) === i)
    .join('\n')

  const needsCtx = code.includes('mainWindow') || code.includes('dialog.') || code.includes('shell.')
  const registerParam = needsCtx ? 'ctx: IPCHandlerContext' : '_ctx: IPCHandlerContext'

  let destructureCtx = ''
  if (needsCtx) {
    const parts = []
    if (code.includes('mainWindow')) parts.push('mainWindow')
    destructureCtx = parts.length > 0 ? `  const { ${parts.join(', ')} } = ctx\n` : ''
  }

  const header = `/**\n * ${modName} 模块\n *\n * 从 ipc-handlers.ts 自动提取\n */\n\n`
  return header + allImports + `\n\nexport function register(${registerParam}): void {\n${destructureCtx}${code}\n}\n`
}

// 提取 ipcMainHandle 块（从某行开始找到匹配的 });）
function extractHandlerBlock(startLine) {
  let depth = 0
  let found = false
  for (let i = startLine - 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.includes("ipcMainHandle('") && !found) {
      found = true
    }
    if (found) {
      for (const ch of line) {
        if (ch === '{') depth++
        if (ch === '}') depth--
        if (ch === '(') depth++
        if (ch === ')') depth--
      }
      if (depth <= 0 && found && (line.includes(');') || line.includes('})'))) {
        return { start: startLine, end: i + 1 }
      }
    }
  }
  return { start: startLine, end: startLine + 5 }
}

// 输出所有模块
const modules = [
  { name: 'prompt-library', range: [3463, 3504] },
  { name: 'skill-market', range: [3592, 3612] },
  { name: 'memory', range: [3641, 3648] },
  { name: 'font', range: [3658, 3695] },
]

for (const mod of modules) {
  const content = generateModuleFile(mod.name, mod.range[0], mod.range[1])
  // 修复导入路径：从 src/electron/ipc/ 到 src/electron/libs/
  // 所有 './libs/' 需要变成 '../libs/'
  const fixed = content.replace(/from '\.\/libs\//g, "from '../libs/")
  const outPath = SRC + '/ipc/' + mod.name + '.ts'
  fs.writeFileSync(outPath, fixed)
  console.log('Generated: ' + outPath + ' (' + fixed.split('\n').length + ' lines)')
}

console.log('\nDone!')
