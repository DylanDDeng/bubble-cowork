import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { readFileSync, statSync, watch, type FSWatcher, promises as fsPromises } from 'fs';
import { basename, extname, resolve, relative, isAbsolute } from 'path';
import { v4 as uuidv4 } from 'uuid';
import * as sessions from './libs/session-store';
import { runClaude } from './libs/runner';
import { runCodex } from './libs/codex-runner';
import { generateSessionTitle } from './libs/util';
import { readProjectTree } from './libs/project-tree';
import { loadClaudeSettings, getClaudeSettings, getMcpServers, getGlobalMcpServers, getProjectMcpServers, saveMcpServers, saveProjectMcpServers, type McpServerConfig } from './libs/claude-settings';
import * as statusConfig from './libs/status-config';
import * as folderConfig from './libs/folder-config';
import { ipcMainHandle, isDev } from './util';
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
  Attachment,
  SessionStatus,
} from './types';
import type {
  CreateStatusInput,
  UpdateStatusInput,
  TodoState,
  FolderConfig,
} from '../shared/types';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_FILE_PREVIEW_BYTES = 5 * 1024 * 1024; // 5MB

const ATTACHMENT_MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.log': 'text/plain',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

const projectWatchers = new Map<
  string,
  { watcher: FSWatcher; timer?: NodeJS.Timeout }
>();

type ProjectFilePreview =
  | {
      kind: 'text' | 'markdown';
      path: string;
      name: string;
      ext: string;
      size: number;
      text: string;
      editable: boolean;
    }
  | {
      kind: 'image';
      path: string;
      name: string;
      ext: string;
      size: number;
      dataUrl: string;
    }
  | {
      kind: 'binary' | 'unsupported';
      path: string;
      name: string;
      ext: string;
      size: number;
    }
  | {
      kind: 'too_large';
      path: string;
      name: string;
      ext: string;
      size: number;
      maxBytes: number;
    }
  | {
      kind: 'error';
      path: string;
      name: string;
      ext: string;
      message: string;
    };

function isPathWithinRoot(rootPath: string, filePath: string): boolean {
  const root = resolve(rootPath);
  const target = resolve(filePath);
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

async function validateProjectFilePath(
  cwd: string,
  filePath: string
): Promise<{ ok: true; rootReal: string; targetReal: string } | { ok: false; message: string }> {
  if (!cwd || !filePath) {
    return { ok: false, message: 'Missing cwd or file path' };
  }

  if (!isPathWithinRoot(cwd, filePath)) {
    return { ok: false, message: 'File is outside the selected project folder' };
  }

  try {
    const [rootReal, targetReal] = await Promise.all([
      fsPromises.realpath(cwd),
      fsPromises.realpath(filePath),
    ]);
    if (!isPathWithinRoot(rootReal, targetReal)) {
      return { ok: false, message: 'File is outside the selected project folder' };
    }
    return { ok: true, rootReal, targetReal };
  } catch (error) {
    // realpath fails if file is missing; still keep the basic path containment check above.
    return { ok: true, rootReal: resolve(cwd), targetReal: resolve(filePath) };
  }
}

function getAttachmentSpec(filePath: string): { kind: Attachment['kind']; mimeType: string } | null {
  const ext = extname(filePath).toLowerCase();
  const mimeType = ATTACHMENT_MIME_TYPES[ext];
  if (!mimeType) {
    return null;
  }

  const kind: Attachment['kind'] = ext === '.png' || ext === '.jpg' || ext === '.jpeg' ? 'image' : 'file';
  return { kind, mimeType };
}

function toAttachment(filePath: string): Attachment | null {
  const spec = getAttachmentSpec(filePath);
  if (!spec) {
    return null;
  }

  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return null;
    }
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      return null;
    }

    return {
      id: uuidv4(),
      path: filePath,
      name: basename(filePath),
      size: stat.size,
      mimeType: spec.mimeType,
      kind: spec.kind,
    };
  } catch {
    return null;
  }
}

