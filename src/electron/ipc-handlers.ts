import { ipcMain, BrowserWindow, dialog } from 'electron';
import * as sessions from './libs/session-store';
import { runClaude } from './libs/runner';
import { generateSessionTitle } from './libs/util';
import { loadClaudeSettings } from './libs/claude-settings';
import { ipcMainHandle } from './util';
import type {
  ClientEvent,
  ServerEvent,
  SessionInfo,
  RunnerHandle,
  SessionState,
  PermissionResult,
  SessionStartPayload,
  SessionContinuePayload,
  PermissionResponsePayload,
  AskUserQuestionInput,
} from './types';

// Runner 句柄映射
const runnerHandles = new Map<string, RunnerHandle>();

// 会话状态映射（包含 pending permissions）
const sessionStates = new Map<string, SessionState>();

// 获取或创建会话状态
function getSessionState(sessionId: string): SessionState {
  let state = sessionStates.get(sessionId);
  if (!state) {
    state = { pendingPermissions: new Map() };
    sessionStates.set(sessionId, state);
  }
  return state;
}

// 广播事件到渲染进程
function broadcast(mainWindow: BrowserWindow, event: ServerEvent): void {
  mainWindow.webContents.send('server-event', JSON.stringify(event));
}

// 初始化 IPC 处理器
export function setupIPCHandlers(mainWindow: BrowserWindow): void {
  // 初始化数据库
  sessions.initialize();

  // 加载 Claude 配置
  loadClaudeSettings();

  // 处理客户端事件
  ipcMain.on('client-event', async (_, eventJson: string) => {
    try {
      const event: ClientEvent = JSON.parse(eventJson);
      await handleClientEvent(mainWindow, event);
    } catch (error) {
      console.error('Error handling client event:', error);
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: { message: String(error) },
      });
    }
  });

  // RPC: 生成会话标题
  ipcMainHandle('generate-session-title', async (_, prompt: string) => {
    return generateSessionTitle(prompt);
  });

  // RPC: 获取最近工作目录
  ipcMainHandle('get-recent-cwds', async (_, limit?: number) => {
    return sessions.listRecentCwds(limit);
  });

  // RPC: 选择目录
  ipcMainHandle('select-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
}

// 处理客户端事件
async function handleClientEvent(
  mainWindow: BrowserWindow,
  event: ClientEvent
): Promise<void> {
  switch (event.type) {
    case 'session.list':
      handleSessionList(mainWindow);
      break;

    case 'session.start':
      await handleSessionStart(mainWindow, event.payload);
      break;

    case 'session.continue':
      await handleSessionContinue(mainWindow, event.payload);
      break;

    case 'session.history':
      handleSessionHistory(mainWindow, event.payload.sessionId);
      break;

    case 'session.stop':
      handleSessionStop(mainWindow, event.payload.sessionId);
      break;

    case 'session.delete':
      handleSessionDelete(mainWindow, event.payload.sessionId);
      break;

    case 'permission.response':
      handlePermissionResponse(event.payload);
      break;
  }
}

// 会话列表
function handleSessionList(mainWindow: BrowserWindow): void {
  const rows = sessions.listSessions();
  const sessionInfos: SessionInfo[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status as SessionInfo['status'],
    cwd: row.cwd || undefined,
    claudeSessionId: row.claude_session_id || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  broadcast(mainWindow, {
    type: 'session.list',
    payload: { sessions: sessionInfos },
  });
}

// 新建会话
async function handleSessionStart(
  mainWindow: BrowserWindow,
  payload: SessionStartPayload
): Promise<void> {
  const { title, prompt, cwd, allowedTools } = payload;

  // 创建会话
  const session = sessions.createSession({
    title,
    cwd,
    allowedTools,
    prompt,
  });

  // 更新状态为 running
  sessions.updateSessionStatus(session.id, 'running');

  // 广播状态
  broadcast(mainWindow, {
    type: 'session.status',
    payload: {
      sessionId: session.id,
      status: 'running',
      title: session.title,
      cwd: session.cwd || undefined,
    },
  });

  // 广播用户 prompt
  broadcast(mainWindow, {
    type: 'stream.user_prompt',
    payload: { sessionId: session.id, prompt },
  });

  // 保存 user_prompt 到消息历史
  sessions.addMessage(session.id, { type: 'user_prompt', prompt });

  // 启动 Runner
  startRunner(mainWindow, session, prompt);
}

// 继续会话
async function handleSessionContinue(
  mainWindow: BrowserWindow,
  payload: SessionContinuePayload
): Promise<void> {
  const { sessionId, prompt } = payload;

  const session = sessions.getSession(sessionId);
  if (!session) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'Unknown session', sessionId },
    });
    return;
  }

  if (!session.claude_session_id) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'Session has no resume id yet.', sessionId },
    });
    return;
  }

  // 更新状态
  sessions.updateSessionStatus(sessionId, 'running');
  sessions.updateLastPrompt(sessionId, prompt);

  // 广播状态
  broadcast(mainWindow, {
    type: 'session.status',
    payload: { sessionId, status: 'running' },
  });

  // 广播用户 prompt
  broadcast(mainWindow, {
    type: 'stream.user_prompt',
    payload: { sessionId, prompt },
  });

  // 保存 user_prompt
  sessions.addMessage(sessionId, { type: 'user_prompt', prompt });

  // 启动 Runner（带 resume）
  startRunner(mainWindow, session, prompt, session.claude_session_id);
}

