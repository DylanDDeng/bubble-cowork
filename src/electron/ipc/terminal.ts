/**
 * Terminal 管理模块
 *
 * 处理 PTY 终端会话的创建、读写、调整大小和销毁。
 */

import { app, BrowserWindow } from 'electron'
import { spawn as spawnPty, IPty } from 'node-pty'
import { existsSync, chmodSync } from 'fs'
import { join, dirname } from 'path'
import { ipcMainHandle, isDev } from '../util'
import { IPCHandlerContext, TerminalSession } from './context'

let terminalHelperPrepared = false

function ensureNodePtyHelpersExecutable(): void {
  if (process.platform === 'win32') {
    return
  }

  try {
    const baseDir = join(app.getAppPath(), 'node_modules', 'node-pty')
    const archDir = `${process.platform}-${process.arch}`
    const candidatePaths = [
      join(baseDir, 'prebuilds', archDir, 'spawn-helper'),
      join(baseDir, 'build', 'Release', 'spawn-helper'),
    ]

    for (const helperPath of candidatePaths) {
      if (existsSync(helperPath)) {
        chmodSync(helperPath, 0o755)
      }
    }

    // Fallback: in dev, node-pty may resolve to a different location.
    try {
      const helperDir = join(dirname(require.resolve('node-pty')), 'build', 'Release')
      const fullPath = join(helperDir, 'spawn-helper')
      if (existsSync(fullPath)) {
        chmodSync(fullPath, 0o755)
      }
    } catch {
      // ignore
    }
  } catch (error) {
    if (isDev()) {
      console.warn('[Terminal] Failed to mark node-pty helper executable:', error)
    }
  }
}

type TerminalEventPayload = {
  type: 'data' | 'exit'
  sessionId: string
  data?: string
  exitCode?: number | null
}

const TERMINAL_HISTORY_MAX_CHARS = 200_000

function emitTerminalEvent(mainWindow: BrowserWindow, payload: TerminalEventPayload): void {
  if (mainWindow.isDestroyed()) {
    return
  }
  mainWindow.webContents.send('terminal-event', JSON.stringify(payload))
}

function appendTerminalHistory(
  mainWindow: BrowserWindow,
  terminalSessions: Map<string, TerminalSession>,
  sessionId: string,
  data: string
): void {
  const existing = terminalSessions.get(sessionId)
  if (!existing) return
  existing.history += data
  if (existing.history.length > TERMINAL_HISTORY_MAX_CHARS) {
    existing.history = existing.history.slice(existing.history.length - TERMINAL_HISTORY_MAX_CHARS)
  }
  emitTerminalEvent(mainWindow, {
    type: 'data',
    sessionId,
    data,
  })
}

function prepareTerminalHelpers(): void {
  if (terminalHelperPrepared) return
  ensureNodePtyHelpersExecutable()
  terminalHelperPrepared = true
}

function getTerminalLaunchSpecs(): { command: string; args: string[] }[] {
  const envShell = process.env.SHELL?.trim()
  const shells: { command: string; args: string[] }[] = []

  if (envShell && existsSync(envShell)) {
    shells.push({ command: envShell, args: [] })
  }

  if (process.platform === 'win32') {
    shells.push({ command: 'cmd.exe', args: [] })
    shells.push({ command: 'powershell.exe', args: [] })
  } else {
    shells.push({ command: '/bin/bash', args: [] })
    shells.push({ command: '/bin/zsh', args: [] })
  }

  return shells
}

function disposeTerminalSession(
  terminalSessions: Map<string, TerminalSession>,
  sessionId: string
): void {
  const existing = terminalSessions.get(sessionId)
  if (!existing) {
    return
  }

  existing.process.kill()
  terminalSessions.delete(sessionId)
}

function createTerminalSession(
  mainWindow: BrowserWindow,
  terminalSessions: Map<string, TerminalSession>,
  sessionId: string,
  cwd: string
): { ok: boolean; history?: string; message?: string } {
  if (!terminalHelperPrepared) {
    prepareTerminalHelpers()
  }

  const existing = terminalSessions.get(sessionId)
  if (existing) {
    // Reuse the live PTY. Switching back to a previously-opened tab must NOT kill its process.
    return { ok: true, history: existing.history }
  }

  const specs = getTerminalLaunchSpecs()
  const env = Object.assign({}, process.env)

  let spawned: IPty | null = null
  let lastError: unknown = null

  for (const launch of specs) {
    try {
      spawned = spawnPty(launch.command, launch.args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        cwd,
        env,
      })
      break
    } catch (error) {
      if (isDev()) {
        console.warn('[Terminal] Failed to spawn shell', {
          command: launch.command,
          args: launch.args,
          error,
        })
      }
      lastError = error
    }
  }

  if (!spawned) {
    const detail =
      lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown')
    return { ok: false, message: `Failed to spawn shell: ${detail}` }
  }

  terminalSessions.set(sessionId, { process: spawned, history: '' } as TerminalSession)

  spawned.onData((data: string) => {
    appendTerminalHistory(mainWindow, terminalSessions, sessionId, data)
  })

  spawned.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
    emitTerminalEvent(mainWindow, {
      type: 'exit',
      sessionId,
      exitCode,
    })
    void signal
    disposeTerminalSession(terminalSessions, sessionId)
  })

  return { ok: true, history: '' }
}

export function register(ctx: IPCHandlerContext): void {
  const { mainWindow, terminalSessions } = ctx

  ipcMainHandle(
    'start-terminal-session',
    async (_event, sessionId: string, cwd: string, cols?: number, rows?: number) => {
      const normalizedSessionId = sessionId.trim()
      const normalizedCwd = cwd.trim()
      if (!normalizedSessionId || !normalizedCwd) {
        return { ok: false, message: 'Missing terminal session id or cwd.' }
      }
      const result = createTerminalSession(mainWindow, terminalSessions, normalizedSessionId, normalizedCwd)
      if (!result.ok) {
        return { ok: false, message: result.message ?? 'Failed to create terminal session.' }
      }
      return { ok: true, history: result.history ?? '' }
    }
  )

  ipcMainHandle('write-terminal-session', async (_event, sessionId: string, data: string) => {
    const existing = terminalSessions.get(sessionId)
    if (!existing) {
      return { ok: false, message: 'Terminal session is not running.' }
    }
    existing.process.write(data)
    return { ok: true }
  })

  ipcMainHandle('stop-terminal-session', async (_event, sessionId: string) => {
    disposeTerminalSession(terminalSessions, sessionId)
    return { ok: true }
  })

  ipcMainHandle(
    'resize-terminal-session',
    async (_event, sessionId: string, cols: number, rows: number) => {
      const existing = terminalSessions.get(sessionId)
      if (!existing) {
        return { ok: false, message: 'Terminal session is not running.' }
      }
      existing.process.resize(Math.max(40, Math.round(cols)), Math.max(12, Math.round(rows)))
      return { ok: true }
    }
  )
}