// Runner 句柄映射（带 Provider）
const runnerHandles = new Map<string, { handle: RunnerHandle; provider: 'claude' | 'codex' }>();

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
  // 检查窗口和 webContents 是否已销毁
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send('server-event', JSON.stringify(event));
}

async function emitProjectTree(mainWindow: BrowserWindow, cwd: string): Promise<void> {
  try {
    const tree = await readProjectTree(cwd);
    broadcast(mainWindow, { type: 'project.tree', payload: { cwd, tree } });
  } catch (error) {
    console.error('Failed to read project tree:', error);
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: `Failed to read project tree: ${String(error)}` },
    });
  }
}

function scheduleProjectTree(mainWindow: BrowserWindow, cwd: string): void {
  const entry = projectWatchers.get(cwd);
  if (!entry) return;
  if (entry.timer) {
    clearTimeout(entry.timer);
  }
  entry.timer = setTimeout(() => {
    emitProjectTree(mainWindow, cwd);
  }, 200);
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

  // RPC: 选择附件（文件/图片）
  ipcMainHandle('select-attachments', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Supported',
          extensions: ['txt', 'md', 'json', 'log', 'pdf', 'docx', 'png', 'jpg', 'jpeg'],
        },
      ],
    });

    if (result.canceled) {
      return [] as Attachment[];
    }

    const attachments: Attachment[] = [];
    let skipped = 0;

    for (const filePath of result.filePaths) {
      const attachment = toAttachment(filePath);
      if (attachment) {
        attachments.push(attachment);
      } else {
        skipped += 1;
      }
    }

    if (skipped > 0) {
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: {
          message: `Skipped ${skipped} file(s): only .txt/.md/.json/.log/.pdf/.docx/.png/.jpg are supported (<=10MB).`,
        },
      });
    }

    return attachments;
  });

  // RPC: 读取图片预览（data URL）
  ipcMainHandle('read-attachment-preview', async (_event, filePath: string) => {
    const spec = getAttachmentSpec(filePath);
    if (!spec || spec.kind !== 'image') {
      return null;
    }

    try {
      const stat = statSync(filePath);
      if (!stat.isFile() || stat.size > MAX_ATTACHMENT_BYTES) {
        return null;
      }
      const buffer = readFileSync(filePath);
      return `data:${spec.mimeType};base64,${buffer.toString('base64')}`;
    } catch {
      return null;
    }
  });

  // RPC: 获取项目文件树
  ipcMainHandle('get-project-tree', async (_event, cwd: string) => {
    if (!cwd) {
      return null;
    }
    return readProjectTree(cwd);
  });

  // RPC: 读取项目文件预览（安全：仅允许 cwd 内的文件，<=5MB）
  ipcMainHandle(
    'read-project-file-preview',
    async (_event, cwd: string, filePath: string): Promise<ProjectFilePreview> => {
      const resolved = resolve(filePath || '');
      const name = basename(resolved) || resolved;
      const ext = extname(resolved).toLowerCase();

      const validation = await validateProjectFilePath(cwd, resolved);
      if (!validation.ok) {
        return { kind: 'error', path: resolved, name, ext, message: validation.message };
      }

      let stat;
      try {
        stat = await fsPromises.stat(validation.targetReal);
      } catch (error) {
        return { kind: 'error', path: validation.targetReal, name, ext, message: 'File not found' };
      }

      if (!stat.isFile()) {
        return { kind: 'error', path: validation.targetReal, name, ext, message: 'Not a file' };
      }

      if (stat.size > MAX_FILE_PREVIEW_BYTES) {
        return {
          kind: 'too_large',
          path: validation.targetReal,
          name,
          ext,
          size: stat.size,
          maxBytes: MAX_FILE_PREVIEW_BYTES,
        };
      }

      // Images
      if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
        try {
          const buffer = await fsPromises.readFile(validation.targetReal);
          const mimeType = ATTACHMENT_MIME_TYPES[ext] || 'application/octet-stream';
          return {
            kind: 'image',
            path: validation.targetReal,
            name,
            ext,
            size: stat.size,
            dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
          };
        } catch (error) {
          return {
            kind: 'error',
            path: validation.targetReal,
            name,
            ext,
            message: `Failed to read image: ${String(error)}`,
          };
        }
      }

      // Markdown + text preview
      if (ext === '.md' || ext === '.txt' || ext === '.json' || ext === '.log') {
        try {
          const text = await fsPromises.readFile(validation.targetReal, 'utf8');
          return {
            kind: ext === '.md' ? 'markdown' : 'text',
            path: validation.targetReal,
            name,
            ext,
            size: stat.size,
            text,
            editable: ext === '.txt',
          };
        } catch (error) {
          return {
            kind: 'error',
            path: validation.targetReal,
            name,
            ext,
            message: `Failed to read file: ${String(error)}`,
          };
        }
      }

      // Binary files (open only)
      if (ext === '.pdf' || ext === '.docx') {
        return { kind: 'binary', path: validation.targetReal, name, ext, size: stat.size };
      }

      return { kind: 'unsupported', path: validation.targetReal, name, ext, size: stat.size };
    }
  );

  // RPC: 写入项目文本文件（仅允许写 .txt，安全：cwd 内，<=5MB）
  ipcMainHandle(
    'write-project-text-file',
    async (
      _event,
      cwd: string,
      filePath: string,
      content: string
    ): Promise<{ ok: true } | { ok: false; message: string }> => {
      const resolved = resolve(filePath || '');
      const ext = extname(resolved).toLowerCase();

      if (ext !== '.txt') {
        return { ok: false, message: 'Only .txt files are editable right now.' };
      }

      const validation = await validateProjectFilePath(cwd, resolved);
      if (!validation.ok) {
        return { ok: false, message: validation.message };
      }

      let stat;
      try {
        stat = await fsPromises.stat(validation.targetReal);
      } catch {
        return { ok: false, message: 'File not found' };
      }

      if (!stat.isFile()) {
        return { ok: false, message: 'Not a file' };
      }

      const bytes = Buffer.byteLength(content ?? '', 'utf8');
      if (bytes > MAX_FILE_PREVIEW_BYTES) {
        return { ok: false, message: 'File content is too large to save (max 5MB).' };
      }

      try {
        await fsPromises.writeFile(validation.targetReal, content ?? '', 'utf8');
        return { ok: true };
      } catch (error) {
        return { ok: false, message: `Failed to save file: ${String(error)}` };
      }
    }
  );

  // RPC: 用系统默认应用打开文件
  ipcMainHandle('open-path', async (_event, filePath: string) => {
    try {
      const errMsg = await shell.openPath(filePath);
      return errMsg ? { ok: false, message: errMsg } : { ok: true };
    } catch (error) {
      return { ok: false, message: String(error) };
    }
  });

  // RPC: 在文件管理器中展示文件
  ipcMainHandle('reveal-path', async (_event, filePath: string) => {
    try {
      shell.showItemInFolder(filePath);
      return { ok: true };
    } catch (error) {
      return { ok: false, message: String(error) };
    }
  });

  // RPC: 订阅项目文件树更新
  ipcMainHandle('watch-project-tree', async (_event, cwd: string) => {
    if (!cwd) {
      return false;
    }
    if (projectWatchers.has(cwd)) {
      scheduleProjectTree(mainWindow, cwd);
      return true;
    }
    try {
      const watcher = watch(
        cwd,
        { recursive: true },
        () => scheduleProjectTree(mainWindow, cwd)
      );
      projectWatchers.set(cwd, { watcher });
      scheduleProjectTree(mainWindow, cwd);
      return true;
    } catch (error) {
      console.error('Failed to watch project tree:', error);
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: { message: `Failed to watch project tree: ${String(error)}` },
      });
      return false;
    }
  });

  // RPC: 取消订阅项目文件树更新
  ipcMainHandle('unwatch-project-tree', async (_event, cwd: string) => {
    const entry = projectWatchers.get(cwd);
    if (entry) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      entry.watcher.close();
      projectWatchers.delete(cwd);
    }
    return true;
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

    case 'mcp.get-config':
      handleMcpGetConfig(mainWindow, event.payload?.projectPath);
      break;

    case 'mcp.save-config':
      handleMcpSaveConfig(mainWindow, event.payload);
      break;

    case 'session.setTodoState':
      handleSessionSetTodoState(mainWindow, event.payload);
      break;

    case 'session.togglePin':
      handleSessionTogglePin(mainWindow, event.payload);
      break;

    case 'status.list':
      handleStatusList(mainWindow);
      break;

    case 'status.create':
      handleStatusCreate(mainWindow, event.payload);
      break;

    case 'status.update':
      handleStatusUpdate(mainWindow, event.payload);
      break;

    case 'status.delete':
      handleStatusDelete(mainWindow, event.payload);
      break;

    case 'status.reorder':
      handleStatusReorder(mainWindow, event.payload);
      break;

    case 'folder.list':
      handleFolderList(mainWindow);
      break;

    case 'folder.create':
      handleFolderCreate(mainWindow, event.payload);
      break;

    case 'folder.update':
      handleFolderUpdate(mainWindow, event.payload);
      break;

    case 'folder.delete':
      handleFolderDelete(mainWindow, event.payload);
      break;

    case 'folder.move':
      handleFolderMove(mainWindow, event.payload);
      break;

    case 'session.setFolder':
      handleSessionSetFolder(mainWindow, event.payload);
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
    provider: row.provider || 'claude',
    todoState: row.todo_state || 'todo',
    pinned: row.pinned === 1,
    folderPath: row.folder_path || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  broadcast(mainWindow, {
    type: 'session.list',
    payload: { sessions: sessionInfos },
  });

  // 同时发送状态配置列表
  const statuses = statusConfig.listStatuses();
  broadcast(mainWindow, {
    type: 'status.list',
    payload: { statuses },
  });

  // 同时发送文件夹列表
  const folders = folderConfig.listFolders();
  broadcast(mainWindow, {
    type: 'folder.list',
    payload: { folders },
  });
}

