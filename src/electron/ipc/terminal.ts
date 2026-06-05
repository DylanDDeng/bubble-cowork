import { ipcMainHandle } from '../util'
import { IPCHandlerContext } from './context'
import { attachTerminalWindow, terminalManager } from '../libs/terminal-runtime'
import { ensureTerminalTransportServer } from '../libs/terminal-transport-server'
import type {
  TerminalAgentKind,
  TerminalClearInput,
  TerminalCloseInput,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalWriteInput,
} from '../../shared/terminal'
import { DEFAULT_TERMINAL_ID } from '../../shared/terminal'

export function register(ctx: IPCHandlerContext): void {
  attachTerminalWindow(ctx.mainWindow)

  ipcMainHandle('terminal:open', async (_event, input: TerminalOpenInput) => {
    return terminalManager.open(input)
  })

  ipcMainHandle('terminal:write', async (_event, input: TerminalWriteInput) => {
    return terminalManager.write(input)
  })

  ipcMainHandle('terminal:resize', async (_event, input: TerminalResizeInput) => {
    return terminalManager.resize(input)
  })

  ipcMainHandle('terminal:clear', async (_event, input: TerminalClearInput) => {
    return terminalManager.clear(input)
  })

  ipcMainHandle('terminal:restart', async (_event, input: TerminalRestartInput) => {
    return terminalManager.restart(input)
  })

  ipcMainHandle('terminal:close', async (_event, input: TerminalCloseInput) => {
    return terminalManager.close(input)
  })

  ipcMainHandle('get-terminal-transport-info', async () => {
    return ensureTerminalTransportServer()
  })

  ipcMainHandle(
    'start-terminal-session',
    async (
      _event,
      sessionId: string,
      cwd: string,
      cols?: number,
      rows?: number,
      agentKind?: TerminalAgentKind
    ) => {
      return terminalManager.start({
        sessionId,
        cwd,
        cols,
        rows,
        agentKind,
      })
    }
  )

  ipcMainHandle('write-terminal-session', async (_event, sessionId: string, data: string) => {
    return terminalManager.write({ threadId: sessionId, terminalId: DEFAULT_TERMINAL_ID, data })
  })

  ipcMainHandle('stop-terminal-session', async (_event, sessionId: string) => {
    return terminalManager.close({ threadId: sessionId, terminalId: DEFAULT_TERMINAL_ID })
  })

  ipcMainHandle(
    'resize-terminal-session',
    async (_event, sessionId: string, cols: number, rows: number) => {
      return terminalManager.resize({ threadId: sessionId, terminalId: DEFAULT_TERMINAL_ID, cols, rows })
    }
  )
}