// 启动 Runner
function startRunner(
  mainWindow: BrowserWindow,
  session: ReturnType<typeof sessions.getSession>,
  prompt: string,
  resumeSessionId?: string
): void {
  if (!session) return;

  const sessionState = getSessionState(session.id);

  const handle = runClaude({
    prompt,
    session,
    resumeSessionId,
    onMessage: (message) => {
      // 提取并保存 claude session id
      if (message.type === 'system' && message.subtype === 'init') {
        sessions.updateClaudeSessionId(session.id, message.session_id);
      }

      // 保存消息
      sessions.addMessage(session.id, message);

      // 广播消息
      broadcast(mainWindow, {
        type: 'stream.message',
        payload: { sessionId: session.id, message },
      });

      // 检查是否为 result 消息，更新状态
      if (message.type === 'result') {
        const status = message.subtype === 'success' ? 'completed' : 'error';
        sessions.updateSessionStatus(session.id, status);
        broadcast(mainWindow, {
          type: 'session.status',
          payload: { sessionId: session.id, status },
        });

        // 清理
        runnerHandles.delete(session.id);
      }
    },
    onPermissionRequest: async (toolUseId, toolName, input) => {
      // 广播权限请求
      broadcast(mainWindow, {
        type: 'permission.request',
        payload: {
          sessionId: session.id,
          toolUseId,
          toolName,
          input: input as AskUserQuestionInput,
        },
      });

      // 等待用户响应
      return new Promise<PermissionResult>((resolve, reject) => {
        sessionState.pendingPermissions.set(toolUseId, { resolve, reject });
      });
    },
  });

  runnerHandles.set(session.id, handle);
}

// 获取会话历史
function handleSessionHistory(mainWindow: BrowserWindow, sessionId: string): void {
  const session = sessions.getSession(sessionId);
  if (!session) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'Unknown session', sessionId },
    });
    return;
  }

  const messages = sessions.getSessionHistory(sessionId);

  broadcast(mainWindow, {
    type: 'session.history',
    payload: {
      sessionId,
      status: session.status as SessionInfo['status'],
      messages,
    },
  });
}

// 停止会话
function handleSessionStop(mainWindow: BrowserWindow, sessionId: string): void {
  const handle = runnerHandles.get(sessionId);
  if (handle) {
    handle.abort();
    runnerHandles.delete(sessionId);
  }

  // 拒绝所有 pending permissions
  const state = sessionStates.get(sessionId);
  if (state) {
    for (const [, { reject }] of state.pendingPermissions) {
      reject(new Error('Session aborted'));
    }
    state.pendingPermissions.clear();
  }

  // 更新状态为 idle（stop 不算 error）
  sessions.updateSessionStatus(sessionId, 'idle');

  broadcast(mainWindow, {
    type: 'session.status',
    payload: { sessionId, status: 'idle' },
  });
}

// 删除会话
function handleSessionDelete(mainWindow: BrowserWindow, sessionId: string): void {
  // 先停止运行中的会话
  const handle = runnerHandles.get(sessionId);
  if (handle) {
    handle.abort();
    runnerHandles.delete(sessionId);
  }

  // 清理状态
  sessionStates.delete(sessionId);

  // 删除数据库记录
  sessions.deleteSession(sessionId);

  // 广播删除事件（幂等）
  broadcast(mainWindow, {
    type: 'session.deleted',
    payload: { sessionId },
  });
}

// 处理权限响应
function handlePermissionResponse(
  payload: PermissionResponsePayload
): void {
  const { sessionId, toolUseId, result } = payload;

  const state = sessionStates.get(sessionId);
  if (!state) return;

  const pending = state.pendingPermissions.get(toolUseId);
  if (pending) {
    pending.resolve(result);
    state.pendingPermissions.delete(toolUseId);
  }
}

// 清理资源
export function cleanup(): void {
  // 停止所有运行中的 runner
  for (const [, handle] of runnerHandles) {
    handle.abort();
  }
  runnerHandles.clear();
  sessionStates.clear();

  // 关闭数据库
  sessions.close();
}