// 新建会话
async function handleSessionStart(
  mainWindow: BrowserWindow,
  payload: SessionStartPayload
): Promise<void> {
  const { title, prompt, cwd, allowedTools, attachments, provider } = payload;
  const chosenProvider = provider || 'claude';
  if (isDev()) {
    console.log('[Session Start]', { provider: chosenProvider, cwd: cwd || undefined });
  }

  // 创建会话（用临时标题）
  const session = sessions.createSession({
    title,
    cwd,
    allowedTools,
    prompt,
    provider: chosenProvider,
  });

  // 更新状态为 running
  sessions.updateSessionStatus(session.id, 'running');

  // 立即广播状态 -> 界面跳转
  broadcast(mainWindow, {
    type: 'session.status',
    payload: {
      sessionId: session.id,
      status: 'running',
      title: session.title,
      cwd: session.cwd || undefined,
      provider: chosenProvider,
    },
  });

  if (chosenProvider === 'claude') {
    // 异步生成更好的标题（不阻塞）
    generateSessionTitle(prompt, cwd).then((newTitle) => {
      const trimmedTitle = newTitle.trim();
      if (!trimmedTitle) {
        return;
      }

      sessions.updateSessionTitle(session.id, trimmedTitle);
      const latest = sessions.getSession(session.id);
      const currentStatus = latest?.status || session.status || 'running';
      broadcast(mainWindow, {
        type: 'session.status',
        payload: {
          sessionId: session.id,
          status: currentStatus as SessionStatus,
          title: trimmedTitle,
        },
      });
    }).catch((err) => {
      console.error('Failed to generate title:', err);
    });
  }

  // 广播用户 prompt
  const createdAt = Date.now();
  broadcast(mainWindow, {
    type: 'stream.user_prompt',
    payload: { sessionId: session.id, prompt, attachments, createdAt },
  });

  // 保存 user_prompt 到消息历史
  sessions.addMessage(session.id, { type: 'user_prompt', prompt, attachments, createdAt });

  // 启动 Runner
  startRunner(mainWindow, session, prompt, undefined, attachments, chosenProvider);
}

// 继续会话
async function handleSessionContinue(
  mainWindow: BrowserWindow,
  payload: SessionContinuePayload
): Promise<void> {
  const { sessionId, prompt, attachments, provider } = payload;

  const session = sessions.getSession(sessionId);
  if (!session) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: 'Unknown session', sessionId },
    });
    return;
  }

  const existingEntry = runnerHandles.get(sessionId);
  const previousProvider = session.provider || 'claude';
  const nextProvider = provider || previousProvider;
  const providerChanged = nextProvider !== previousProvider;

  if (isDev()) {
    console.log('[Session Continue]', {
      sessionId,
      payloadProvider: provider,
      previousProvider,
      nextProvider,
      providerChanged,
      hasExistingRunner: !!existingEntry,
    });
  }

  if (providerChanged) {
    sessions.updateSessionProvider(sessionId, nextProvider);
  }

  // 更新状态
  sessions.updateSessionStatus(sessionId, 'running');
  sessions.updateLastPrompt(sessionId, prompt);

  // 广播状态
  broadcast(mainWindow, {
    type: 'session.status',
    payload: { sessionId, status: 'running', provider: nextProvider },
  });

  // 广播用户 prompt
  const createdAt = Date.now();
  broadcast(mainWindow, {
    type: 'stream.user_prompt',
    payload: { sessionId, prompt, attachments, createdAt },
  });

  // 保存 user_prompt
  sessions.addMessage(sessionId, { type: 'user_prompt', prompt, attachments, createdAt });

  if (existingEntry && !providerChanged && existingEntry.provider === nextProvider) {
    existingEntry.handle.send(prompt, attachments);
    return;
  }

  if (existingEntry && providerChanged) {
    existingEntry.handle.abort();
    runnerHandles.delete(sessionId);
  }

  // 启动 Runner（带 resume）
  const resumeSessionId =
    providerChanged
      ? undefined
      : nextProvider === 'claude'
        ? session.claude_session_id ?? undefined
        : session.codex_session_id ?? undefined;

  startRunner(mainWindow, session, prompt, resumeSessionId, attachments, nextProvider);
}

// 启动 Runner
function startRunner(
  mainWindow: BrowserWindow,
  session: ReturnType<typeof sessions.getSession>,
  prompt: string,
  resumeSessionId?: string,
  attachments?: Attachment[],
  providerOverride?: 'claude' | 'codex'
): void {
  if (!session) return;

  const sessionState = getSessionState(session.id);
  const provider = providerOverride || session.provider || 'claude';

  const runner = provider === 'codex' ? runCodex : runClaude;
  if (isDev()) {
    console.log('[Runner Select]', {
      sessionId: session.id,
      provider,
      runner: provider === 'codex' ? 'codex-acp' : 'claude-agent-sdk',
      cwd: session.cwd || process.cwd(),
      hasResume: !!resumeSessionId,
    });
  }

  const handle = runner({
    prompt,
    attachments,
    session,
    resumeSessionId,
    onMessage: (message) => {
      // 提取并保存 claude session id
      if (message.type === 'system' && message.subtype === 'init') {
        if (provider === 'codex') {
          sessions.updateCodexSessionId(session.id, message.session_id);
        } else {
          sessions.updateClaudeSessionId(session.id, message.session_id);
        }
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
        const status: SessionStatus = message.subtype === 'success' ? 'completed' : 'error';
        sessions.updateSessionStatus(session.id, status);
        broadcast(mainWindow, {
          type: 'session.status',
          payload: { sessionId: session.id, status, provider },
        });
      }
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Runner error:', error);

      sessions.updateSessionStatus(session.id, 'error');
      broadcast(mainWindow, {
        type: 'session.status',
        payload: { sessionId: session.id, status: 'error' },
      });
      broadcast(mainWindow, {
        type: 'runner.error',
        payload: { message, sessionId: session.id },
      });

      runnerHandles.delete(session.id);
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

  runnerHandles.set(session.id, { handle, provider });
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
  const entry = runnerHandles.get(sessionId);
  if (entry) {
    entry.handle.abort();
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
  const entry = runnerHandles.get(sessionId);
  if (entry) {
    entry.handle.abort();
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

// 获取 MCP 配置（返回全局和项目级分开）
function handleMcpGetConfig(mainWindow: BrowserWindow, projectPath?: string): void {
  const globalServers = getGlobalMcpServers();
  const projectServers = projectPath ? getProjectMcpServers(projectPath) : {};

  // 合并用于向后兼容
  const mergedServers = { ...globalServers, ...projectServers };

  broadcast(mainWindow, {
    type: 'mcp.config',
    payload: {
      servers: mergedServers,  // 向后兼容
      globalServers,
      projectServers,
    },
  });
}

// 保存 MCP 配置
function handleMcpSaveConfig(
  mainWindow: BrowserWindow,
  payload: {
    servers?: Record<string, McpServerConfig>;
    globalServers?: Record<string, McpServerConfig>;
    projectServers?: Record<string, McpServerConfig>;
    projectPath?: string;
  }
): void {
  // 保存全局配置
  if (payload.globalServers !== undefined) {
    saveMcpServers(payload.globalServers);
  } else if (payload.servers !== undefined) {
    // 向后兼容
    saveMcpServers(payload.servers);
  }

  // 保存项目级配置
  if (payload.projectPath && payload.projectServers !== undefined) {
    saveProjectMcpServers(payload.projectPath, payload.projectServers);
  }

  // 返回更新后的配置
  const globalServers = getGlobalMcpServers();
  const projectServers = payload.projectPath ? getProjectMcpServers(payload.projectPath) : {};

  broadcast(mainWindow, {
    type: 'mcp.config',
    payload: {
      servers: globalServers,
      globalServers,
      projectServers,
    },
  });
}

// 设置会话 TodoState
function handleSessionSetTodoState(
  mainWindow: BrowserWindow,
  payload: { sessionId: string; todoState: TodoState }
): void {
  sessions.updateSessionTodoState(payload.sessionId, payload.todoState);
  broadcast(mainWindow, {
    type: 'session.todoStateChanged',
    payload: { sessionId: payload.sessionId, todoState: payload.todoState },
  });
}

// 切换会话置顶状态
function handleSessionTogglePin(
  mainWindow: BrowserWindow,
  payload: { sessionId: string }
): void {
  const newPinned = sessions.toggleSessionPinned(payload.sessionId);
  broadcast(mainWindow, {
    type: 'session.pinned',
    payload: { sessionId: payload.sessionId, pinned: newPinned },
  });
}

// 状态列表
function handleStatusList(mainWindow: BrowserWindow): void {
  const statuses = statusConfig.listStatuses();
  broadcast(mainWindow, {
    type: 'status.list',
    payload: { statuses },
  });
}

// 创建状态
function handleStatusCreate(
  mainWindow: BrowserWindow,
  payload: CreateStatusInput
): void {
  statusConfig.createStatus(payload);
  broadcastStatusChanged(mainWindow);
}

// 更新状态
function handleStatusUpdate(
  mainWindow: BrowserWindow,
  payload: { id: string; updates: UpdateStatusInput }
): void {
  statusConfig.updateStatus(payload.id, payload.updates);
  broadcastStatusChanged(mainWindow);
}

// 删除状态
function handleStatusDelete(
  mainWindow: BrowserWindow,
  payload: { id: string }
): void {
  statusConfig.deleteStatus(payload.id);
  broadcastStatusChanged(mainWindow);
}

// 重排序状态
function handleStatusReorder(
  mainWindow: BrowserWindow,
  payload: { orderedIds: string[] }
): void {
  statusConfig.reorderStatuses(payload.orderedIds);
  broadcastStatusChanged(mainWindow);
}

// 广播状态变更
function broadcastStatusChanged(mainWindow: BrowserWindow): void {
  const statuses = statusConfig.listStatuses();
  broadcast(mainWindow, {
    type: 'status.changed',
    payload: { statuses },
  });
}

// 文件夹列表
function handleFolderList(mainWindow: BrowserWindow): void {
  const folders = folderConfig.listFolders();
  broadcast(mainWindow, {
    type: 'folder.list',
    payload: { folders },
  });
}

// 创建文件夹
function handleFolderCreate(
  mainWindow: BrowserWindow,
  payload: { path: string; displayName?: string }
): void {
  try {
    folderConfig.createFolder(payload.path, payload.displayName);
    broadcastFolderChanged(mainWindow);
  } catch (error) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: `Failed to create folder: ${String(error)}` },
    });
  }
}

// 更新文件夹
function handleFolderUpdate(
  mainWindow: BrowserWindow,
  payload: { path: string; updates: Partial<FolderConfig> }
): void {
  try {
    folderConfig.updateFolder(payload.path, payload.updates);
    broadcastFolderChanged(mainWindow);
  } catch (error) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: `Failed to update folder: ${String(error)}` },
    });
  }
}

// 删除文件夹
function handleFolderDelete(
  mainWindow: BrowserWindow,
  payload: { path: string }
): void {
  try {
    folderConfig.deleteFolder(payload.path);
    // 清除该文件夹下所有 session 的文件夹路径
    sessions.clearSessionsFolderPath(payload.path);
    broadcastFolderChanged(mainWindow);
    // 重新发送 session 列表以更新 folderPath
    handleSessionList(mainWindow);
  } catch (error) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: `Failed to delete folder: ${String(error)}` },
    });
  }
}

// 移动/重命名文件夹
function handleFolderMove(
  mainWindow: BrowserWindow,
  payload: { oldPath: string; newPath: string }
): void {
  try {
    const { oldPaths, newPaths } = folderConfig.moveFolder(payload.oldPath, payload.newPath);
    // 更新 session 的文件夹路径
    for (let i = 0; i < oldPaths.length; i++) {
      sessions.updateSessionsInFolder(oldPaths[i], newPaths[i]);
    }
    broadcastFolderChanged(mainWindow);
    // 重新发送 session 列表以更新 folderPath
    handleSessionList(mainWindow);
  } catch (error) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: `Failed to move folder: ${String(error)}` },
    });
  }
}

// 设置 session 文件夹
function handleSessionSetFolder(
  mainWindow: BrowserWindow,
  payload: { sessionId: string; folderPath: string | null }
): void {
  try {
    // 如果设置了文件夹路径，确保文件夹存在
    if (payload.folderPath) {
      folderConfig.ensureFolderExists(payload.folderPath);
    }
    sessions.updateSessionFolderPath(payload.sessionId, payload.folderPath);
    broadcast(mainWindow, {
      type: 'session.folderChanged',
      payload: { sessionId: payload.sessionId, folderPath: payload.folderPath },
    });
    // 如果创建了新文件夹，广播文件夹变更
    if (payload.folderPath) {
      broadcastFolderChanged(mainWindow);
    }
  } catch (error) {
    broadcast(mainWindow, {
      type: 'runner.error',
      payload: { message: `Failed to set session folder: ${String(error)}` },
    });
  }
}

// 广播文件夹变更
function broadcastFolderChanged(mainWindow: BrowserWindow): void {
  const folders = folderConfig.listFolders();
  broadcast(mainWindow, {
    type: 'folder.changed',
    payload: { folders },
  });
}

// 清理资源
export function cleanup(): void {
  // 停止所有运行中的 runner
  for (const [, entry] of runnerHandles) {
    entry.handle.abort();
  }
  runnerHandles.clear();
  sessionStates.clear();

  // 关闭数据库
  sessions.close();
}
